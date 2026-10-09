# sol-vpn node daemon

TypeScript on Node 24 (native type stripping, zero deps). API in `../docs/protocol.md`.

## Local (macOS, mock mode)

```sh
cd node
node src/main.ts --mock     # :8443, tee:"mock", wg/ip commands are logged, not run
node test.ts                # end-to-end check against a mock instance
```

Mock `/attest` returns `report` = the raw 64-byte `report_data`, so debug builds can still check the
SHA-512(wg_pubkey || nonce) binding. Mock ledger (`src/ledger.ts`): any reserve_tx is valid for
`MOCK_RESERVE_MINUTES` (default 60) except ones starting with `xxx`.

Env: `PORT` (8443), `NODE_ENDPOINT` (`<public ip>:51820`), `NODE_ID` (NodeRegistry index u8, mock default 0),
`NODE_KEYPAIR` (path to the Solana authority keypair that signs redeem), `VOUCHER_TIMEOUT_S` (90).
Required outside mock: `NODE_ENDPOINT`, `NODE_ID`, `NODE_KEYPAIR`.

## Deploy to a GCP confidential VM (not executed; costs money)

Intel TDX (preferred). `c3-standard-4` is the smallest C3; check zone support in GCP docs.

```sh
gcloud compute firewall-rules create sol-vpn-node \
  --allow=udp:51820,tcp:8443 --target-tags=sol-vpn-node

gcloud compute instances create sol-vpn-node-1 \
  --zone=us-central1-a \
  --machine-type=c3-standard-4 \
  --confidential-compute-type=TDX \
  --maintenance-policy=TERMINATE \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --tags=sol-vpn-node \
  --metadata=node-id=0 \
  --metadata-from-file=startup-script=node/deploy/startup.sh

# then ship the code + the node's Solana authority keypair (signs redeem) and start it:
gcloud compute scp --zone=us-central1-a --recurse node sol-vpn-node-1:/tmp/node
gcloud compute scp --zone=us-central1-a node-keypair.json sol-vpn-node-1:/tmp/node/node-keypair.json
gcloud compute ssh --zone=us-central1-a sol-vpn-node-1 -- \
  'sudo mkdir -p /opt/sol-vpn && sudo rm -rf /opt/sol-vpn/node && sudo mv /tmp/node/node-keypair.json /opt/sol-vpn/ && sudo chmod 600 /opt/sol-vpn/node-keypair.json && sudo mv /tmp/node /opt/sol-vpn/ && sudo systemctl restart sol-vpn-node'
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

`NodeRegistry.expected_measurement`:
- TDX: `MRTD` (48 B). Also reject if `TDATTRIBUTES` bit 0 (DEBUG) is set.
- SNP: `MEASUREMENT` (48 B). Also reject if `POLICY` bit 19 (DEBUG) is set.

Get the value by booting once and reading it from a quote (or from Google's signed firmware
endorsements, see google/gce-tcb-verifier). It changes when Google updates firmware, and on SNP it
also depends on the vCPU count, so re-register when that happens.

What it covers: only Google's virtual firmware (TDVF/OVMF). It proves "a real TDX/SNP VM on GCP
firmware, holding this WG key in its memory". It does **not** cover the kernel, the disk image, this
daemon or the operator's SSH access. The operator could run a logging daemon and the quote would
still pass. On TDX, `RTMR0..2` add firmware config, bootloader, kernel and cmdline. SNP on GCP has no
hardware-rooted measurement past the firmware.

Smallest hackathon-feasible way to bind the daemon (TDX only, not implemented):
1. Use a kernel >= 6.16 (e.g. an Ubuntu 25.10 image, if it is TDX_CAPABLE). It exposes
   `/sys/devices/virtual/misc/tdx_guest/measurements/rtmr3:sha384`; writing 48 bytes extends RTMR3.
2. In the systemd unit, before starting, run `ExecStartPre` that writes
   `sha384(tar of /opt/sol-vpn/node)` into it.
3. The app checks `RTMR3 == SHA384(0^48 || that hash)` along with MRTD, plus RTMR1/RTMR2 against values
   from a reference boot.
It's still only honest if root can't extend RTMR3 with the good hash and then run other code. Closing
that needs an immutable image (dm-verity rootfs or a UKI with the daemon in the initrd, no SSH, all
measured into RTMR1/2), which is post-hackathon work.

## No-log

The daemon logs only session counts and redeem results. The startup script turns off unbound query
logging. iptables has no LOG rules. Client↔client traffic and access to the metadata server
(169.254.169.254) are dropped.
