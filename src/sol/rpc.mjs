// Solana JSON-RPC. SOLANA_RPC picks the endpoint (a private RPC is recommended in production; public ones rate-limit).
import { MOCK, mockRpc } from "./mock.mjs";

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
let id = 0;

export async function rpc(method, params = []) {
  if (MOCK) return mockRpc(method, params);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(RPC, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (res.status === 429) { lastErr = new Error("Solana RPC is busy, try again in a moment"); await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
    const j = await res.json().catch(() => ({}));
    if (j.error) throw Object.assign(new Error(j.error.message || "Solana RPC error"), { rpc: j.error });
    if (!res.ok) throw new Error(`Solana RPC returned ${res.status}`);
    return j.result;
  }
  throw lastErr;
}

/** simulate(base64Tx) → { ok, error, units, logs } (signature not checked, blockhash refreshed) */
export async function simulate(tx) {
  const r = await rpc("simulateTransaction", [tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
  const v = r?.value || {};
  return { ok: !v.err, error: v.err ? JSON.stringify(v.err) : null, units: v.unitsConsumed ?? null, logs: (v.logs || []).slice(-6) };
}

/** balance(owner, mint) → raw amount (bigint) of SOL (lamports) or of an SPL token across the owner's accounts */
export async function balance(owner, mint, solMint) {
  if (mint === solMint) return BigInt((await rpc("getBalance", [owner])).value);
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  return (r?.value || []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}
