// KyberSwap aggregator: routes and calldata for Robinhood Chain, Base, Arbitrum and Ethereum.
// Calldata is only ever built on the server from a fresh route, and only for the known router.
import { CHAINS, chainKey, NATIVE } from "./chains.mjs";
import { MOCK, mockBuild, mockRoute } from "./mock.mjs";

const BASE = "https://aggregator-api.kyberswap.com";
const CLIENT = process.env.KYBER_CLIENT_ID || "quill";
const ROUTERS = new Set(
  String(process.env.KYBER_ROUTERS || "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
);

// Kyber refuses bursts, and one Checkpoint run makes several calls: send one at a time with a short gap, back off on 403/429.
const GAP_MS = Math.max(100, Number(process.env.KYBER_GAP_MS) || 400);
let queue = Promise.resolve(), last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slot() {
  const turn = queue.then(async () => { const w = last + GAP_MS - Date.now(); if (w > 0) await sleep(w); last = Date.now(); });
  queue = turn.catch(() => {});
  return turn;
}

async function call(chain, path, { method = "GET", body } = {}) {
  const slug = CHAINS[chainKey(chain)].kyberSlug;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    await slot();
    const res = await fetch(`${BASE}/${slug}/api/v1/${path}`, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json", "x-client-id": CLIENT, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 403 || res.status === 429) { lastErr = new Error("KyberSwap is busy, try again in a moment"); await sleep(800 * 2 ** attempt); continue; }
    const j = await res.json().catch(() => null);
    if (!j) throw new Error(`KyberSwap returned ${res.status}`);
    if (!res.ok || String(j.code) !== "0" || !j.data) throw new Error(j.message ? `KyberSwap: ${j.message}` : `KyberSwap returned ${res.status}`);
    return j.data;
  }
  throw lastErr;
}

const CACHE = new Map(), CACHE_MS = 15_000;

/** route({ chain, tokenIn, tokenOut, amountIn }) — token objects from resolveToken, amountIn in base units (bigint). */
export async function route({ chain, tokenIn, tokenOut, amountIn }) {
  const key = `${chainKey(chain)}:${tokenIn.address}:${tokenOut.address}:${amountIn}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  let d;
  if (MOCK) d = mockRoute(CHAINS[chainKey(chain)].tokens, tokenIn.address, tokenOut.address, amountIn, tokenIn.decimals, tokenOut.decimals);
  else {
    const qs = new URLSearchParams({ tokenIn: tokenIn.address || NATIVE, tokenOut: tokenOut.address || NATIVE, amountIn: BigInt(amountIn).toString(), gasInclude: "true" });
    d = await call(chain, `routes?${qs}`);
  }
  const rs = d.routeSummary;
  if (!rs?.amountOut || BigInt(rs.amountOut) <= 0n) throw new Error("KyberSwap found no route");
  const router = d.routerAddress || rs.routerAddress;
  if (!ROUTERS.has(String(router).toLowerCase())) throw new Error("KyberSwap answered with an unknown router, so the route was not used");
  const v = {
    routeSummary: rs,
    router,
    amountOut: BigInt(rs.amountOut),
    inUsd: Number(rs.amountInUsd) || null,
    outUsd: Number(rs.amountOutUsd) || null,
    gasUsd: Number(rs.gasUsd) || null,
    exchanges: [...new Set((rs.route || []).flat().map((s) => s.exchange))],
  };
  CACHE.set(key, { t: Date.now(), v });
  if (CACHE.size > 300) for (const [k, x] of CACHE) if (Date.now() - x.t > CACHE_MS) CACHE.delete(k);
  return v;
}

/** build({ chain, quote, sender, slippageBps }) → { to, data, value, minOut } */
export async function build({ chain, quote, sender, slippageBps }) {
  const bps = Math.max(1, Math.min(500, Math.round(slippageBps)));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const d = MOCK
    ? mockBuild(quote.routeSummary, sender, bps)
    : await call(chain, "route/build", {
        method: "POST",
        body: { routeSummary: quote.routeSummary, sender, recipient: sender, slippageTolerance: bps, deadline, source: CLIENT, enableGasEstimation: false },
      });
  const to = d.routerAddress || quote.router;
  if (String(to).toLowerCase() !== String(quote.router).toLowerCase() || !ROUTERS.has(String(to).toLowerCase())) {
    throw new Error("KyberSwap built the swap for a different router, so it was not used");
  }
  if (!/^0x[0-9a-f]+$/i.test(d.data || "")) throw new Error("KyberSwap returned no calldata");
  const minOut = (quote.amountOut * BigInt(10000 - bps)) / 10000n;
  return { to, data: d.data, value: BigInt(d.transactionValue || 0), minOut };
}
