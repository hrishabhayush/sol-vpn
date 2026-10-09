import { invoke } from "@tauri-apps/api/core";
import * as ledger from "./ledger";

type Attested = { tee: string; wg_pubkey: string; endpoint: string; node_id: number; measurement: string; tcb_status: string };
type Session = { session_id: string; client_ip: string; dns: string; expires_at: number };

const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

let nodes: ledger.Node[] = [];
let picked = 0;
let minutesLeft = 0;
let error = "";
let conn: { node: ledger.Node; session: Session; started: number; counter: number; timers: number[] } | null = null;

function render(html: string) {
  app.innerHTML = html;
}

async function showDisconnected() {
  const secret = await invoke<string>("slot_secret");
  [nodes, minutesLeft] = await Promise.all([ledger.listNodes(), ledger.minutesLeft(secret)]);
  
  render(`
    <h3>Disconnected</h3>
    <select id="node">${nodes.map((n) => `<option value="${n.id}" ${n.id === picked ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select>
    <button id="connect">Connect</button>
    <p>Minutes left: ${minutesLeft}</p>
    <button id="topup">Top up</button>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}`);
  document.getElementById("node")!.onchange = (e) => (picked = Number((e.target as HTMLSelectElement).value));
  document.getElementById("connect")!.onclick = connect;
  document.getElementById("topup")!.onclick = showTopUp;
}

async function connect() {
  const node = nodes.find((n) => n.id === picked)!;
  error = "";
  render(`<h3>Verifying attestation…</h3><p class="small">${esc(node.name)}</p>`);
  let att: Attested;
  try {
    att = await invoke<Attested>("verify_attestation", { nodeUrl: node.url, expectedMeasurement: node.expectedMeasurement });
    if (att.node_id !== node.id) throw `node claims id ${att.node_id}, registry entry is ${node.id}`;
  } catch (e) {
    render(`<h3>Refused</h3><p>This node failed attestation.</p><p class="err">${esc(String(e))}</p><button id="back">Back</button>`);
    document.getElementById("back")!.onclick = showDisconnected;
    return;
  }
  try {
    const secret = await invoke<string>("slot_secret");
    const reserveTx = await ledger.reserve(secret, node.id, Math.min(minutesLeft, 60));
    const session = await invoke<Session>("connect", { nodeUrl: node.url, serverPubkey: att.wg_pubkey, endpoint: att.endpoint, reserveTx });
    conn = { node, session, started: Date.now(), counter: 0, timers: [] };
    await payMinute(); // pay the first minute up front, then one voucher every 60 s
    conn.timers.push(window.setInterval(payMinute, 60_000), window.setInterval(showConnected, 1000));
    showConnected();
  } catch (e) {
    error = String(e);
    await disconnect();
  }
}

async function payMinute() {
  if (!conn) return;
  const c = conn;
  const minutes = usedMinutes(c);
  const counter = ++c.counter;
  try {
    const secret = await invoke<string>("slot_secret");
    const voucher = await ledger.makeVoucher(secret, c.node.id, minutes, counter);
    await invoke("send_voucher", { nodeUrl: c.node.url, sessionId: c.session.session_id, voucher, minutes, counter });
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
  const s = Math.floor((Date.now() - conn.started) / 1000);
  render(`
    <h3>Connected</h3>
    <p>${esc(conn.node.name)}<br><span class="small">${esc(conn.session.client_ip)}</span></p>
    <p>Elapsed: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</p>
    <p>Minutes used: ${usedMinutes(conn)}</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <button id="disconnect">Disconnect</button>`);
  document.getElementById("disconnect")!.onclick = disconnect;
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

async function showTopUp() {
  render(`
    <h3>Top up</h3>
    <input id="amount" value="1" inputmode="decimal"> <button id="gen">Show QR (USDC)</button>
    <div id="qr"></div>
    <button id="back">Back</button>`);
  document.getElementById("back")!.onclick = showDisconnected;
  document.getElementById("gen")!.onclick = async () => {
    const amountUsdc = (document.getElementById("amount") as HTMLInputElement).value.trim();
    const qr = document.getElementById("qr")!;
    try {
      const t = await invoke<{ url: string; svg: string }>("topup", { amountUsdc });
      qr.innerHTML = `${t.svg}<p class="small">${esc(t.url)}</p>`;
    } catch (e) {
      qr.innerHTML = `<p class="err">${esc(String(e))}</p>`;
    }
  };
}

showDisconnected().catch((e) => render(`<p class="err">${esc(String(e))}</p>`));
