# ledger

Anchor + Arcium (v0.15.0) program: USDC vault, NodeRegistry, and an MPC-encrypted per-slot balance ledger.
Toolchain: arcium 0.15.0, anchor 1.0.2, solana 3.1.10, Docker running.

```bash
yarn install
arcium build && yarn idl     # yarn idl copies target/idl + types into client/idl
arcium test                  # localnet: 2 Arx nodes + validator, ~1 min (node:test, Node >= 24)
yarn typecheck
```

## Model
- Price: 1 minute = 10_000 base units. Deposits must be a multiple of that.
- 16 encrypted slots `{balance, secret, counter, escrow, node}`, 16 nodes. A user picks a random slot + random nonzero u64 secret and keeps both.
- Every call is a public tx; slot, secret, minutes and voucher contents stay encrypted. Results that are public: deposit ok, reserve `{ok, minutes}`, redeem ok, settled per-node totals.
- One computation at a time (ledger lock). Helpers retry on `Busy` for up to ~2 min.

## Client API (`ledger/client`)
All functions sign and pay with `program.provider.wallet`.

```ts
ledgerProgram(provider: AnchorProvider): Program<Ledger>
getMxeKey(program): Promise<Uint8Array>
newSecret(): bigint

// app (user)
deposit(program, userToken: PublicKey, amount: bigint, slot: number, secret: bigint): Promise<{ sig: string; ok: boolean }>
  // ok=false: slot owned by another secret, deposit refunded. Pick another slot.
makeReserveInput(mxeKey: Uint8Array, r: { slot, secret: bigint, minutes }): string  // base64, send to node (POST /session)
makeVoucher(mxeKey: Uint8Array, v: { slot, secret: bigint, totalMinutes, counter, nodeId }): string  // base64
  // counter must strictly increase per slot, across sessions, for the slot's lifetime

// node
registerNode(program, endpoint: string, tee: 0|1|2 /* mock|tdx|sev-snp */, expectedMeasurement: Uint8Array /*48*/, country: string /*"US"*/, city: string /*<=24 bytes*/): Promise<number /*node_id*/>
setMeasurement(program, nodeId: number, expectedMeasurement: Uint8Array /*48*/): Promise<string>  // after node code changes
submitReserve(program, inputB64: string, nodeId: number): Promise<{ reserveTx: string; ok: boolean; minutes: number }>  // signer = node authority
verifyReserve(program, reserveTx: string, nodeId: number, timeoutMs?): Promise<{ ok: boolean; minutes: number }>
redeem(program, voucher: string, nodeId: number): Promise<{ sig: string; ok: boolean }>  // signer = node authority
claim(program, nodeId: number, nodeToken: PublicKey): Promise<string>                    // 88% to node, 12% to treasury

// anyone / admin
settle(program): Promise<bigint[]>   // reveal cumulative earned minutes per node into Config.earned
initCompDefs(program, buildDir: string, urlBase?: string)  // once after deploy; urlBase = off-chain circuits, else uploads build/*.arcis
initialize(program, mint: PublicKey, treasury: PublicKey)
```

Accounts (PDAs of the program): `config`, `ledger`, `vault` (token acct, authority = config), `["node", id]` (NodeRegistry entry: authority, tee, expected_measurement, endpoint), `["resv", offset]` (public reserve result).

## Replay
`reserve` and `redeem` must be signed by the node authority, so only the named node can submit a user's
encrypted input. Redeem is replay-safe on-chain (counter). Reserve is not: the reserve input has no nonce,
so the node must reject a reused input (409). Gap: a malicious node could resubmit an old reserve input after
the session is redeemed, re-locking those minutes in escrow for itself (it cannot earn them without a fresh
voucher, but the user can't reserve that slot again). Fix later: put the slot counter in ReserveIn.

## Importing (Node 24 / browser)
`client/index.ts` is plain ESM TypeScript: `import * as L from "<repo>/ledger/client/index.ts"` works directly in
Node >= 24 (type stripping) and in Vite. Run `yarn install` in ledger/ first (deps resolve from ledger/node_modules).

Browser (Vite/Tauri webview) needs exactly three things, no polyfill plugin (implemented in app/src/node-shim.ts,
app/src/anchor-shim.ts, aliased in app/vite.config.ts):
- alias `crypto` / `fs` (and `node:` forms) to a shim with `randomBytes` (WebCrypto), `createHash` for `sha256` and
  `sha3-256` (@noble/hashes); AES/`readFileSync` may throw (unused in the app path).
- `globalThis.Buffer` from the `buffer` package, set before @arcium-hq/client runs (the crypto shim does it).
- alias `@anchor-lang/core` to a module re-exporting `@anchor-lang/core/dist/browser/index.js` plus a default export
  (@arcium-hq/client does `import anchor from "@anchor-lang/core"`; the browser build has none).
Also `build.target >= es2022` (bigint). `initCompDefs` on-chain upload is Node-only.
Verified: a Vite 8 bundle of the client with these aliases runs with no Buffer global or Node builtins.

## Devnet
Arcium cluster offset 456 (Arcium.toml `[clusters.devnet]`). Addresses in `devnet.json`. Circuits are off-chain
(on-chain upload of ~4.6 MB of circuits would cost ~32 SOL rent): GitHub release `ledger-circuits-v1` assets,
hash-checked against `build/*.hash` compiled into the program. Rebuilding circuits => new release + new comp defs.
```bash
gh release create ledger-circuits-v1 build/*.arcis -R hrishabhayush/sol-vpn -t "ledger circuits" -n "Arcium circuits for ledger/"
arcium deploy --cluster-offset 456 --recovery-set-size 4 --keypair-path ~/.config/solana/id.json -u devnet
node scripts/deploy-devnet.ts          # comp defs, test mint (6 dp, authority = id.json), initialize, node 0 -> devnet.json
node scripts/smoke-devnet.ts           # deposit -> submitReserve -> redeem -> settle -> claim, prints timings
node scripts/mint-test-tokens.ts <wallet> <tokens>   # top-ups; 1 token = 100 minutes
```
Gap: `init_*_comp_def` takes the circuit URL as an argument and is permissionless until each comp def exists.
