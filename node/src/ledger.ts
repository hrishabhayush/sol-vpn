// Ledger boundary: ledger/client on Solana, or a mock with --mock.
// Never log arguments here: reserve inputs / vouchers link a payer to a session.
import fs from 'node:fs';

// Path to the node authority's Solana keypair: signs + pays reserve and redeem, receives payouts.
export const NODE_KEYPAIR = process.env.NODE_KEYPAIR;
const MOCK = process.argv.includes('--mock');

// Real ledger, loaded lazily so mock mode stays zero-dep. Bundled with ledger/client by `npm run build`.
// Config (programId, rpc) is ledger/devnet.json baked into the bundle (so it's measured), or LEDGER_CONFIG at runtime.
let real: Promise<{ client: typeof import('../../ledger/client/index.ts'); program: any }> | undefined;
const ledger = () => real ??= (async () => {
  const [anchor, web3, client, baked] = await Promise.all([
    import('@anchor-lang/core'), import('@solana/web3.js'),
    import('../../ledger/client/index.ts'), import('../../ledger/devnet.json', { with: { type: 'json' } }),
  ]);
  const cfg = process.env.LEDGER_CONFIG ? JSON.parse(fs.readFileSync(process.env.LEDGER_CONFIG, 'utf8')) : baked.default;
  const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(NODE_KEYPAIR!, 'utf8'))));
  const provider = new anchor.AnchorProvider(new web3.Connection(cfg.rpc, 'confirmed'), new anchor.Wallet(kp), { commitment: 'confirmed' });
  const base = client.ledgerProgram(provider);
  return { client, program: new anchor.Program({ ...base.idl, address: cfg.programId }, provider) };
})();

// Submits reserve(input) for this node (node signs and pays) and waits for the public {ok, minutes}.
export async function submitReserve(input: string, nodeId: number): Promise<{ ok: boolean; minutes: number }> {
  if (MOCK) return input.startsWith('xxx') ? { ok: false, minutes: 0 } : { ok: true, minutes: Number(process.env.MOCK_RESERVE_MINUTES ?? 60) };
  const { client, program } = await ledger();
  const r = await client.submitReserve(program, input, nodeId);
  return { ok: r.ok, minutes: r.minutes };
}

// Submits redeem(latest voucher), signed by the node authority. Throws if the tx fails (caller retries);
// returns false if the ledger rejected the voucher (retrying can't help).
export async function redeem(voucher: string, nodeId: number): Promise<boolean> {
  if (MOCK) return true;
  const { client, program } = await ledger();
  return (await client.redeem(program, voucher, nodeId)).ok;
}
