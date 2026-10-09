// sol-vpn ledger client. Every tx is signed/paid by program.provider.wallet.
// ESM; loads as-is in Node >= 24 (type stripping) and Vite (browser needs Buffer/crypto polyfills, see README).
import * as anchorNs from "@anchor-lang/core";
import type { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
import type { Ledger } from "./idl/ledger.ts";
import idl from "./idl/ledger.json" with { type: "json" };

// Node loads anchor's CJS build (named exports not detectable -> use default), Vite loads its ESM build.
const anchor: typeof anchorNs = (anchorNs as any).default ?? anchorNs;
const randomBytes = (n: number) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));

export type { Ledger };
export const PRICE_PER_MINUTE = 10_000n;
export const SLOTS = 16;
export const NODES = 16;
export const CIRCUITS = ["init_ledger", "deposit", "reserve", "redeem", "settle"] as const;

export function ledgerProgram(provider: AnchorProvider): Program<Ledger> {
  return new anchor.Program<Ledger>(idl as Ledger, provider);
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
  return { pubkey: Array.from(x25519.getPublicKey(sk)), nonce: new anchor.BN(deserializeLE(nonce).toString()), nonceBytes: nonce, ct };
}

/** base64(pubkey 32 | nonce 16 | n x 32-byte ciphertexts): the wire format of reserve inputs and vouchers. */
function encryptB64(mxeKey: Uint8Array, values: bigint[]): string {
  const e = encrypt(mxeKey, values);
  return Buffer.concat([Buffer.from(e.pubkey), e.nonceBytes, ...e.ct.map((c) => Buffer.from(c))]).toString("base64");
}

function decodeB64(b64: string, n: number) {
  const b = Buffer.from(b64, "base64");
  if (b.length !== 48 + 32 * n) throw new Error("bad encrypted input");
  return {
    pubkey: Array.from(b.subarray(0, 32)),
    nonce: new anchor.BN(deserializeLE(b.subarray(32, 48)).toString()),
    ct: Array.from({ length: n }, (_, i) => Array.from(b.subarray(48 + 32 * i, 80 + 32 * i))),
  };
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
    const offset = new anchor.BN(randomBytes(8));
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
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
  const sigs = await conn.getSignaturesForAddress(computationAccount, { limit: 10 }, "confirmed");
  const events: { name: string; data: any }[] = [];
  for (const { signature } of sigs) {
    const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (const e of parser.parseLogs(tx?.meta?.logMessages ?? [])) events.push({ name: e.name[0].toLowerCase() + e.name.slice(1), data: e.data });
  }
  return events;
}

// ---------------- admin ----------------

/**
 * One-time after deploy. urlBase set: circuits are fetched by Arx nodes from `${urlBase}/<name>.arcis`
 * (must match build/<name>.hash compiled into the program). Unset: uploads build/*.arcis on-chain (Node only).
 */
export async function initCompDefs(program: Program<Ledger>, buildDir: string, urlBase?: string) {
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxe = await getArciumProgram(provider(program)).account.mxeAccount.fetch(mxeAccount);
  const addressLookupTable = getLookupTableAddress(program.programId, mxe.lutOffsetSlot);
  const methods: Record<string, (url: string | null) => any> = {
    init_ledger: (u) => program.methods.initInitLedgerCompDef(u),
    deposit: (u) => program.methods.initDepositCompDef(u),
    reserve: (u) => program.methods.initReserveCompDef(u),
    redeem: (u) => program.methods.initRedeemCompDef(u),
    settle: (u) => program.methods.initSettleCompDef(u),
  };
  for (const name of CIRCUITS) {
    const compDefAccount = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), getCompDefAccOffset(name)],
      getArciumProgramId(),
    )[0];
    if (!(await program.provider.connection.getAccountInfo(compDefAccount))) {
      await methods[name](urlBase ? `${urlBase}/${name}.arcis` : null)
        .accounts({ compDefAccount, payer: provider(program).wallet.publicKey, mxeAccount, addressLookupTable })
        .rpc({ commitment: "confirmed" });
    }
    if (urlBase) continue;
    const { readFileSync } = await import("node:fs");
    await uploadCircuit(provider(program), name, program.programId, readFileSync(`${buildDir}/${name}.arcis`), false, 500, {
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

/** Updates the node's expected TEE measurement (48 bytes) after a node code change. Signer = node authority. */
export async function setMeasurement(program: Program<Ledger>, nodeId: number, expectedMeasurement: Uint8Array) {
  return program.methods
    .setMeasurement(nodeId, Array.from(expectedMeasurement))
    .accountsPartial({ node: nodePda(program, nodeId) })
    .rpc({ commitment: "confirmed" });
}

/**
 * Node submits the client's encrypted reserve input (from makeReserveInput). Signer = node authority.
 * Not replay-safe on its own: the node must refuse an input it has already submitted (409).
 */
export async function submitReserve(program: Program<Ledger>, inputB64: string, nodeId: number): Promise<{ reserveTx: string; ok: boolean; minutes: number }> {
  const e = decodeB64(inputB64, 3);
  const r = await run(program, "reserve", (offset, accs) =>
    program.methods
      .reserve(offset, nodeId, e.ct[0], e.ct[1], e.ct[2], e.pubkey, e.nonce)
      .accountsPartial({ ...accs, node: nodePda(program, nodeId), reservation: reservationPda(program, offset) }));
  const ev = r.events.find((e) => e.name === "reserveResult")?.data;
  return { reserveTx: r.queueSig, ok: ev?.ok ?? false, minutes: ev?.minutes ?? 0 };
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
  const { ct, pubkey, nonce } = decodeB64(voucher, 5);
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
      .deposit(offset, new anchor.BN(amount.toString()), e.ct[0], e.ct[1], e.pubkey, e.nonce)
      .accountsPartial({ ...accs, userToken, tokenProgram: TOKEN_PROGRAM_ID }));
  return { sig: r.queueSig, ok: r.events.find((e) => e.name === "depositResult")?.data.ok ?? false };
}

/** Client-side: encrypted reserve input (base64) for POST /session; the node submits it with submitReserve. */
export function makeReserveInput(mxeKey: Uint8Array, r: { slot: number; secret: bigint; minutes: number }): string {
  return encryptB64(mxeKey, [BigInt(r.slot), r.secret, BigInt(r.minutes)]);
}

/** Builds the base64 voucher for POST /session/:id/voucher. counter must strictly increase per slot, forever. */
export function makeVoucher(mxeKey: Uint8Array, v: { slot: number; secret: bigint; totalMinutes: number; counter: number; nodeId: number }): string {
  return encryptB64(mxeKey, [BigInt(v.slot), v.secret, BigInt(v.totalMinutes), BigInt(v.counter), BigInt(v.nodeId)]);
}

/** Random nonzero u64 secret. */
export const newSecret = () => BigInt("0x" + randomBytes(8).toString("hex")) || 1n;

// ---------------- anyone ----------------

/** Reveals cumulative per-node earnings (minutes) into Config.earned. */
export async function settle(program: Program<Ledger>): Promise<bigint[]> {
  await run(program, "settle", (offset, accs) => program.methods.settle(offset).accountsPartial(accs));
  return (await program.account.config.fetch(configPda(program))).earned.map((x) => BigInt(x.toString()));
}
