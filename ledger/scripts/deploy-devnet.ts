// After `arcium deploy` (see README): comp defs, test mint, initialize, node 0, writes devnet.json.
// Idempotent: re-run to resume. Usage: node scripts/deploy-devnet.ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import anchor from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { getMXEAccAddress, getArciumProgram } from "@arcium-hq/client";
import * as L from "../client/index.ts";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CIRCUITS_URL = "https://github.com/hrishabhayush/sol-vpn/releases/download/ledger-circuits-v1";
const NODE_KEYPAIR = new URL("../../node/node-keypair.json", import.meta.url);
const NODE0 = {
  endpoint: "34.172.3.92",
  tee: 1, // tdx
  country: "US", // GCP us-central1
  city: "Iowa",
  measurement: Buffer.from("d83aa0c346c50864c816a1e36cb6169175223b38b2c5ae49ffc881a798345a44546eb6c59c1c004d49002d7bac78280c", "hex"),
};
const OUT = new URL("../devnet.json", import.meta.url);

const load = (p: string | URL) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const admin = load(`${homedir()}/.config/solana/id.json`);
const nodeKp = load(NODE_KEYPAIR);
const as = (kp: Keypair) => L.ledgerProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
const program = as(admin);
const t = async <T>(label: string, f: () => Promise<T>) => {
  const s = Date.now();
  const r = await f();
  console.log(`${label}: ${(Date.now() - s) / 1000}s`);
  return r;
};

await t("comp defs", () => L.initCompDefs(program, "build", CIRCUITS_URL));

let config = await program.account.config.fetchNullable(L.configPda(program));
if (!config) {
  const mint = await createMint(conn, admin, admin.publicKey, null, 6);
  const treasury = (await getOrCreateAssociatedTokenAccount(conn, admin, mint, admin.publicKey)).address;
  await t("initialize (init_ledger MPC)", () => L.initialize(program, mint, treasury));
  config = await program.account.config.fetch(L.configPda(program));
}

if ((await conn.getBalance(nodeKp.publicKey)) < 0.4 * LAMPORTS_PER_SOL) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: nodeKp.publicKey, lamports: 0.5 * LAMPORTS_PER_SOL }));
  await sendAndConfirmTransaction(conn, tx, [admin]);
}
if (config.nodeCount === 0) await L.registerNode(as(nodeKp), NODE0.endpoint, NODE0.tee, NODE0.measurement, NODE0.country, NODE0.city);
const nodeToken = (await getOrCreateAssociatedTokenAccount(conn, admin, config.mint, nodeKp.publicKey)).address;

const mxe = await getArciumProgram(program.provider as anchor.AnchorProvider).account.mxeAccount.fetch(getMXEAccAddress(program.programId));
const out = {
  rpc: RPC,
  programId: program.programId.toBase58(),
  config: L.configPda(program).toBase58(),
  ledger: L.ledgerPda(program).toBase58(),
  vault: L.vaultPda(program).toBase58(),
  mint: config.mint.toBase58(),
  treasury: config.treasury.toBase58(),
  mxePubkey: Buffer.from(await L.getMxeKey(program)).toString("hex"),
  arciumClusterOffset: mxe.cluster as number,
  nodes: [{ id: 0, authority: nodeKp.publicKey.toBase58(), endpoint: NODE0.endpoint, payoutToken: nodeToken.toBase58() }],
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(out);
