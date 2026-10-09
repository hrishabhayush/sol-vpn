# ledger

Anchor + Arcium (v0.15.0) program: USDC vault, NodeRegistry, and an MPC-encrypted per-slot balance ledger.
Toolchain: arcium 0.15.0, anchor 1.0.2, solana 3.1.10, Docker running.

```bash
yarn install
arcium build && yarn idl     # yarn idl copies target/idl + types into client/idl
arcium test                  # localnet: 2 Arx nodes + validator, ~1 min
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
reserve(program, nodeId: number, slot: number, secret: bigint, minutes: number): Promise<{ reserveTx: string; ok: boolean; minutes: number }>
  // use a provider whose wallet is NOT the depositing wallet, or deposit and reserve can be linked
makeVoucher(mxeKey: Uint8Array, v: { slot, secret: bigint, totalMinutes, counter, nodeId }): string  // base64
  // counter must strictly increase per slot, across sessions, for the slot's lifetime

// node
registerNode(program, endpoint: string, tee: 0|1|2 /* mock|tdx|sev-snp */, expectedMeasurement: Uint8Array /*48*/): Promise<number /*node_id*/>
verifyReserve(program, reserveTx: string, nodeId: number, timeoutMs?): Promise<{ ok: boolean; minutes: number }>
redeem(program, voucher: string, nodeId: number): Promise<{ sig: string; ok: boolean }>  // signer = node authority
claim(program, nodeId: number, nodeToken: PublicKey): Promise<string>                    // 88% to node, 12% to treasury

// anyone / admin
settle(program): Promise<bigint[]>   // reveal cumulative earned minutes per node into Config.earned
initCompDefs(program, buildDir: string)  // once after deploy, uploads build/*.arcis
initialize(program, mint: PublicKey, treasury: PublicKey)
```

Accounts (PDAs of the program): `config`, `ledger`, `vault` (token acct, authority = config), `["node", id]` (NodeRegistry entry: authority, tee, expected_measurement, endpoint), `["resv", offset]` (public reserve result).
