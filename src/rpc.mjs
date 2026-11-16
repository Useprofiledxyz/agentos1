// Minimal JSON-RPC client plus the few ERC-20 reads AgentOS needs. No ethers/viem: calls are hand-encoded.
import { CHAINS, chainKey, isAddress, isNative, knownToken, NATIVE } from "./chains.mjs";
import { MOCK, mockRpc } from "./mock.mjs";

let rpcId = 0;
export async function rpc(chain, method, params = []) {
  const key = chainKey(chain);
  if (MOCK) return mockRpc(key, method, params);
  const res = await fetch(CHAINS[key].rpc, {
    method: "POST",
    signal: AbortSignal.timeout(12000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error) {
    const e = new Error(j.error.message || "RPC error");
    e.rpc = j.error;
    throw e;
  }
  if (!res.ok) throw new Error(`RPC ${CHAINS[key].name} returned ${res.status}`);
  return j.result;
}

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const SEL = { decimals: "0x313ce567", symbol: "0x95d89b41", allowance: "0xdd62ed3e", approve: "0x095ea7b3", balanceOf: "0x70a08231" };

export const encodeApprove = (spender, amount) => SEL.approve + pad(spender) + pad(BigInt(amount).toString(16));

function decodeString(hex) {
  const h = String(hex || "").replace(/^0x/, "");
  if (h.length === 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, ""); // bytes32 symbols
  if (h.length < 128) return "";
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}

const tokenCache = new Map();
/** resolveToken(chain, "USDC" | "0x…") → { symbol, address, decimals } (reads unknown tokens from the chain). */
export async function resolveToken(chain, ref) {
  const k = knownToken(chain, ref);
  if (k) return k;
  if (!isAddress(ref)) throw new Error(`Unknown token "${ref}" on ${CHAINS[chainKey(chain)].name}. Use a known symbol or a contract address.`);
  const cacheKey = `${chainKey(chain)}:${ref.toLowerCase()}`;
  if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey);
  const code = await rpc(chain, "eth_getCode", [ref, "latest"]);
  if (!code || code === "0x") throw new Error(`${ref} has no contract code on ${CHAINS[chainKey(chain)].name}`);
  const [dec, sym] = await Promise.all([
    rpc(chain, "eth_call", [{ to: ref, data: SEL.decimals }, "latest"]),
    rpc(chain, "eth_call", [{ to: ref, data: SEL.symbol }, "latest"]).catch(() => "0x"),
  ]);
  const decimals = Number(BigInt(dec));
  if (!(decimals >= 0 && decimals <= 36)) throw new Error(`${ref} does not look like an ERC-20 (decimals ${decimals})`);
  const t = { symbol: decodeString(sym) || ref.slice(0, 8), address: ref, decimals };
  tokenCache.set(cacheKey, t);
  return t;
}

export async function allowance(chain, token, owner, spender) {
  if (isNative(token)) return 2n ** 256n - 1n;
  const r = await rpc(chain, "eth_call", [{ to: token, data: SEL.allowance + pad(owner) + pad(spender) }, "latest"]);
  return BigInt(r || "0x0");
}

export async function balanceOf(chain, token, owner) {
  if (isNative(token)) return BigInt(await rpc(chain, "eth_getBalance", [owner, "latest"]));
  return BigInt((await rpc(chain, "eth_call", [{ to: token, data: SEL.balanceOf + pad(owner) }, "latest"])) || "0x0");
}

/** simulate(chain, tx) → { ok, error } via eth_call against the latest block. */
export async function simulate(chain, { from, to, data, value }) {
  try {
    await rpc(chain, "eth_call", [{ from, to, data, value: "0x" + BigInt(value || 0).toString(16) }, "latest"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

export { NATIVE };
