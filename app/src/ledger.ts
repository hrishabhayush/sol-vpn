// App side of the Arcium ledger (ledger/client on devnet, config in ledger/devnet.json).
// Txs are signed in Rust (`sign`); only encryption happens here.
import "./node-shim";
import { AnchorProvider } from "@anchor-lang/core";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { invoke } from "@tauri-apps/api/core";
import * as client from "../../ledger/client/index.ts";
import devnet from "../../ledger/devnet.json";

export type Node = { id: number; name: string; url: string; tee: string; expectedMeasurement: string };
export const MINT = devnet.mint;

// Balances are encrypted on-chain, so the app tracks its own slot, voucher counter and minutes.
type State = { slot: number; counter: number; minutes: number };
let state: State | null | undefined;
const loadState = async () =>
  state !== undefined ? state : (state = JSON.parse((await invoke<string | null>("load_state")) ?? "null") as State | null);
async function saveState(s: State) {
  await invoke("save_state", { state: JSON.stringify(s) });
  state = s;
}

let ctx: Promise<{ program: ReturnType<typeof client.ledgerProgram>; owner: PublicKey; secret: bigint }> | undefined;
const getCtx = () =>
  (ctx ??= (async () => {
    const owner = new PublicKey(await invoke<string>("wallet_address"));
    const sign = async <T extends Transaction | VersionedTransaction>(tx: T) => {
      const msg = tx instanceof VersionedTransaction ? tx.message.serialize() : tx.serializeMessage();
      tx.addSignature(owner, Buffer.from(await invoke<number[]>("sign", { msg: Array.from(msg) })));
      return tx;
    };
    const wallet = {
      publicKey: owner,
      signTransaction: sign,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
        for (const t of txs) await sign(t);
        return txs;
      },
    };
    const conn = new Connection(devnet.rpc, "confirmed");
    const program = client.ledgerProgram(new AnchorProvider(conn, wallet as any, { commitment: "confirmed" }));
    // Ledger secret is a nonzero u64: the first 8 bytes of the 32-byte slot secret from the Keychain item.
    const secret = BigInt("0x" + (await invoke<string>("slot_secret")).slice(0, 16)) || 1n;
    return { program, owner, secret };
  })());
let mxeKey: Promise<Uint8Array> | undefined;
const getMxeKey = async () => (mxeKey ??= client.getMxeKey((await getCtx()).program));

/** NodeRegistry accounts. */
export async function listNodes(): Promise<Node[]> {
  const { program } = await getCtx();
  const all = await program.account.node.all();
  return all
    .map(({ account: a }) => ({
      id: a.id,
      name: a.endpoint,
      url: `http://${a.endpoint}:8443`,
      tee: ["mock", "tdx", "sev-snp"][a.tee] ?? `unknown(${a.tee})`,
      expectedMeasurement: Array.from(a.expectedMeasurement, (b) => b.toString(16).padStart(2, "0")).join(""),
    }))
    .sort((a, b) => a.id - b.id);
}

/** Prepaid minutes, tracked locally (deposits minus paid vouchers). */
export async function minutesLeft(): Promise<number> {
  return (await loadState())?.minutes ?? 0;
}

/** Wallet address, SOL (for fees) and test-token balance, for the top-up screen. */
export async function wallet() {
  const { program, owner } = await getCtx();
  const conn = program.provider.connection;
  const ata = getAssociatedTokenAddressSync(new PublicKey(MINT), owner);
  const [lamports, tokens] = await Promise.all([
    conn.getBalance(owner),
    conn.getTokenAccountBalance(ata).then((b) => b.value.uiAmountString ?? "0", () => "0"),
  ]);
  return { address: owner.toBase58(), sol: lamports / 1e9, tokens };
}

/** Deposits `amount` token base units (multiple of 10_000) from the app wallet into our slot. */
export async function deposit(amount: bigint): Promise<number> {
  const { program, owner, secret } = await getCtx();
  const ata = getAssociatedTokenAddressSync(new PublicKey(MINT), owner);
  const s = await loadState();
  // First deposit: random slot, retry another on ok=false (slot owned by another secret; deposit refunded).
  const tried = new Set<number>();
  for (;;) {
    const slot = s?.slot ?? randomSlot(tried);
    const r = await client.deposit(program, ata, amount, slot, secret);
    if (r.ok) {
      const minutes = (s?.minutes ?? 0) + Number(amount / client.PRICE_PER_MINUTE);
      await saveState({ slot, counter: s?.counter ?? 0, minutes });
      return minutes;
    }
    if (s) throw new Error(`deposit refused for our slot ${slot} (tx ${r.sig})`);
    tried.add(slot);
  }
}

function randomSlot(tried: Set<number>) {
  const free = [...Array(client.SLOTS).keys()].filter((i) => !tried.has(i));
  if (!free.length) throw new Error("all ledger slots are taken");
  return free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];
}

async function mustState() {
  const s = await loadState();
  if (!s) throw new Error("no deposit yet: top up first");
  return s;
}

/** Arcium-encrypted {slot, secret, minutes} for POST /session; the node submits the reserve. */
export async function makeReserveInput(minutes: number): Promise<string> {
  const { secret } = await getCtx();
  const { slot } = await mustState();
  return client.makeReserveInput(await getMxeKey(), { slot, secret, minutes });
}

/** Arcium-encrypted voucher. The counter is persisted before use so it strictly increases for the slot's lifetime. */
export async function makeVoucher(nodeId: number, totalMinutes: number): Promise<{ voucher: string; counter: number }> {
  const { secret } = await getCtx();
  const s = await mustState();
  const counter = s.counter + 1;
  await saveState({ ...s, counter });
  return { voucher: client.makeVoucher(await getMxeKey(), { slot: s.slot, secret, totalMinutes, counter, nodeId }), counter };
}

/** Deducts minutes the node accepted a voucher for. */
export async function spend(minutes: number) {
  const s = await mustState();
  await saveState({ ...s, minutes: Math.max(0, s.minutes - minutes) });
}
