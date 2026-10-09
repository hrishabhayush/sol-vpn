// sol-vpn ledger client. Every tx is signed/paid by program.provider.wallet.
import * as anchor from "@anchor-lang/core";
import { BN, Program, AnchorProvider, BorshCoder, EventParser } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { randomBytes } from "crypto";
import * as fs from "fs";
import {
  RescueCipher,
  x25519,
  deserializeLE,
  awaitComputationFinalization,
  getArciumProgram,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getLookupTableAddress,
  uploadCircuit,
} from "@arcium-hq/client";
import type { Ledger } from "./idl/ledger";
import idl from "./idl/ledger.json";

export type { Ledger };
export const PRICE_PER_MINUTE = 10_000n;
export const SLOTS = 16;
export const NODES = 16;
export const CIRCUITS = ["init_ledger", "deposit", "reserve", "redeem", "settle"] as const;

export function ledgerProgram(provider: AnchorProvider): Program<Ledger> {
  return new Program<Ledger>(idl as Ledger, provider);
}

const pda = (program: Program<Ledger>, ...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
export const configPda = (p: Program<Ledger>) => pda(p, Buffer.from("config"));
export const ledgerPda = (p: Program<Ledger>) => pda(p, Buffer.from("ledger"));
export const vaultPda = (p: Program<Ledger>) => pda(p, Buffer.from("vault"));
export const nodePda = (p: Program<Ledger>, nodeId: number) => pda(p, Buffer.from("node"), Buffer.from([nodeId]));
export const reservationPda = (p: Program<Ledger>, offset: BN) =>
  pda(p, Buffer.from("resv"), offset.toArrayLike(Buffer, "le", 8));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const provider = (p: Program<Ledger>) => p.provider as AnchorProvider;

export async function getMxeKey(program: Program<Ledger>): Promise<Uint8Array> {
  for (let i = 0; i < 30; i++) {
    const k = await getMXEPublicKey(provider(program), program.programId).catch(() => null);
    if (k) return k;
    await sleep(1000);
  }
  throw new Error("MXE public key unavailable");
}

/** Encrypts values for an Enc<Shared, T> input with a fresh ephemeral x25519 key. */
export function encrypt(mxeKey: Uint8Array, values: bigint[]) {
  const sk = x25519.utils.randomSecretKey();
  const nonce = randomBytes(16);
  const ct = new RescueCipher(x25519.getSharedSecret(sk, mxeKey)).encrypt(values, nonce);
  return { pubkey: Array.from(x25519.getPublicKey(sk)), nonce: new BN(deserializeLE(nonce).toString()), nonceBytes: nonce, ct };
}

/** Arcium accounts every queue_computation instruction needs. */
async function arciumAccs(program: Program<Ledger>, offset: BN, circuit: string) {
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxe = await getArciumProgram(provider(program)).account.mxeAccount.fetch(mxeAccount);
  const cluster = mxe.cluster as number;
  return {
    computationAccount: getComputationAccAddress(cluster, offset),
    clusterAccount: getClusterAccAddress(cluster),
    mxeAccount,
    mempoolAccount: getMempoolAccAddress(cluster),
    executingPool: getExecutingPoolAccAddress(cluster),
    compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()),
  };
}

/** Queues a computation (retrying while the ledger is busy) and waits for its callback. */
async function run(
  program: Program<Ledger>,
  circuit: string,
  build: (offset: BN, accs: Awaited<ReturnType<typeof arciumAccs>>) => any,
): Promise<{ queueSig: string; events: { name: string; data: any }[]; offset: BN }> {
  for (let attempt = 0; ; attempt++) {
    const offset = new BN(randomBytes(8), "hex");
    try {
      const accs = await arciumAccs(program, offset, circuit);
      const queueSig = await build(offset, accs).rpc({ commitment: "confirmed" });
      await awaitComputationFinalization(provider(program), offset, program.programId, "confirmed");
      return { queueSig, events: await compEvents(program, accs.computationAccount), offset };
    } catch (e: any) {
      if (attempt < 60 && String(e).includes("Busy")) { await sleep(2000); continue; }
      throw e;
    }
  }
}

/** Our program's events from every tx touching the computation account (incl. the callback tx). */
async function compEvents(program: Program<Ledger>, computationAccount: PublicKey) {
  const conn = program.provider.connection;
  const parser = new EventParser(program.programId, new BorshCoder(program.idl));
  const sigs = await conn.getSignaturesForAddress(computationAccount, { limit: 10 }, "confirmed");
  const events: { name: string; data: any }[] = [];
  for (const { signature } of sigs) {
    const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (const e of parser.parseLogs(tx?.meta?.logMessages ?? [])) events.push({ name: e.name[0].toLowerCase() + e.name.slice(1), data: e.data });
  }
  return events;
}

// ---------------- admin ----------------

/** One-time after deploy: init comp defs + upload circuits from `buildDir` (ledger/build). */
export async function initCompDefs(program: Program<Ledger>, buildDir: string) {
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxe = await getArciumProgram(provider(program)).account.mxeAccount.fetch(mxeAccount);
  const addressLookupTable = getLookupTableAddress(program.programId, mxe.lutOffsetSlot);
  const methods: Record<string, () => any> = {
    init_ledger: () => program.methods.initInitLedgerCompDef(),
    deposit: () => program.methods.initDepositCompDef(),
    reserve: () => program.methods.initReserveCompDef(),
    redeem: () => program.methods.initRedeemCompDef(),
    settle: () => program.methods.initSettleCompDef(),
  };
  for (const name of CIRCUITS) {
    const compDefAccount = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), getCompDefAccOffset(name)],
      getArciumProgramId(),
    )[0];
    await methods[name]()
      .accounts({ compDefAccount, payer: provider(program).wallet.publicKey, mxeAccount, addressLookupTable })
      .rpc({ commitment: "confirmed" });
    await uploadCircuit(provider(program), name, program.programId, fs.readFileSync(`${buildDir}/${name}.arcis`), false, 500, {
      skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed",
    });
  }
}

/** Creates config/vault/ledger for `mint`; fees go to `treasury` (token account of mint). */
export async function initialize(program: Program<Ledger>, mint: PublicKey, treasury: PublicKey) {
  await run(program, "init_ledger", (offset, accs) =>
    program.methods.initialize(offset).accountsPartial({ ...accs, mint, treasury, tokenProgram: TOKEN_PROGRAM_ID }));
  if ((await program.account.ledger.fetch(ledgerPda(program))).busy) throw new Error("init_ledger computation failed");
}

// ---------------- node ----------------

/** tee: 0 mock, 1 tdx, 2 sev-snp. Signer = node authority (payout owner). Returns node_id. */
export async function registerNode(program: Program<Ledger>, endpoint: string, tee: number, expectedMeasurement: Uint8Array): Promise<number> {
  const nodeId = (await program.account.config.fetch(configPda(program))).nodeCount;
  await program.methods
    .registerNode(endpoint, tee, Array.from(expectedMeasurement))
    .accountsPartial({ node: nodePda(program, nodeId) })
    .rpc({ commitment: "confirmed" });
  return nodeId;
}

/** Reads the public reserve result for the reserve() tx signature. Waits for the MPC callback. */
export async function verifyReserve(program: Program<Ledger>, reserveTx: string, nodeId: number, timeoutMs = 120_000): Promise<{ ok: boolean; minutes: number }> {
  const conn = program.provider.connection;
  const tx = await conn.getTransaction(reserveTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error("reserve tx not found");
  const ix = program.idl.instructions.find((i) => i.name === "reserve")!;
  const keys = tx.transaction.message.staticAccountKeys;
  const resvIdx = ix.accounts.findIndex((a) => a.name === "reservation");
  const cix = tx.transaction.message.compiledInstructions.find((c) => keys[c.programIdIndex].equals(program.programId));
  if (!cix || Buffer.from(cix.data.slice(0, 8)).compare(Buffer.from(ix.discriminator)) !== 0) throw new Error("not a reserve tx");
  const reservation = keys[cix.accountKeyIndexes[resvIdx]];
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(1000)) {
    const r = await program.account.reservation.fetch(reservation, "confirmed");
    if (r.done) return { ok: r.ok && r.nodeId === nodeId, minutes: r.ok && r.nodeId === nodeId ? r.minutes : 0 };
  }
  throw new Error("reserve result timeout");
}

/** Node submits the client's latest voucher (base64). Signer must be the node authority. */
export async function redeem(program: Program<Ledger>, voucher: string, nodeId: number): Promise<{ sig: string; ok: boolean }> {
  const b = Buffer.from(voucher, "base64");
  if (b.length !== 32 + 16 + 5 * 32) throw new Error("bad voucher");
  const pubkey = Array.from(b.subarray(0, 32));
  const nonce = new BN(deserializeLE(b.subarray(32, 48)).toString());
  const ct = [0, 1, 2, 3, 4].map((i) => Array.from(b.subarray(48 + 32 * i, 80 + 32 * i)));
  const r = await run(program, "redeem", (offset, accs) =>
    program.methods.redeem(offset, nodeId, ct, pubkey, nonce).accountsPartial({ ...accs, node: nodePda(program, nodeId) }));
  return { sig: r.queueSig, ok: r.events.find((e) => e.name === "redeemResult")?.data.ok ?? false };
}

/** Pays out settled earnings: 88% to the authority's token account, 12% to treasury. */
export async function claim(program: Program<Ledger>, nodeId: number, nodeToken: PublicKey) {
  const config = await program.account.config.fetch(configPda(program));
  return program.methods
    .claim(nodeId)
    .accountsPartial({ node: nodePda(program, nodeId), nodeToken, treasury: config.treasury, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc({ commitment: "confirmed" });
}

// ---------------- user (app) ----------------

/** Deposits `amount` base units (multiple of 10_000) into slot. ok=false => refunded (slot taken). */
export async function deposit(program: Program<Ledger>, userToken: PublicKey, amount: bigint, slot: number, secret: bigint): Promise<{ sig: string; ok: boolean }> {
  const e = encrypt(await getMxeKey(program), [BigInt(slot), secret]);
  const r = await run(program, "deposit", (offset, accs) =>
    program.methods
      .deposit(offset, new BN(amount.toString()), e.ct[0], e.ct[1], e.pubkey, e.nonce)
      .accountsPartial({ ...accs, userToken, tokenProgram: TOKEN_PROGRAM_ID }));
  return { sig: r.queueSig, ok: r.events.find((e) => e.name === "depositResult")?.data.ok ?? false };
}

/**
 * Escrows `minutes` for nodeId. Returns the reserve tx signature to hand to the node (POST /session).
 * Privacy: call with a provider whose wallet is NOT the depositing wallet.
 */
export async function reserve(program: Program<Ledger>, nodeId: number, slot: number, secret: bigint, minutes: number): Promise<{ reserveTx: string; ok: boolean; minutes: number }> {
  const e = encrypt(await getMxeKey(program), [BigInt(slot), secret, BigInt(minutes)]);
  const r = await run(program, "reserve", (offset, accs) =>
    program.methods
      .reserve(offset, nodeId, e.ct[0], e.ct[1], e.ct[2], e.pubkey, e.nonce)
      .accountsPartial({ ...accs, reservation: reservationPda(program, offset) }));
  const ev = r.events.find((e) => e.name === "reserveResult")?.data;
  return { reserveTx: r.queueSig, ok: ev?.ok ?? false, minutes: ev?.minutes ?? 0 };
}

/** Builds the base64 voucher for POST /session/:id/voucher. counter must strictly increase per slot, forever. */
export function makeVoucher(mxeKey: Uint8Array, v: { slot: number; secret: bigint; totalMinutes: number; counter: number; nodeId: number }): string {
  const e = encrypt(mxeKey, [BigInt(v.slot), v.secret, BigInt(v.totalMinutes), BigInt(v.counter), BigInt(v.nodeId)]);
  return Buffer.concat([Buffer.from(e.pubkey), e.nonceBytes, ...e.ct.map((c) => Buffer.from(c))]).toString("base64");
}

/** Random nonzero u64 secret. */
export const newSecret = () => BigInt("0x" + randomBytes(8).toString("hex")) || 1n;

// ---------------- anyone ----------------

/** Reveals cumulative per-node earnings (minutes) into Config.earned. */
export async function settle(program: Program<Ledger>): Promise<bigint[]> {
  await run(program, "settle", (offset, accs) => program.methods.settle(offset).accountsPartial(accs));
  return (await program.account.config.fetch(configPda(program))).earned.map((x) => BigInt(x.toString()));
}
