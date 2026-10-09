// Stub for ledger/client (TS + @arcium-hq/client, written by the ledger/ agent).
// ponytail: mock implementation; swap each body for the ledger/client call once it lands.

export type Node = { id: number; name: string; url: string; expectedMeasurement: string };

/** NodeRegistry accounts. */
export async function listNodes(): Promise<Node[]> {
  return [
    // node/ in --mock mode (tee "mock" has no measurement; real nodes: hex of SHA-384(MRTD || RTMR3) on TDX, SHA-384(MEASUREMENT) on SNP)
    { id: 0, name: "Mock node (localhost)", url: "http://127.0.0.1:8443", expectedMeasurement: "00".repeat(48) },
    { id: 1, name: "Offline node (refusal demo)", url: "http://127.0.0.1:8444", expectedMeasurement: "00".repeat(48) },
  ];
}

/** Prepaid minutes in this user's encrypted slot. */
export async function minutesLeft(_slotSecret: string): Promise<number> {
  return 120;
}

/** reserve(Enc(slot, secret, minutes), node_id) -> tx signature. */
export async function reserve(_slotSecret: string, _nodeId: number, _minutes: number): Promise<string> {
  const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from(crypto.getRandomValues(new Uint8Array(88)), (b) => b58[b % 58]).join(""); // signature-shaped
}

/** Arcium-encrypted voucher {slot, secret, total_minutes, counter, node_id}, base64. */
export async function makeVoucher(slotSecret: string, nodeId: number, totalMinutes: number, counter: number): Promise<string> {
  return btoa(JSON.stringify({ mock: true, slot: slotSecret.slice(0, 8), nodeId, totalMinutes, counter }));
}
