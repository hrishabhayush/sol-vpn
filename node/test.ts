// Mock-mode end-to-end check: node test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

const PORT = 18443;
const proc = spawn(process.execPath, ['src/main.ts', '--mock'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(PORT), VOUCHER_TIMEOUT_S: '2' },
});
let log = '';
proc.stdout.on('data', (d) => (log += d));
proc.stderr.on('data', (d) => (log += d));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
while (!log.includes('listening')) await sleep(50);

const call = async (path: string, body?: object) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  return [r.status, await r.json()] as const;
};
const clientPk = Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
const tx = '5'.repeat(88);

try {
  const nonce = randomBytes(32);
  const [s1, a] = await call(`/attest?nonce=${nonce.toString('hex')}`);
  assert.equal(s1, 200);
  assert.equal(a.tee, 'mock');
  assert.equal(a.endpoint, '127.0.0.1:51820');
  assert.equal(a.node_id, 0);
  const expected = createHash('sha512').update(Buffer.from(a.wg_pubkey, 'base64')).update(nonce).digest('base64');
  assert.equal(a.report, expected, 'report_data = SHA-512(wg_pubkey || nonce)');
  assert.equal((await call('/attest?nonce=abc'))[0], 400);

  assert.equal((await call('/session', { client_wg_pubkey: 'x', reserve_tx: tx }))[0], 400);
  assert.equal((await call('/session', { client_wg_pubkey: clientPk, reserve_tx: 'xxx' + tx.slice(3) }))[0], 402);
  const [s2, sess] = await call('/session', { client_wg_pubkey: clientPk, reserve_tx: tx });
  assert.equal(s2, 200);
  assert.equal(sess.client_ip, '10.8.0.2/32');
  assert.equal(sess.dns, '10.8.0.1');
  assert.match(sess.session_id, /^[0-9a-f]{32}$/);
  assert.ok(sess.expires_at - Date.now() / 1000 > 3500);
  assert.equal((await call('/session', { client_wg_pubkey: clientPk, reserve_tx: tx }))[0], 409, 'reserve replay');

  const vurl = `/session/${sess.session_id}/voucher`;
  const [s3, v] = await call(vurl, { voucher: 'ZW5j', minutes: 1, counter: 1 });
  assert.equal(s3, 200);
  assert.deepEqual(v, { ok: true, expires_at: sess.expires_at });
  assert.equal((await call(vurl, { voucher: 'ZW5j', minutes: 1, counter: 1 }))[0], 409, 'counter replay');

  await sleep(3500); // > VOUCHER_TIMEOUT_S + sweep
  assert.equal((await call(vurl, { voucher: 'ZW5j', minutes: 2, counter: 2 }))[0], 404, 'session timed out');
  assert.match(log, /wg set wg0 peer \S+ allowed-ips 10\.8\.0\.2\/32/);
  assert.match(log, /wg set wg0 peer \S+ remove/);
  assert.match(log, /redeem ok/);
  console.log('ok');
} finally {
  proc.kill();
}
