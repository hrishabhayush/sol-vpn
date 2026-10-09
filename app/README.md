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
- `src/ledger.ts` is a mock until ledger/client lands. `tee:"mock"` is only accepted in debug builds.
