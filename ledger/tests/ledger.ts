import * as anchor from "@anchor-lang/core";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import * as L from "../client";

describe("ledger", () => {
  const env = AnchorProvider.env();
  const conn = new Connection(env.connection.rpcEndpoint, "confirmed");
  const admin = (env.wallet as Wallet).payer;
  const provider = new AnchorProvider(conn, env.wallet, { commitment: "confirmed" });
  const program = L.ledgerProgram(provider);
  const as = (kp: Keypair) => L.ledgerProgram(new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }));

  const user = Keypair.generate();
  const relayer = Keypair.generate(); // pays for reserve, unlinked to user
  const nodeKp = Keypair.generate();
  let mint: PublicKey, treasury: PublicKey, userToken: PublicKey, nodeToken: PublicKey;
  let mxeKey: Uint8Array;
  const slot = 3;
  const secret = L.newSecret();
  let nodeId: number;
  const bal = async (a: PublicKey) => (await getAccount(conn, a, "confirmed")).amount;

  before(async () => {
    for (const kp of [user, relayer, nodeKp]) {
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
    nodeId = await L.registerNode(as(nodeKp), "1.2.3.4:51820", 0, new Uint8Array(48));
    expect(nodeId).to.equal(0);
  });

  it("deposit credits a fresh slot", async () => {
    const r = await L.deposit(as(user), userToken, 500_000n, slot, secret); // 50 min
    expect(r.ok).to.equal(true);
    expect(await bal(userToken)).to.equal(500_000n);
    expect(await bal(L.vaultPda(program))).to.equal(500_000n);
  });

  it("deposit to a claimed slot with wrong secret is refunded", async () => {
    const r = await L.deposit(as(user), userToken, 100_000n, slot, secret + 1n);
    expect(r.ok).to.equal(false);
    expect(await bal(userToken)).to.equal(500_000n);
  });

  it("reserve: insufficient balance -> ok=false", async () => {
    const r = await L.reserve(as(relayer), nodeId, slot, secret, 51);
    expect(r.ok).to.equal(false);
    expect(await L.verifyReserve(program, r.reserveTx, nodeId)).to.deep.equal({ ok: false, minutes: 0 });
  });

  let firstVoucher: string;
  it("reserve ok -> node reads {ok, minutes}; redeem charges and refunds", async () => {
    const r = await L.reserve(as(relayer), nodeId, slot, secret, 20);
    expect(await L.verifyReserve(program, r.reserveTx, nodeId)).to.deep.equal({ ok: true, minutes: 20 });
    expect(await L.verifyReserve(program, r.reserveTx, nodeId + 1)).to.deep.equal({ ok: false, minutes: 0 });
    // client sends vouchers each minute; node redeems the last one
    L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 6, counter: 4, nodeId });
    firstVoucher = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 7, counter: 5, nodeId });
    expect((await L.redeem(as(nodeKp), firstVoucher, nodeId)).ok).to.equal(true);
    // balance now 50 - 7 = 43: reserving 44 fails, 43 would succeed
    expect((await L.reserve(as(relayer), nodeId, slot, secret, 44)).ok).to.equal(false);
  });

  it("redeem with replayed counter is rejected", async () => {
    expect((await L.reserve(as(relayer), nodeId, slot, secret, 10)).ok).to.equal(true);
    expect((await L.redeem(as(nodeKp), firstVoucher, nodeId)).ok).to.equal(false);
    const v = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 3, counter: 6, nodeId });
    expect((await L.redeem(as(nodeKp), v, nodeId)).ok).to.equal(true);
  });

  it("redeem by a non-authority signer fails", async () => {
    const v = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 1, counter: 7, nodeId });
    let err = "";
    await L.redeem(as(relayer), v, nodeId).catch((e) => (err = String(e)));
    expect(err).to.match(/NotNodeAuthority|ConstraintRaw|2003|0x1/);
  });

  it("settle reveals earnings; claim pays 88% node / 12% treasury", async () => {
    const earned = await L.settle(program);
    expect(earned[nodeId]).to.equal(10n); // 7 + 3 minutes
    await L.claim(as(nodeKp), nodeId, nodeToken);
    expect(await bal(nodeToken)).to.equal(88_000n);
    expect(await bal(treasury)).to.equal(12_000n);
    expect(await bal(L.vaultPda(program))).to.equal(500_000n - 100_000n);
    await L.claim(as(nodeKp), nodeId, nodeToken); // nothing new to pay
    expect(await bal(nodeToken)).to.equal(88_000n);
  });
});
