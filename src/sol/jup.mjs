// Jupiter: swap quotes and transactions, and the token API (search, trending, recent launches, prices).
//   JUP_API (default https://lite-api.jup.ag, free and rate limited) · JUP_API_KEY for api.jup.ag paid tiers
import { MOCK, mockJup } from "./mock.mjs";

const BASE = (process.env.JUP_API || "https://lite-api.jup.ag").replace(/\/$/, "");
const KEY = process.env.JUP_API_KEY || "";
const headers = (json) => ({ accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...(KEY ? { "x-api-key": KEY } : {}) });

async function call(path, { method = "GET", body, timeout = 15000 } = {}) {
  if (MOCK) return mockJup(path, body);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + path, { method, signal: AbortSignal.timeout(timeout), headers: headers(!!body), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) { lastErr = new Error("Jupiter is rate limiting, try again in a moment"); await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.error) {
      if (/instead of the user/.test(j?.error || "")) throw new Error("One of this wallet's token accounts now belongs to another owner (its authority was changed), so Jupiter cannot route through it. Use a different wallet.");
      throw new Error(j?.error ? `Jupiter: ${j.error}` : `Jupiter returned ${res.status}`);
    }
    return j;
  }
  throw lastErr;
}

const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ms) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) for (const [k, x] of cache) if (Date.now() - x.t > 120_000) cache.delete(k);
  return v;
}

/** quote({ inMint, outMint, amount (bigint), slippageBps }) → Jupiter quoteResponse */
export async function quote({ inMint, outMint, amount, slippageBps = 100, excludeDexes = [] }) {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: BigInt(amount).toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  if (excludeDexes.length) qs.set("excludeDexes", excludeDexes.join(","));
  const q = await cached(`q:${qs}`, 10_000, () => call(`/swap/v1/quote?${qs}`));
  if (!q?.outAmount || BigInt(q.outAmount) <= 0n) throw new Error("Jupiter found no route");
  return q;
}

/** buildSwap({ quoteResponse, user }) → { swapTransaction (base64), lastValidBlockHeight, simulationError } */
export async function buildSwap({ quoteResponse, user }) {
  return call("/swap/v1/swap", {
    method: "POST", timeout: 20000,
    body: {
      quoteResponse, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
    },
  });
}

/** searchTokens([mint…] | "query") → Jupiter token records (max 100 mints per call) */
export async function searchTokens(q) {
  const query = Array.isArray(q) ? q.slice(0, 100).join(",") : String(q);
  return cached(`s:${query}`, 60_000, () => call(`/tokens/v2/search?query=${encodeURIComponent(query)}`));
}
export const trendingTokens = (interval = "1h", limit = 30) => cached(`t:${interval}:${limit}`, 30_000, () => call(`/tokens/v2/toptrending/${interval}?limit=${limit}`));
export const recentTokens = (limit = 30) => cached(`r:${limit}`, 15_000, () => call(`/tokens/v2/recent?limit=${limit}`));
export const prices = (mints) => cached(`p:${mints.join(",")}`, 15_000, () => call(`/price/v3?ids=${mints.slice(0, 50).join(",")}`));
