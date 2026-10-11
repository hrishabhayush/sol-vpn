/// <reference types="vite/client" />
import { invoke } from "@tauri-apps/api/core";
import * as ledger from "./ledger";

type Attested = { tee: string; wg_pubkey: string; endpoint: string; node_id: number; measurement: string; tcb_status: string };
type Session = { session_id: string; client_ip: string; dns: string; expires_at: number };
type Step = "" | "ok" | "fail"; // pending | passed | failed

const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = (id: string) => document.getElementById(id)!;
const on = (id: string, f: () => unknown) => document.getElementById(id)?.addEventListener("click", f);

let nodes: ledger.Node[] = [];
let picked = 0;
let minutesLeft = 0;
let error = "";
let attempt = 0; // bumped by Cancel; a stale connect() drops its result
const verified = new Set<number>(); // node ids that passed attestation this launch
let conn: { node: ledger.Node; att: Attested; session: Session; started: number; paid: number; timers: number[] } | null = null;

// Icons from the Figma file (stroke = currentColor). [viewBox size, inner svg]
const ICONS: Record<string, [number, string]> = {
  power: [18, `<path d="M9 2.25V8.25"/><path d="M5.25 4.875A6.6 6.6 0 1 0 12.75 4.875"/>`],
  x: [12, `<path d="M3 3L9 9M9 3L3 9"/>`],
  check: [12, `<path d="M2.5 6.25L5 8.5L9.5 3.5"/>`],
  home: [18, `<path d="M3 8.25L9 3L15 8.25V15H11.25V10.5H6.75V15H3V8.25Z"/>`],
  globe: [18, `<circle cx="9" cy="9" r="6.75"/><path d="M2.25 9H15.75"/><path d="M9 2.25C6.375 5.25 6.375 12.75 9 15.75C11.625 12.75 11.625 5.25 9 2.25Z"/>`],
  wallet: [18, `<rect x="2.25" y="4.5" width="13.5" height="9.75" rx="2.25"/><path d="M11.25 8.25H15.75V11.25H11.25A1.5 1.5 0 0 1 11.25 8.25Z"/>`],
  chevL: [18, `<path d="M11.25 3.75L6 9L11.25 14.25"/>`],
  shield: [24, `<path d="M12 3L19 6V11C19 16 15.5 19.5 12 21C8.5 19.5 5 16 5 11V6L12 3Z"/><path d="M9 12L11 14L15 10"/>`],
  bolt: [11, `<path d="M5.958 0.917L1.833 6.417H5.042L4.583 10.083L9.167 4.125H5.958V0.917Z" fill="currentColor" stroke="none"/>`],
  copy: [15, `<rect x="5" y="5" width="7.5" height="7.5" rx="1.875"/><path d="M10 5V3.75C10 3.06 9.44 2.5 8.75 2.5H3.75C3.06 2.5 2.5 3.06 2.5 3.75V8.75C2.5 9.44 3.06 10 3.75 10H5"/>`],
};
const icon = (name: string, size: number, sw = 1.5) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${ICONS[name][0]} ${ICONS[name][0]}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name][1]}</svg>`;

// Wraps "Swirl" mark (Logo page, direction A).
const SWIRL = "M2.567 12.1C2.567 9.863 3.455 7.718 5.037 6.137C6.618 4.555 8.763 3.667 11 3.667C13.237 3.667 15.382 4.555 16.963 6.137C18.545 7.718 19.433 9.863 19.433 12.1C19.433 13.753 18.777 15.339 17.608 16.508C16.439 17.677 14.853 18.333 13.2 18.333C11.547 18.333 9.961 17.677 8.792 16.508C7.623 15.339 6.967 13.753 6.967 12.1C6.967 11.03 7.392 10.004 8.148 9.248C8.904 8.492 9.93 8.067 11 8.067C12.07 8.067 13.096 8.492 13.852 9.248C14.608 10.004 15.033 11.03 15.033 12.1";
const mark = (size: number, white = false) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 22 22" fill="none"><defs><linearGradient id="wm${white ? "w" : ""}" x1="1.8" y1="2.9" x2="20.2" y2="21.3" gradientUnits="userSpaceOnUse">${
    white ? `<stop stop-color="#fff"/><stop offset="1" stop-color="#dbe8ff"/>` : `<stop stop-color="#8fd3ff"/><stop offset=".5" stop-color="#4f7cf0"/><stop offset="1" stop-color="#6b5cf6"/>`
  }</linearGradient></defs><path d="${SWIRL}" stroke="url(#wm${white ? "w" : ""})" stroke-width="2.93" stroke-linecap="round"/></svg>`;

const TEE = (t: string) => ({ tdx: "Intel TDX", "sev-snp": "AMD SEV-SNP", mock: "Mock TEE" })[t] ?? t;
const money = (minutes: number) => `$${(minutes / 100).toFixed(2)}`;
const clock = (s: number) => [s / 3600, (s / 60) % 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");

function render(html: string) {
  app.innerHTML = html;
}

const header = (left = minutesLeft) => `
  <div class="header">
    <div class="brand">${mark(22, true)}Wraps</div>
    <div class="pill"><span class="dot"></span>${left} min left · ${money(left)}</div>
  </div>`;

// Hero screens: blue band, light sheet starting at `sheet` px, power button of core size `core` notched into its edge.
const hero = (sheet: number, core: number, orb: string, body: string, band = "") => `
  <main class="hero" style="--sheet:${sheet}px;--r:${core / 2 + 14}px;--c:${core}px">
    <div class="sheet"></div>
    ${header(conn ? Math.max(0, minutesLeft - conn.paid) : minutesLeft)}${band}
    ${orb}
    <div class="body">${body}</div>
  </main>`;
const orb = (kind: "" | "busy" | "fail", core: number, label: string) =>
  `<button id="orb" class="orb ${kind}" aria-label="${label}">${kind === "fail" ? icon("x", core * 0.36, 2.2) : icon("power", core * 0.4, 2)}</button>`;

const nav = (active: "home" | "servers" | "topup") => {
  const tab = (id: string, ic: string, text: string) =>
    `<button id="tab-${id}" class="${id === active ? "on" : ""}" aria-label="${text}">${icon(ic, 18)}${id === active ? `<span>${text}</span>` : ""}</button>`;
  return `<div class="nav end">${tab("home", "home", "Home")}${tab("servers", "globe", "Servers")}${tab("topup", "wallet", "Top up")}</div>`;
};
const wireNav = () => {
  on("tab-home", showDisconnected);
  on("tab-servers", showServers);
  on("tab-topup", showTopUp);
};

// Checklist rows; the "Code hash" row is honest about mock nodes, where attest.rs skips the measurement check.
const stepLabels = (tee: string) => [
  tee === "sev-snp" ? "Hardware report signed by AMD" : tee === "mock" ? "Mock quote (debug build)" : "Hardware quote signed by Intel",
  tee === "mock" ? "Code hash (not checked for mock)" : "Code hash matches registry",
  "Key bound to this session",
  "Encrypted tunnel open",
];
const steps = (tee: string, states: Step[], n = 4) =>
  stepLabels(tee)
    .slice(0, n)
    .map(
      (l, i) =>
        `<div class="step" id="step${i}" data-s="${states[i] ?? ""}"><span class="box" style="transition-delay:${i * 150}ms">${
          states[i] === "fail" ? icon("x", 10, 1.8) : icon("check", 12, 1.8)
        }</span>${l}</div>`,
    )
    .join("");
const setStep = (i: number, s: Step) => document.getElementById(`step${i}`)?.setAttribute("data-s", s);

// Maps an attestation error to the step it failed (attest.rs order: quote -> key binding -> measurement;
// the node id / tee registry checks in connect() count as "matches registry").
function failedSteps(e: string): Step[] {
  if (/report_data/.test(e)) return ["ok", "", "fail"];
  if (/measurement mismatch|registry/.test(e)) return ["ok", "fail", "ok"];
  return ["fail", "", ""];
}

const serverCard = (n: ledger.Node | undefined, live: boolean, stats: [string, string, string][], meta: string) =>
  n
    ? `<button class="server" id="server">
        ${live ? `<span class="status"><span class="live"></span></span>` : ""}
        <div class="col" style="gap:3px">
          <p class="country">Node #${n.id}</p>
          <div class="row meta">${verified.has(n.id) ? `<span class="badge">${icon("check", 10, 1.6)}Verified</span>` : ""}${esc(meta)}</div>
        </div>
        <div class="divider"></div>
        <div class="stats">${stats.map(([ic, k, v]) => `<div class="row" style="gap:8px"><span class="stat-ico">${icon(ic, 14)}</span><div class="col"><span class="k">${k}</span><span class="v">${esc(v)}</span></div></div>`).join("")}</div>
      </button>`
    : `<div class="server"><p class="country">No nodes</p><p class="meta">NodeRegistry is empty</p></div>`;

async function showDisconnected() {
  [nodes, minutesLeft] = await Promise.all([ledger.listNodes(), ledger.minutesLeft()]);
  home();
}

function home() {
  const node = nodes.find((n) => n.id === picked) ?? nodes[0];
  if (node) picked = node.id;
  render(
    hero(
      150,
      112,
      orb("", 112, "Connect"),
      `<div class="center" style="margin-top:4px">
        <p class="title">Not connected</p>
        ${error ? `<p class="err">${esc(error)}</p>` : `<p class="muted">Tap to verify the server and connect</p>`}
      </div>
      ${serverCard(node, false, [["shield", "Enclave", node ? TEE(node.tee) : ""], ["wallet", "Rate", "$0.01/min"]], node?.name ?? "")}
      ${nav("home")}`,
    ),
  );
  if (node) on("orb", connect);
  on("server", showServers);
  wireNav();
}

function showServers() {
  render(`
    <main>
      <div class="row" style="gap:12px"><button class="icon-btn glass" id="back">${icon("chevL", 18)}</button><p class="h1">Select server</p></div>
      <div class="list">${
        nodes
          .map(
            (n) => `
        <div class="srv ${n.id === picked ? "on" : ""}" data-id="${n.id}">
          <span class="tee">${esc(n.tee === "sev-snp" ? "SNP" : n.tee.toUpperCase())}</span>
          <div class="col" style="flex:1;gap:3px">
            <div class="row"><span class="name">Node #${n.id}</span>${verified.has(n.id) ? `<span class="badge">${icon("check", 10, 1.6)}Verified</span>` : ""}</div>
            <div class="row muted" style="font-size:12px;gap:4px"><span style="color:var(--blue)">${icon("bolt", 11)}</span>${esc(TEE(n.tee))}  ·  ${esc(n.name)}</div>
          </div>
          <button class="go" aria-label="Connect to node ${n.id}">${icon("power", 16)}</button>
        </div>`,
          )
          .join("") || `<p class="muted">No nodes in NodeRegistry.</p>`
      }</div>
      ${nav("servers")}
    </main>`);
  on("back", showDisconnected);
  wireNav();
  document.querySelectorAll<HTMLElement>(".srv").forEach((el) => {
    el.onclick = (e) => {
      picked = Number(el.dataset.id);
      error = "";
      (e.target as HTMLElement).closest(".go") ? connect() : home();
    };
  });
}

function verifying(node: ledger.Node) {
  render(
    hero(
      120,
      92,
      orb("busy", 92, "Verifying"),
      `<div class="center">
        <p class="title">Verifying server…</p>
        <p class="muted">Node #${node.id} · checking attestation</p>
      </div>
      <div class="steps glass"><p class="label">ATTESTATION</p>${steps(node.tee, [])}</div>
      <button class="btn white end" id="cancel">Cancel</button>`,
    ),
  );
}

async function connect() {
  const node = nodes.find((n) => n.id === picked);
  if (!node) return;
  const me = ++attempt;
  error = "";
  verifying(node);
  on("cancel", () => {
    attempt++;
    showDisconnected();
  });
  let att: Attested;
  try {
    att = await invoke<Attested>("verify_attestation", { nodeUrl: node.url, expectedMeasurement: node.expectedMeasurement });
    if (att.node_id !== node.id) throw `node claims id ${att.node_id}, registry entry is ${node.id}`;
    if (att.tee !== node.tee) throw `node attested as ${att.tee}, registry says ${node.tee}`;
  } catch (e) {
    verified.delete(node.id);
    if (me === attempt) refused(node, String(e));
    return;
  }
  if (me !== attempt) return;
  verified.add(node.id);
  [0, 1, 2].forEach((i) => setStep(i, "ok"));
  try {
    if (minutesLeft < 1) throw "no minutes left: top up first";
    const reserve = await ledger.makeReserveInput(Math.min(minutesLeft, 60));
    const session = await invoke<Session>("connect", { nodeUrl: node.url, serverPubkey: att.wg_pubkey, endpoint: att.endpoint, reserve });
    if (me !== attempt) return void (await invoke("disconnect").catch(() => {})); // cancelled while the tunnel came up
    conn = { node, att, session, started: Date.now(), paid: 0, timers: [] };
    await payMinute(); // pay the first minute up front, then one voucher every 60 s
    setStep(3, "ok");
    await new Promise((r) => setTimeout(r, 450)); // let the last box fill
    conn.timers.push(window.setInterval(payMinute, 60_000), window.setInterval(showConnected, 1000));
    showConnected();
  } catch (e) {
    error = String(e);
    await disconnect();
  }
}

function refused(node: ledger.Node, reason: string) {
  render(
    hero(
      120,
      84,
      orb("fail", 84, "Verification failed"),
      `<div class="center">
        <p class="title">Not connected</p>
        <p class="err" style="font-size:14px">This server failed verification</p>
      </div>
      <div class="steps glass" style="gap:9px;padding:14px">
        <p class="label">REASON</p>
        <p class="reason">${esc(reason)}. No traffic was sent and no minutes were charged.</p>
        ${steps(node.tee, failedSteps(reason), 3)}
      </div>
      <button class="btn white end" id="other"><span style="color:var(--blue)">${icon("globe", 18)}</span>Choose another server</button>`,
    ),
  );
  on("other", showServers);
}

async function payMinute() {
  if (!conn) return;
  const c = conn;
  const minutes = usedMinutes(c);
  try {
    const { voucher, counter } = await ledger.makeVoucher(c.node.id, minutes);
    await invoke("send_voucher", { nodeUrl: c.node.url, sessionId: c.session.session_id, voucher, minutes, counter });
    if (minutes > c.paid) await ledger.spend(minutes - c.paid);
    c.paid = Math.max(c.paid, minutes);
  } catch (e) {
    error = `voucher failed: ${e}`;
    // 402 underpaid / reserve exhausted, 404 session ended: the node already dropped us.
    if (/\b(402|404)\b/.test(String(e)) && conn === c) await disconnect();
  }
}

// Protocol: minutes = elapsed whole minutes + 1 (pay for the minute in progress).
const usedMinutes = (c: NonNullable<typeof conn>) => Math.floor((Date.now() - c.started) / 60_000) + 1;

function showConnected() {
  if (!conn) return;
  const c = conn;
  const used = usedMinutes(c);
  render(
    hero(
      196,
      76,
      orb("", 76, "Disconnect"),
      `${serverCard(c.node, true, [["bolt", "Minutes used", `${used} min`], ["wallet", "Cost so far", money(used)]], `${TEE(c.att.tee)} · ${c.session.client_ip}`)}
      ${error ? `<p class="err" style="font-size:12px">${esc(error)}</p>` : ""}
      <button class="btn white end" id="disconnect"><span style="color:var(--red)">${icon("power", 18)}</span>Disconnect</button>`,
      `<div class="band-text"><p>Connection is secure · Attested</p><p class="timer">${clock((Date.now() - c.started) / 1000)}</p></div>`,
    ),
  );
  on("disconnect", disconnect);
  on("orb", disconnect);
}

async function disconnect() {
  conn?.timers.forEach(clearInterval);
  conn = null;
  try {
    await invoke("disconnect");
  } catch (e) {
    error = String(e);
  }
  await showDisconnected();
}

let amount = 5; // top-up amount in tokens (1 token = 100 minutes)

function showTopUp() {
  render(`
    <main>
      <div class="row" style="gap:12px">
        <button class="icon-btn glass" id="back">${icon("chevL", 18)}</button>
        <div class="col"><p class="h1">Top up</p><p class="muted" style="font-size:12px">USDC (devnet test mint) · $0.01 per minute</p></div>
      </div>
      <div class="amounts">${[1, 5, 20].map((a) => `<button data-a="${a}" class="${a === amount ? "on" : ""}"><b>$${a}</b><small>${(a * 100).toLocaleString("en-US")} min</small></button>`).join("")}</div>
      <div class="qrcard">
        <div class="qr" id="qr"></div>
        <p style="font-size:16px;font-weight:600;letter-spacing:-0.16px">Scan with Phantom</p>
        <button class="addr" id="addr" title="Copy address"><span id="address">…</span>${icon("copy", 15, 1.25)}</button>
        <p class="note" id="bal">&nbsp;</p>
      </div>
      <p class="note end" id="msg" style="color:var(--sub)">Deposit moves tokens from this wallet into your private balance (~1 min).</p>
      <button class="btn primary" id="deposit">Deposit $${amount} · ${amount * 100} min</button>
    </main>`);
  on("back", showDisconnected);
  document.querySelectorAll<HTMLElement>(".amounts button").forEach((b) => (b.onclick = () => ((amount = Number(b.dataset.a)), showTopUp())));
  const msg = (t: string, err = false) => {
    $("msg").textContent = t;
    $("msg").className = `note end${err ? " err" : ""}`;
  };
  let address = "";
  on("addr", () => address && navigator.clipboard.writeText(address).then(() => msg("Address copied.")));
  const showWallet = () =>
    ledger.wallet().then(
      (w) => {
        address = w.address;
        $("address").textContent = `${w.address.slice(0, 4)}…${w.address.slice(-5)}`;
        $("bal").textContent = `${w.sol} SOL (fees) · ${w.tokens} test tokens`;
      },
      (e) => msg(String(e), true),
    );
  showWallet();
  invoke<{ url: string; svg: string }>("topup", { amountUsdc: String(amount), mint: ledger.MINT }).then(
    (t) => ($("qr").innerHTML = `${t.svg}<span class="mark">${mark(26)}</span>`),
    (e) => msg(String(e), true),
  );
  // Moves tokens from the app wallet into the encrypted ledger slot (1 token = 100 minutes).
  on("deposit", async () => {
    ($("deposit") as HTMLButtonElement).disabled = true;
    msg("Depositing… (MPC, can take a minute)");
    try {
      minutesLeft = await ledger.deposit(BigInt(amount) * 1_000_000n);
      msg(`Deposited. Minutes left: ${minutesLeft}`);
      showWallet();
    } catch (e) {
      msg(String(e), true);
    }
    ($("deposit") as HTMLButtonElement).disabled = false;
  });
}

// Dev-only: render a state without Tauri/devnet, e.g. http://localhost:1420/?state=connected
const preview = import.meta.env.DEV && new URLSearchParams(location.search).get("state");
if (preview) {
  const tee = new URLSearchParams(location.search).get("tee") ?? "tdx";
  nodes = [0, 1, 2].map((id) => ({ id, name: `34.172.3.${92 + id}`, url: "", tee: id ? "sev-snp" : tee, expectedMeasurement: "" }));
  minutesLeft = 118;
  verified.add(0);
  const att = { tee, wg_pubkey: "", endpoint: "", node_id: 0, measurement: "", tcb_status: "" };
  const go: Record<string, () => void> = {
    home,
    servers: showServers,
    verifying: () => (verifying(nodes[0]), setTimeout(() => [0, 1, 2].forEach((i) => setStep(i, "ok")), 600)),
    refused: () => refused(nodes[0], `measurement mismatch: node runs 9f3a…, registry expects d83a…`),
    connected: () => {
      conn = { node: nodes[0], att, session: { session_id: "", client_ip: "10.8.0.2/32", dns: "10.8.0.1", expires_at: 0 }, started: Date.now() - 252_000, paid: 4, timers: [] };
      showConnected();
    },
    topup: showTopUp,
  };
  go[preview]();
} else {
  showDisconnected().catch((e) => render(`<main><p class="err">${esc(String(e))}</p></main>`));
}
