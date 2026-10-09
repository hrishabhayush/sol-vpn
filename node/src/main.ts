// sol-vpn node daemon. Run: node src/main.ts [--mock]
// No-log: never log client IPs, pubkeys, reserve txs or traffic. Counts only.
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as ledger from './ledger.ts';

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT ?? 8443);
const ENDPOINT = process.env.NODE_ENDPOINT ?? (MOCK ? '127.0.0.1:51820' : '');
const VOUCHER_TIMEOUT_S = Number(process.env.VOUCHER_TIMEOUT_S ?? 90);
const NODE_ID = Number(process.env.NODE_ID || (MOCK ? 0 : NaN));
const TSM = '/sys/kernel/config/tsm/report';
if (!ENDPOINT) throw new Error('NODE_ENDPOINT=<public ip>:51820 required');
if (!Number.isInteger(NODE_ID) || NODE_ID < 0 || NODE_ID > 255) throw new Error('NODE_ID=<NodeRegistry index, u8> required');
if (!MOCK && !ledger.NODE_KEYPAIR) throw new Error('NODE_KEYPAIR=<path to Solana keypair json> required');

function run(cmd: string, args: string[], input?: string) {
  if (MOCK) return console.log('[mock]', cmd, ...args);
  execFileSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'inherit'] });
}

// WireGuard key lives only in this process' memory (and the kernel's wg0).
const kp = generateKeyPairSync('x25519');
const wgPriv = Buffer.from(kp.privateKey.export({ format: 'jwk' }).d!, 'base64url');
const wgPub = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url');
const wgPubB64 = wgPub.toString('base64');

if (!MOCK) try { execFileSync('ip', ['link', 'del', 'wg0'], { stdio: 'ignore' }); } catch {}
run('ip', ['link', 'add', 'wg0', 'type', 'wireguard']);
run('ip', ['address', 'add', '10.8.0.1/24', 'dev', 'wg0']);
// Node hands children a socket, not a pipe, as stdin; wg can't fopen that as /dev/stdin. <(cat) is a real pipe.
run('bash', ['-c', 'wg set wg0 listen-port 51820 private-key <(cat)'], wgPriv.toString('base64'));
run('ip', ['link', 'set', 'wg0', 'up']);

function attest(nonce: Buffer) {
  const reportData = createHash('sha512').update(wgPub).update(nonce).digest();
  // Mock report = raw 64-byte report_data, so debug builds can still check the binding.
  if (MOCK) return { tee: 'mock', report: reportData.toString('base64') };
  const dir = `${TSM}/${randomBytes(8).toString('hex')}`; // one entry per request: no generation races
  fs.mkdirSync(dir);
  try {
    fs.writeFileSync(`${dir}/inblob`, reportData);
    const report = fs.readFileSync(`${dir}/outblob`);
    const provider = fs.readFileSync(`${dir}/provider`, 'utf8').trim();
    const tee = ({ tdx_guest: 'tdx', sev_guest: 'sev-snp' } as Record<string, string>)[provider];
    if (!tee) throw new Error(`unknown tsm provider ${provider}`);
    return { tee, report: report.toString('base64') };
  } finally {
    fs.rmdirSync(dir);
  }
}

type Session = {
  pubkey: string; octet: number; start: number; expiresAt: number;
  lastVoucherAt: number; voucher?: string; minutes: number; counter: number;
};
const sessions = new Map<string, Session>();
const usedReserves = new Set<string>(); // ponytail: in-memory, lost on restart; ledger should reject double use anyway
const pendingRedeems: string[] = [];
const now = () => Math.floor(Date.now() / 1000);
const logCount = (event: string) => console.log(`${event}: active_sessions=${sessions.size}`);

async function endSession(id: string, s: Session) {
  sessions.delete(id);
  run('wg', ['set', 'wg0', 'peer', s.pubkey, 'remove']);
  logCount('session ended');
  if (s.voucher) pendingRedeems.push(s.voucher);
}

async function flushRedeems() {
  for (const v of pendingRedeems.splice(0)) {
    try { console.log((await ledger.redeem(v, NODE_ID)) ? 'redeem ok' : 'redeem rejected'); }
    catch (e) { pendingRedeems.push(v); console.error('redeem failed, will retry:', (e as Error).message); }
  }
}

let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  const t = now();
  for (const [id, s] of sessions) if (t >= s.expiresAt || t - s.lastVoucherAt > VOUCHER_TIMEOUT_S) await endSession(id, s);
  await flushRedeems();
  sweeping = false;
}, 1000);

const isB64Key = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(s);
const isInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

async function handle(method: string, url: URL, body: any): Promise<[number, object]> {
  if (method === 'GET' && url.pathname === '/attest') {
    const nonce = url.searchParams.get('nonce') ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(nonce)) return [400, { error: 'nonce must be 32 bytes hex' }];
    return [200, { ...attest(Buffer.from(nonce, 'hex')), wg_pubkey: wgPubB64, endpoint: ENDPOINT, node_id: NODE_ID }];
  }

  if (method === 'POST' && url.pathname === '/session') {
    const { client_wg_pubkey: pk, reserve } = body ?? {};
    if (!isB64Key(pk) || pk === wgPubB64) return [400, { error: 'bad client_wg_pubkey' }];
    if (typeof reserve !== 'string' || reserve.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(reserve)) return [400, { error: 'bad reserve' }];
    if (usedReserves.has(reserve)) return [409, { error: 'reserve already used' }];
    if ([...sessions.values()].some((s) => s.pubkey === pk)) return [409, { error: 'pubkey has an active session' }];
    usedReserves.add(reserve); // before the await, so concurrent replays lose; never removed (client re-encrypts to retry)
    const r = await ledger.submitReserve(reserve, NODE_ID).catch((e) => (console.error('reserve failed:', (e as Error).message), { ok: false, minutes: 0 }));
    if (!r.ok || r.minutes <= 0) return [402, { error: 'reserve failed' }];
    // Allocate after the (seconds-long) await so concurrent sessions can't get the same IP.
    const used = new Set([...sessions.values()].map((s) => s.octet));
    const octet = [...Array(253).keys()].map((i) => i + 2).find((o) => !used.has(o));
    if (!octet) return [503, { error: 'node full' }]; // ponytail: reserved minutes are lost; node full is ~never
    const id = randomBytes(16).toString('hex');
    const t = now();
    const s: Session = { pubkey: pk, octet, start: t, expiresAt: t + r.minutes * 60, lastVoucherAt: t, minutes: 0, counter: -1 };
    run('wg', ['set', 'wg0', 'peer', pk, 'allowed-ips', `10.8.0.${octet}/32`]);
    sessions.set(id, s);
    logCount('session started');
    return [200, { session_id: id, client_ip: `10.8.0.${octet}/32`, dns: '10.8.0.1', expires_at: s.expiresAt }];
  }

  const m = url.pathname.match(/^\/session\/([0-9a-f]{32})\/voucher$/);
  if (method === 'POST' && m) {
    const s = sessions.get(m[1]);
    if (!s) return [404, { error: 'no such session' }];
    const { voucher, minutes, counter } = body ?? {};
    if (typeof voucher !== 'string' || !voucher || voucher.length > 8192 || !isInt(minutes) || !isInt(counter))
      return [400, { error: 'bad voucher' }];
    if (counter <= s.counter || minutes < s.minutes) return [409, { error: 'stale voucher' }];
    // Client must pay at least for every fully elapsed minute (it can't fall behind by more than one).
    // ponytail: trusts plaintext `minutes`; the encrypted voucher itself can only be checked by the ledger.
    if (minutes < Math.floor((now() - s.start) / 60)) return [402, { error: 'voucher does not cover elapsed time' }];
    Object.assign(s, { voucher, minutes, counter, lastVoucherAt: now() });
    return [200, { ok: true, expires_at: s.expiresAt }];
  }

  return [404, { error: 'not found' }];
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on('end', async () => {
    let status = 500, out: object = { error: 'internal' };
    try {
      const body = raw ? JSON.parse(raw) : undefined;
      [status, out] = await handle(req.method ?? '', new URL(req.url ?? '/', 'http://x'), body);
    } catch (e) {
      if (e instanceof SyntaxError) [status, out] = [400, { error: 'bad json' }];
      else console.error('request error:', (e as Error).message);
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
}).listen(PORT, () => console.log(`node listening :${PORT} mock=${MOCK} wg_pubkey=${wgPubB64}`));

// Redeem everything on shutdown so the node gets paid.
process.on('SIGTERM', async () => {
  for (const [id, s] of sessions) await endSession(id, s);
  await flushRedeems();
  process.exit(0);
});
