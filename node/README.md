# sol-vpn node daemon

TypeScript on Node 24 (native type stripping). API in `../docs/protocol.md`. Mock mode has zero deps; the real
ledger (`src/ledger.ts` -> `../ledger/client`) is bundled with esbuild into one file, `dist/main.cjs`.

## Local (macOS, mock mode)

```sh
cd node
node src/main.ts --mock     # :8443, tee:"mock", wg/ip commands are logged, not run
node test.ts                # end-to-end check against a mock instance
```

Mock `/attest` returns `report` = the raw 64-byte `report_data`, so debug builds can still check the
SHA-512(wg_pubkey || nonce) binding. Mock ledger (`src/ledger.ts`): any reserve input is valid for
`MOCK_RESERVE_MINUTES` (default 60) except ones starting with `xxx`.

## Real ledger

```sh
(cd ../ledger && yarn install --frozen-lockfile)   # deps come from ledger/node_modules
npm run build                                      # -> dist/main.cjs (src + ledger/client + deps + ledger/devnet.json)
NODE_KEYPAIR=node-keypair.json NODE_ID=0 NODE_ENDPOINT=<ip>:51820 node dist/main.cjs   # Linux, root (wg/ip)
```

POST /session submits `reserve` with the node keypair (it pays the fee) and waits for `{ok, minutes}`;
ended sessions are redeemed with the same keypair (failed txs are retried every second).
rpc/programId come from `ledger/devnet.json`, baked into the bundle at build time (so it is measured);
`LEDGER_CONFIG=<path>` overrides it at runtime (unmeasured, for localnet testing only).

Env: `PORT` (8443), `NODE_ENDPOINT` (`<public ip>:51820`), `NODE_ID` (NodeRegistry index u8, mock default 0),
`NODE_KEYPAIR` (path to the Solana authority keypair that signs and pays reserve + redeem), `VOUCHER_TIMEOUT_S` (90).
Required outside mock: `NODE_ENDPOINT`, `NODE_ID`, `NODE_KEYPAIR`.

## Deploy to a GCP confidential VM (not executed; costs money)

Intel TDX (preferred). `c3-standard-4` is the smallest C3; check zone support in GCP docs.

Image: the daemon is measured into RTMR3, which needs Linux >= 6.16 (TDX RTMR sysfs). Use Ubuntu 26.04
(kernel 7.0) if GCP marks it TDX-capable. I could not confirm that from GCP docs (their TDX list only
names ubuntu-2204, COS, CentOS Stream, Fedora CoreOS, AlmaLinux), so check before creating:
`gcloud compute images describe-from-family ubuntu-2604-lts-amd64 --project=ubuntu-os-cloud --format="value(guestOsFeatures)"`
must contain `TDX_CAPABLE`. If not, use `ubuntu-2404-lts-amd64` and check `uname -r` >= 6.16 on the VM.
If the kernel is older, the startup script refuses to start the daemon; to fall back to MRTD-only,
delete the `--extend` line in `deploy/startup.sh` and have the app skip the RTMR3 check.

```sh
gcloud compute firewall-rules create sol-vpn-node \
  --allow=udp:51820,tcp:8443 --target-tags=sol-vpn-node

gcloud compute instances create sol-vpn-node-1 \
  --zone=us-central1-a \
  --machine-type=c3-standard-4 \
  --confidential-compute-type=TDX \
  --maintenance-policy=TERMINATE \
  --image-family=ubuntu-2604-lts-amd64 --image-project=ubuntu-os-cloud \
  --tags=sol-vpn-node \
  --metadata=node-id=0 \
  --metadata-from-file=startup-script=node/deploy/startup.sh

# then build, ship the bundle + measuring script + the node's Solana authority keypair, and reboot.
# The startup script measures dist/main.cjs into RTMR3 and starts it. After any code change, rebuild and
# reboot (RTMR3 resets to zero only on boot). If startup.sh changed, push it first:
#   gcloud compute instances add-metadata sol-vpn-node-1 --zone=us-central1-a --metadata-from-file=startup-script=node/deploy/startup.sh
(cd node && npm run build && node deploy/expected-rtmr3.ts)
gcloud compute ssh --quiet --zone=us-central1-a sol-vpn-node-1 -- 'rm -rf /tmp/node && mkdir -p /tmp/node/dist /tmp/node/deploy'
gcloud compute scp --quiet --zone=us-central1-a node/dist/main.cjs sol-vpn-node-1:/tmp/node/dist/
gcloud compute scp --quiet --zone=us-central1-a node/deploy/expected-rtmr3.ts sol-vpn-node-1:/tmp/node/deploy/
gcloud compute scp --quiet --zone=us-central1-a node/node-keypair.json sol-vpn-node-1:/tmp/node-keypair.json
gcloud compute ssh --quiet --zone=us-central1-a sol-vpn-node-1 -- \
  'sudo mkdir -p /opt/sol-vpn && sudo rm -rf /opt/sol-vpn/node && sudo mv /tmp/node-keypair.json /opt/sol-vpn/ && sudo chmod 600 /opt/sol-vpn/node-keypair.json && sudo mv /tmp/node /opt/sol-vpn/ && sudo chown -R root:root /opt/sol-vpn && sudo systemctl reboot'
```

AMD SEV-SNP alternative: replace the machine/confidential flags with
`--machine-type=n2d-standard-2 --min-cpu-platform="AMD Milan" --confidential-compute-type=SEV_SNP`
(zones: us-central1-a/b/c, europe-west3/4, asia-southeast1). Confirm the image is SNP-capable first:
`gcloud compute images list --filter="guestOsFeatures[].type:(SEV_SNP_CAPABLE)" | grep ubuntu`.
Do not use Debian 12 (no SNP attestation per GCP docs).

Check on the VM: `sudo journalctl -u sol-vpn-node`, `curl "localhost:8443/attest?nonce=$(openssl rand -hex 32)"`.

## Attestation

`/attest` writes `report_data` to configfs-tsm (`/sys/kernel/config/tsm/report/<tmp>/inblob`), reads
`outblob` and `provider` (`tdx_guest` -> `tdx`, `sev_guest` -> `sev-snp`). configfs-tsm landed in
Linux 6.7 for both TDX and SNP; Ubuntu 24.04 ships 6.8+. On GCP Ubuntu `tdx_guest` is in
`linux-modules-extra-*`, which the startup script installs. TDX quotes need the host quote service,
which GCP provides (it's what go-tdx-guest uses there).

- TDX `report` = Quote v4: `REPORTDATA` at byte 568 (64 B), `MRTD` at 184, `RTMR0..3` at 376/424/472/520 (48 B each),
  `TDATTRIBUTES` at 168 (8 B).
- SNP `report` = 1184-byte attestation report: `REPORT_DATA` at 0x50, `MEASUREMENT` at 0x90 (48 B), `POLICY` at 0x08.
  Fetch the VCEK chain from AMD KDS (or the configfs `auxblob`, if GCP fills it; not done here).

## Measurement: what the app should compare

TDX (Quote v4, byte offsets into the raw quote, 48 B each unless noted):
- `MRTD` [184..232) == the registered firmware value.
- `RTMR3` [520..568) == output of `npm run build && node deploy/expected-rtmr3.ts` in `node/`, on a clean
  checkout of the commit you trust with `ledger/` deps installed from `yarn.lock` (`yarn install --frozen-lockfile`).
  The bundle pins esbuild 0.28.2; it changes with any edit to `src/`, `ledger/client`, `ledger/devnet.json` or `ledger/yarn.lock`.
- `REPORTDATA` [568..632) (64 B) == SHA-512(wg_pubkey || nonce).
- `TDATTRIBUTES` [168..176) bit 0 (DEBUG) must be 0.

How RTMR3 is computed:
- `digest` = SHA-384(`"dist/main.cjs\n<sha384 hex of dist/main.cjs>\n"`). The bundle is the only file systemd runs
  (`node /opt/sol-vpn/node/dist/main.cjs`, no `node_modules`). Not measured: the keypair (secret) and `LEDGER_CONFIG` if set.
- RTMR3 starts at 48 zero bytes on each boot. The startup script extends it once, before starting the
  daemon: RTMR3 = SHA-384(0^48 || digest).
- Mechanism: a 48-byte write to `/sys/devices/virtual/misc/tdx_guest/measurements/rtmr3:sha384`
  (kernel ABI since v6.16: "Write extends the written buffer to the RTMR. All writes must start at
  offset 0 and be 48 bytes in size.").

SNP: `MEASUREMENT` [0x90..0xC0) only, `POLICY` [0x08] bit 19 (DEBUG) must be 0. There are no RTMRs, so
the daemon is not bound.

Get MRTD by booting once and reading it from a quote (or from Google's signed firmware endorsements,
see google/gce-tcb-verifier). It changes when Google updates firmware; SNP MEASUREMENT also depends on
the vCPU count.

What this proves: a genuine TDX VM on Google's firmware holds this WG key, and some process on it
extended RTMR3 with the digest of this exact daemon code, once, this boot.

What it does **not** prove (the remaining gap):
- Root on the VM (the operator, via SSH) can still extend the good digest and then run other code,
  edit the files after measurement, or tap traffic outside the daemon (tcpdump on wg0, iptables LOG).
- The kernel, unbound, the iptables rules and the Node binary are not measured. RTMR1/2 cover the
  kernel/cmdline, but we don't pin them.

Closing the gap needs a locked image: no SSH, a dm-verity rootfs or a UKI holding the daemon, and
pinned RTMR1/2. That is future work.

## No-log

The daemon logs only session counts and redeem results. The startup script turns off unbound query
logging. iptables has no LOG rules. Client↔client traffic and access to the metadata server
(169.254.169.254) are dropped.
