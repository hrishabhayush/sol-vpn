# sol-vpn protocol (shared contract between app/, node/, ledger/)

Change this file only together with every side that depends on it.

## Layout
- `ledger/`  Anchor + Arcium program (vault, NodeRegistry, encrypted ledger) + `ledger/client` TS helpers
- `node/`    TypeScript (Node 24) daemon running in a TDX/SEV-SNP VM
- `app/`     Tauri v2 macOS menu bar app (Rust backend, TS frontend)

## Node HTTP API (port 8443, plain HTTP — not TLS; the attested WG key is the binding)

`node_id` = the node's index in NodeRegistry (u8, 0..N-1). Each node also has a Solana keypair (its authority: registers, submits redeem, receives payouts).
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
{ "client_wg_pubkey": "<base64>", "reserve_tx": "<solana tx signature of reserve()>" }
-> { "session_id": "<opaque string>", "client_ip": "10.8.0.X/32", "dns": "10.8.0.1", "expires_at": <unix s> }
```
Node checks the reserve result for this node on-chain ({ok, minutes}), adds the WG peer, expiry = reserved minutes.
Errors: 402 reserve failed, 409 reserve_tx already used.

### POST /session/:id/voucher
```json
{ "voucher": "<base64 Arcium-encrypted voucher>", "minutes": <cumulative int>, "counter": <int> }
-> { "ok": true, "expires_at": <unix s> }
```
Sent every minute with minutes = elapsed whole minutes + 1; each replaces the previous.
Errors: 402 if minutes < floor(elapsed_s/60), 409 stale counter, 404 unknown/ended session. Peer removed when no voucher arrives for 90 s or reserve runs out.
Node submits `redeem(latest voucher)` when the session ends.

## Ledger (owned by ledger/, see docs/ledger.md once written)
- Token price: 1 minute = 10_000 USDC base units ($0.01). Devnet USDC mint configurable.
- deposit(amount, Enc(slot, secret))
- reserve(Enc(slot, secret, minutes), node_id) -> public {ok: bool, minutes: u32}, readable by the node from the reserve tx
- redeem(Enc voucher {slot, secret, total_minutes, counter, node_id}) -> refund rest of reserve to slot
- settle() -> reveal per-node totals, pay vault -> nodes, fee 12% -> treasury
- register_node(endpoint, tee, expected_measurement[48]) -> node_id; signer = node authority (payout address)

## WireGuard
Client AllowedIPs = 0.0.0.0/0, ::/0 (tunnel is IPv4-only; this blackholes IPv6 instead of leaking it).
Subnet 10.8.0.0/24, node 10.8.0.1 (also DNS resolver), UDP 51820.

## Measurement (see node/README.md)
TDX: MRTD (quote bytes 184..232); SNP: MEASUREMENT (report 0x90..0xC0). Reject debug guests.
MRTD covers firmware only, not the daemon. Daemon binding via RTMR3 needs kernel >= 6.16 — open decision.
