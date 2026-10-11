import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import * as L from "../client/index.ts";

describe("ledger", () => {
  const env = AnchorProvider.env();
  const conn = new Connection(env.connection.rpcEndpoint, "confirmed");
  const admin = (env.wallet as Wallet).payer;
  const provider = new AnchorProvider(conn, env.wallet, { commitment: "confirmed" });
  const program = L.ledgerProgram(provider);
  const as = (kp: Keypair) => L.ledgerProgram(new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }));

  const user = Keypair.generate();
  const other = Keypair.generate(); // not a node authority
  const nodeKp = Keypair.generate();
  let mint: PublicKey, treasury: PublicKey, userToken: PublicKey, nodeToken: PublicKey;
  let mxeKey: Uint8Array;
  const slot = 3;
  const secret = L.newSecret();
  let nodeId: number;
  const bal = async (a: PublicKey) => (await getAccount(conn, a, "confirmed")).amount;

  before(async () => {
    for (const kp of [user, other, nodeKp]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }
    mint = await createMint(conn, admin, admin.publicKey, null, 6);
    treasury = await createAccount(conn, admin, mint, admin.publicKey, Keypair.generate());
    userToken = await createAccount(conn, admin, mint, user.publicKey);
    nodeToken = await createAccount(conn, admin, mint, nodeKp.publicKey);
    await mintTo(conn, admin, mint, userToken, admin, 1_000_000); // 100 minutes

    let t = Date.now();
    await L.initCompDefs(program, "build");
    console.log(`    comp defs + circuit upload: ${(Date.now() - t) / 1000}s`);
    t = Date.now();
    await L.initialize(program, mint, treasury);
    console.log(`    initialize: ${(Date.now() - t) / 1000}s`);
    mxeKey = await L.getMxeKey(program);
    nodeId = await L.registerNode(as(nodeKp), "1.2.3.4:51820", 0, new Uint8Array(48), "US", "Iowa");
    assert.equal(nodeId, 0);
  });

  it("register_node stores location, caps city length", async () => {
    const n = await program.account.node.fetch(L.nodePda(program, nodeId));
    assert.equal(Buffer.from(n.country).toString(), "US");
    assert.equal(n.city, "Iowa");
    await assert.rejects(L.registerNode(as(other), "5.6.7.8", 0, new Uint8Array(48), "DE", "x".repeat(25)), /CityTooLong/);
  });

  it("set_measurement: node authority only", async () => {
    const m = new Uint8Array(48).fill(7);
    await L.setMeasurement(as(nodeKp), nodeId, m);
    assert.deepEqual((await program.account.node.fetch(L.nodePda(program, nodeId))).expectedMeasurement, Array.from(m));
    await assert.rejects(L.setMeasurement(as(other), nodeId, new Uint8Array(48)), /NotNodeAuthority/);
  });

  // client encrypts, node submits
  const reserve = (minutes: number) => L.submitReserve(as(nodeKp), L.makeReserveInput(mxeKey, { slot, secret, minutes }), nodeId);

  it("deposit credits a fresh slot", async () => {
    const r = await L.deposit(as(user), userToken, 500_000n, slot, secret); // 50 min
    assert.equal(r.ok, true);
    assert.equal(await bal(userToken), 500_000n);
    assert.equal(await bal(L.vaultPda(program)), 500_000n);
  });

  it("deposit to a claimed slot with wrong secret is refunded", async () => {
    const r = await L.deposit(as(user), userToken, 100_000n, slot, secret + 1n);
    assert.equal(r.ok, false);
    assert.equal(await bal(userToken), 500_000n);
  });

  it("reserve: insufficient balance -> ok=false", async () => {
    const r = await reserve(51);
    assert.equal(r.ok, false);
    assert.deepEqual(await L.verifyReserve(program, r.reserveTx, nodeId), { ok: false, minutes: 0 });
  });

  let firstVoucher: string;
  it("reserve ok -> node reads {ok, minutes}; redeem charges and refunds", async () => {
    const r = await reserve(20);
    assert.deepEqual(await L.verifyReserve(program, r.reserveTx, nodeId), { ok: true, minutes: 20 });
    assert.deepEqual(await L.verifyReserve(program, r.reserveTx, nodeId + 1), { ok: false, minutes: 0 });
    // client sends vouchers each minute; node redeems the last one
    L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 6, counter: 4, nodeId });
    firstVoucher = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 7, counter: 5, nodeId });
    assert.equal((await L.redeem(as(nodeKp), firstVoucher, nodeId)).ok, true);
    // balance now 50 - 7 = 43: reserving 44 fails, 43 would succeed
    assert.equal((await reserve(44)).ok, false);
  });

  it("redeem with replayed counter is rejected", async () => {
    assert.equal((await reserve(10)).ok, true);
    assert.equal((await L.redeem(as(nodeKp), firstVoucher, nodeId)).ok, false);
    const v = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 3, counter: 6, nodeId });
    assert.equal((await L.redeem(as(nodeKp), v, nodeId)).ok, true);
  });

  it("reserve / redeem by a non-authority signer fail", async () => {
    const v = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 1, counter: 7, nodeId });
    await assert.rejects(L.redeem(as(other), v, nodeId), /NotNodeAuthority/);
    const input = L.makeReserveInput(mxeKey, { slot, secret, minutes: 1 });
    await assert.rejects(L.submitReserve(as(other), input, nodeId), /NotNodeAuthority/);
  });

  it("settle reveals earnings; claim pays 88% node / 12% treasury", async () => {
    const earned = await L.settle(program);
    assert.equal(earned[nodeId], 10n); // 7 + 3 minutes
    await L.claim(as(nodeKp), nodeId, nodeToken);
    assert.equal(await bal(nodeToken), 88_000n);
    assert.equal(await bal(treasury), 12_000n);
    assert.equal(await bal(L.vaultPda(program)), 500_000n - 100_000n);
    await L.claim(as(nodeKp), nodeId, nodeToken); // nothing new to pay
    assert.equal(await bal(nodeToken), 88_000n);
  });
});
