// Devnet end-to-end against a live node: deposit -> POST /session -> voucher -> session ends -> node redeems -> settle.
//   cd node && NODE_PATH=../ledger/node_modules npx -y esbuild@0.28.2 e2e.ts --bundle --platform=node --format=esm \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
//     --log-level=error --outfile=/tmp/e2e.mjs && NODE_URL=http://34.172.3.92:8443 node /tmp/e2e.mjs
// USER_KEYPAIR (default ~/.config/solana/id.json) pays the deposit and must hold test tokens (or be the mint authority).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { AnchorProvider, Program, Wallet } from '@anchor-lang/core';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import * as L from '../ledger/client/index.ts';
import cfg from '../ledger/devnet.json' with { type: 'json' };

const NODE_URL = process.env.NODE_URL ?? 'http://34.172.3.92:8443';
const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.USER_KEYPAIR ?? `${os.homedir()}/.config/solana/id.json`, 'utf8'))));
const conn = new Connection(cfg.rpc, 'confirmed');
const provider = new AnchorProvider(conn, new Wallet(user), { commitment: 'confirmed' });
const program = new Program({ ...L.ledgerProgram(provider).idl, address: cfg.programId }, provider) as any;
const call = async (path: string, body?: object) => {
  const r = await fetch(NODE_URL + path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  return [r.status, await r.json()] as const;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

const [, a] = await call(`/attest?nonce=${randomBytes(32).toString('hex')}`);
const nodeId = a.node_id;
step(`attest tee=${a.tee} node_id=${nodeId}`);

const mint = new PublicKey(cfg.mint);
const userToken = (await getOrCreateAssociatedTokenAccount(conn, user, mint, user.publicKey)).address;
const amount = 20_000n; // 2 minutes
if ((await conn.getTokenAccountBalance(userToken)).value.amount < String(amount)) await mintTo(conn, user, mint, userToken, user, amount);

const earnedBefore = (await L.settle(program))[nodeId];
step(`settled earned[${nodeId}] = ${earnedBefore}`);

const mxeKey = await L.getMxeKey(program);
const secret = L.newSecret();
let slot = randomInt(16);
for (let i = 0; !(await L.deposit(program, userToken, amount, slot, secret)).ok; i++) {
  assert.ok(i < 16, 'no free slot');
  slot = (slot + 1) % 16;
}
step(`deposited ${amount} into slot ${slot}`);

const reserve = L.makeReserveInput(mxeKey, { slot, secret, minutes: 2 });
const clientPk = Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
const [s1, sess] = await call('/session', { client_wg_pubkey: clientPk, reserve });
assert.equal(s1, 200, JSON.stringify(sess));
step(`session ${sess.client_ip} expires in ${sess.expires_at - Math.floor(Date.now() / 1000)}s`);
assert.equal((await call('/session', { client_wg_pubkey: clientPk, reserve }))[0], 409, 'reserve replay');

const voucher = L.makeVoucher(mxeKey, { slot, secret, totalMinutes: 1, counter: 1, nodeId });
const [s2, v] = await call(`/session/${sess.session_id}/voucher`, { voucher, minutes: 1, counter: 1 });
assert.equal(s2, 200, JSON.stringify(v));
step('voucher accepted; waiting for the session to end (no more vouchers) and the node to redeem');

await sleep(100_000); // > VOUCHER_TIMEOUT_S (90)
for (let i = 0; ; i++) {
  const earned = (await L.settle(program))[nodeId];
  step(`settled earned[${nodeId}] = ${earned}`);
  if (earned >= earnedBefore + 1n) break;
  assert.ok(i < 10, 'redeem never landed');
  await sleep(15_000);
}
console.log('e2e ok');
process.exit(0);
