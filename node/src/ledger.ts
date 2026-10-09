// Ledger boundary. Mock for now; swap bodies for ledger/client calls once it exists.
// Never log arguments here: reserve_tx / vouchers link a payer to a session.

// nodeId = this node's NodeRegistry index (u8). The real impl signs redeem with the Solana keypair
// at NODE_KEYPAIR (node authority); the mock ignores it.
export const NODE_KEYPAIR = process.env.NODE_KEYPAIR;

// Reads reserve()'s public {ok, minutes} for this node from the reserve tx.
export async function verifyReserve(reserveTx: string, nodeId: number): Promise<{ ok: boolean; minutes: number }> {
  void nodeId;
  if (reserveTx.startsWith('xxx')) return { ok: false, minutes: 0 };
  return { ok: true, minutes: Number(process.env.MOCK_RESERVE_MINUTES ?? 60) };
}

// Submits redeem(latest voucher). Returns the tx signature.
export async function redeem(voucher: string, nodeId: number): Promise<string> {
  void voucher, nodeId;
  return 'mock-redeem-tx';
}
