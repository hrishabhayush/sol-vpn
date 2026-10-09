# sol-vpn protocol (shared contract between app/, node/, ledger/)

Change this file only together with every side that depends on it.

## Layout
- `ledger/`  Anchor + Arcium program (vault, NodeRegistry, encrypted ledger) + `ledger/client` TS helpers
- `node/`    TypeScript (Node 24) daemon running in a TDX/SEV-SNP VM
- `app/`     Tauri v2 macOS menu bar app (Rust backend, TS frontend)

## Node HTTP API (port 8443, plain HTTP — not TLS; the attested WG key is the binding)

`node_id` = the node's index in NodeRegistry (u8, 0..N-1). Each node also has a Solana keypair (its authority: registers, submits redeem, receives payouts).
NodeRegistry.endpoint = node IP/host; app uses http://<endpoint>:8443 for the API and <endpoint>:51820 for WireGuard.
The WG key is regenerated every boot, so it is NOT stored in the registry; the app trusts the attested key.

### GET /attest?nonce=<hex32>
```json
{
  "tee": "tdx" | "sev-snp" | "mock",
  "report": "<base64 raw quote/report>",
  "wg_pubkey": "<base64 WireGuard pubkey>",
  "endpoint": "<ip>:51820"
}
```
Response also includes `"node_id": <u8>`.
`report_data` (64 bytes) = SHA-512(wg_pubkey_raw_32_bytes || nonce_raw_32_bytes).
The app refuses unless: signature chain valid, report_data matches, measurement == NodeRegistry.expected_measurement.
`mock` is accepted only in app debug builds.

### POST /session
```json
{ "client_wg_pubkey": "<base64>", "reserve": "<base64 makeReserveInput(...) — Arcium-encrypted {slot, secret, minutes}>" }
-> { "session_id": "<opaque string>", "client_ip": "10.8.0.X/32", "dns": "10.8.0.1", "expires_at": <unix s> }
```
The NODE submits reserve (node pays the fee, so the user's deposit wallet never touches reserve), waits for {ok, minutes},
then adds the WG peer, expiry = reserved minutes. Takes a few seconds. Errors: 402 reserve failed, 409 same input reused.

### POST /session/:id/voucher
```json
{ "voucher": "<base64 Arcium-encrypted voucher>", "minutes": <cumulative int>, "counter": <int> }
-> { "ok": true, "expires_at": <unix s> }
```
Sent every minute with minutes = elapsed whole minutes + 1; each replaces the previous.
Errors: 402 if minutes < floor(elapsed_s/60), 409 stale counter, 404 unknown/ended session. Peer removed when no voucher arrives for 90 s or reserve runs out.
Node submits `redeem(latest voucher)` when the session ends.

## Ledger (owned by ledger/, client API in ledger/README.md; TS package is @anchor-lang/core)
- Token price: 1 minute = 10_000 USDC base units ($0.01). Devnet USDC mint configurable.
- 16 slots (Arcium callback size limit) — anonymity set is 16. User picks a random slot and a random nonzero u64 secret.
- deposit(amount, Enc(slot, secret)) -> ok=false means slot taken, funds refunded; retry another slot.
- makeReserveInput(mxeKey, {slot, secret, minutes}) -> base64 (client); submitReserve(program, inputB64, nodeId) -> {reserveTx, ok, minutes} (node signs)
- reserve(Enc(slot, secret, minutes), node_id) -> public {ok, minutes} in the Reservation account named in the reserve tx (verifyReserve); lands a few seconds after the tx. One open reservation per slot; max 65_535 minutes.
- redeem(Enc voucher {slot, secret, total_minutes, counter, node_id}); signer = node authority. Counter strictly increases per slot for the slot's whole lifetime.
- settle() reveals cumulative per-node totals; claim(node_id) pays the difference: 88% node, 12% treasury.
- register_node(endpoint, tee 0 mock/1 tdx/2 sev-snp, expected_measurement[48]) -> node_id; signer = node authority (payout address)
- Privacy: reserve and redeem are submitted by the node, never the user's wallet.
- Devnet: program id, config, mint, MXE key in ledger/devnet.json (written by the deploy). Token = our own devnet test mint (6 decimals), not Circle USDC.

## WireGuard
Client AllowedIPs = 0.0.0.0/0, ::/0 (tunnel is IPv4-only; this blackholes IPv6 instead of leaking it).
Subnet 10.8.0.0/24, node 10.8.0.1 (also DNS resolver), UDP 51820.

## Measurement (see node/README.md)
NodeRegistry.expected_measurement (48 raw bytes, compared bytewise):
- TDX: SHA-384(MRTD || RTMR3). Quote v4 offsets: MRTD [184..232), RTMR3 [520..568), REPORTDATA [568..632), TDATTRIBUTES [168..176) bit 0 must be 0.
  Expected RTMR3 = output of `node node/deploy/expected-rtmr3.ts` on the trusted commit (hashes the single bundle node/dist/main.cjs, built with esbuild 0.28.2).
- SNP (fallback, firmware only): SHA-384(MEASUREMENT [0x90..0xC0)); reject if POLICY (0x08) bit 19 set.
Gap: root on the VM can still run other code after measurement; locked image is future work.
