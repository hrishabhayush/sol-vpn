// Devnet end-to-end with tiny amounts: deposit -> submitReserve (node) -> redeem -> settle -> claim. Prints MPC timings.
// Usage: node scripts/smoke-devnet.ts   (needs devnet.json; admin wallet funds a throwaway user)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import anchor from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import * as L from "../client/index.ts";
import devnet from "../devnet.json" with { type: "json" };

const load = (p: string | URL) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const conn = new Connection(devnet.rpc, "confirmed");
const admin = load(`${homedir()}/.config/solana/id.json`);
const nodeKp = load(new URL("../../node/node-keypair.json", import.meta.url));
const as = (kp: Keypair) => L.ledgerProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
const t = async <T>(label: string, f: () => Promise<T>) => {
  const s = Date.now();
  const r = await f();
  console.log(`${label}: ${(Date.now() - s) / 1000}s`, r);
  return r;
};
const mint = new PublicKey(devnet.mint);
const nodeId = devnet.nodes[0].id;

const user = Keypair.generate();
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })), [admin]);
const userToken = (await getOrCreateAssociatedTokenAccount(conn, admin, mint, user.publicKey)).address;
await mintTo(conn, admin, mint, userToken, admin, 50_000); // 5 minutes
const nodeToken = new PublicKey(devnet.nodes[0].payoutToken);
const before = (await getAccount(conn, nodeToken)).amount;

const mxeKey = await L.getMxeKey(as(admin));
const secret = L.newSecret();
let slot = -1;
for (const s of [...Array(L.SLOTS).keys()].sort(() => Math.random() - 0.5)) {
  if ((await t(`deposit slot ${s}`, () => L.deposit(as(user), userToken, 50_000n, s, secret))).ok) { slot = s; break; }
}
if (slot < 0) throw new Error("no free slot");
const r = await t("submitReserve", () => L.submitReserve(as(nodeKp), L.makeReserveInput(mxeKey, { slot, secret, minutes: 3 }), nodeId));
if (!r.ok) throw new Error("reserve failed");
await t("verifyReserve", () => L.verifyReserve(as(nodeKp), r.reserveTx, nodeId));
const counter = Math.floor(Date.now() / 1000); // strictly increasing per slot
const v = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 2, counter, nodeId });
if (!(await t("redeem", () => L.redeem(as(nodeKp), v, nodeId))).ok) throw new Error("redeem failed");
await t("settle", () => L.settle(as(admin)));
await t("claim", () => L.claim(as(nodeKp), nodeId, nodeToken));
console.log("node payout +", (await getAccount(conn, nodeToken)).amount - before, "(expect 17600 for 2 min)");
