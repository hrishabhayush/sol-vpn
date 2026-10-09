# sol-vpn app (macOS menu bar, Tauri v2)

Prereqs: `brew install wireguard-tools` (wg-quick, run via an admin prompt on connect), Rust, Node 24, pnpm.

```sh
pnpm install
pnpm mock-node                     # node/ daemon in --mock mode on :8443 (separate terminal)
SOLVPN_DRY_RUN=1 pnpm tauri dev    # dry run: writes the wg config, skips `wg-quick up`
pnpm tauri dev                     # real: prompts for admin and brings the tunnel up
cd src-tauri && cargo test -- --include-ignored   # ignored tests need the mock node running
```

- Tray icon only (no Dock icon); click it to open the popover, it hides on blur.
- Secrets (wallet keypair + ledger slot secret) live in one Keychain item `sol-vpn`/`secrets` in release builds, read once per launch. Debug builds use `~/.sol-vpn-dev-secrets` (0600) to avoid Keychain prompts on every rebuild.
- WireGuard config: `~/Library/Application Support/com.solvpn.app/solvpn.conf` (0600, deleted on disconnect).
- TDX collateral comes from `PCCS_URL` (default Phala PCCS); SNP VCEK from AMD KDS.
- Ledger: `src/ledger.ts` talks to the devnet program via `../ledger/client` and `../ledger/devnet.json` (rpc, mint, program). Txs are signed in Rust (`sign`); Node builtins are shimmed in `src/node-shim.ts`/`src/anchor-shim.ts` (vite.config.ts aliases).
- Nodes, endpoints, TEE type and expected measurement come from NodeRegistry. `tee:"mock"` is only accepted in debug builds.
- Balances are encrypted on-chain, so the app keeps `{slot, counter, minutes}` in `state-<wallet>.json` next to the wg config. Deleting it loses the slot; don't.

## Devnet funding (once per wallet)
Top up screen shows the app wallet address (debug and release builds have different wallets).
```sh
solana airdrop 1 <wallet> -u devnet          # SOL for deposit tx fees (or https://faucet.solana.com)
cd ../ledger && node scripts/mint-test-tokens.ts <wallet> 5   # test tokens (mint in ledger/devnet.json, 6 decimals)
```
Then Top up -> amount -> Deposit (1 token = 100 minutes; MPC takes ~a minute). The QR is a Solana Pay request for the same test mint.

## Live node checks
```sh
cd src-tauri && cargo test live_tdx -- --ignored --nocapture   # real TDX quote via dcap-qvl; tampered measurement refused
EXPECTED_MEASUREMENT=<hex> cargo test live_tdx -- --ignored     # after a node redeploy
```

## Real tunnel test
1. `pnpm tauri dev`, click the tray icon, pick the node, Connect, enter the admin password for wg-quick.
2. `curl ifconfig.me` should print the node IP; https://ipleak.net should show the node IP, its DNS, and no IPv6.
3. Disconnect; `curl ifconfig.me` is your own IP again.
