// Browser stand-ins for the Node builtins ledger/client and @arcium-hq/client import (aliased in vite.config.ts).
// Only what the app's code paths call: randomBytes, sha256/sha3-256. AES and fs are admin/Node-only paths.
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2";
import { sha3_256 } from "@noble/hashes/sha3";

(globalThis as any).Buffer ??= Buffer;

export const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));

export function createHash(alg: string) {
  const h = ({ sha256, "sha3-256": sha3_256 } as const)[alg as "sha256"]?.create();
  if (!h) throw new Error(`createHash(${alg}) not shimmed`);
  return { update(d: Uint8Array) { h.update(d); return this; }, digest: () => Buffer.from(h.digest()) };
}

const no = (name: string) => () => { throw new Error(`${name} is not available in the app`); };
export const createCipheriv = no("createCipheriv");
export const createDecipheriv = no("createDecipheriv");
export const readFileSync = no("fs.readFileSync");
export default { readFileSync };
