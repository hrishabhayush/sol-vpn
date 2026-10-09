// Prints the daemon code digest and the RTMR3 a TDX node running this code must report.
//   node node/deploy/expected-rtmr3.ts            (from a clean checkout of the commit you trust)
//   node expected-rtmr3.ts --extend               (on the VM, from startup.sh: extends RTMR3 once per boot)
// digest = SHA-384 over "<path>\n<sha384 hex of file>\n" for package.json + src/** in byte-sorted path order.
// RTMR3 starts at 48 zero bytes each boot; extend sets RTMR3 = SHA-384(RTMR3 || digest).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.join(import.meta.dirname, '..');
const sha384 = (b: Buffer | string) => createHash('sha384').update(b).digest();
const files = ['package.json', ...fs.readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' }).map((f) => `src/${f}`)]
  .filter((f) => fs.statSync(path.join(root, f)).isFile())
  .map((f) => f.split(path.sep).join('/'))
  .sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
const digest = sha384(files.map((f) => `${f}\n${sha384(fs.readFileSync(path.join(root, f))).toString('hex')}\n`).join(''));
const expected = sha384(Buffer.concat([Buffer.alloc(48), digest]));

if (process.argv.includes('--extend')) {
  const mr = '/sys/devices/virtual/misc/tdx_guest/measurements/rtmr3:sha384'; // Linux >= 6.16
  const current = fs.readFileSync(mr);
  if (current.equals(expected)) process.exit(0); // already extended this boot
  if (!current.equals(Buffer.alloc(48))) throw new Error('RTMR3 already extended with something else; reboot');
  fs.writeFileSync(mr, digest); // single 48-byte write at offset 0 = TDG.MR.RTMR.EXTEND
  if (!fs.readFileSync(mr).equals(expected)) throw new Error('RTMR3 mismatch after extend');
}
console.log(`files:  ${files.join(' ')}`);
console.log(`digest: ${digest.toString('hex')}`);
console.log(`rtmr3:  ${expected.toString('hex')}`);
