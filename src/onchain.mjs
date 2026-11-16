// Live Solana market data: pools from GeckoTerminal (trending, top volume, new pairs including pump.fun and
// LaunchLab launches), xStocks prices from Jupiter, the latest slot and TPS, and a wallet's balances read from the chain.
// GeckoTerminal's public API allows about 30 calls a minute: calls go through one paced queue and are cached; when a
// call fails the last good copy is served with stale: true.
import { MOCK, MOCK_POOLS } from "./sol/mock.mjs";
import { isSolAddress } from "./sol/base58.mjs";
import { searchTokens } from "./sol/jup.mjs";
import { rpc } from "./sol/rpc.mjs";
import { BASE, EXPLORER, SOL_MINT, STOCKS } from "./sol/tokens.mjs";
import { formatUnits } from "./units.mjs";
import { remember } from "./logos.mjs";

const GECKO = "https://api.geckoterminal.com/api/v2";
const NET = "solana";
const STOCK_MINTS = new Set(STOCKS.map((s) => s.mint));

// ---------- paced, cached GeckoTerminal client ----------
const GAP_MS = Number(process.env.GECKO_GAP_MS) || 2100;
let queue = Promise.resolve(), lastCall = 0;
const cache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** geckoGet(pathQs, ttlMs) → { data, stale } through the shared paced queue (also used by logos.mjs). */
export const geckoGet = (pathQs, ttlMs) => gecko(pathQs, ttlMs);

async function gecko(pathQs, ttlMs = 30_000) {
  const hit = cache.get(pathQs);
  if (hit && Date.now() - hit.t < ttlMs) return { data: hit.v, stale: false };
  if (hit?.pending) return hit.pending;
  const pending = (async () => {
    try {
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        const turn = queue.then(async () => { const w = lastCall + GAP_MS - Date.now(); if (w > 0) await sleep(w); lastCall = Date.now(); });
        queue = turn.catch(() => {});
        await turn;
        res = await fetch(`${GECKO}/${pathQs}`, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
        if (res.status !== 429) break;
        lastCall = Date.now() + 4000 * (attempt + 1); // rate limited: hold the whole queue back, then try again
      }
      if (!res.ok) throw new Error(res.status === 429 ? "GeckoTerminal is rate limiting, try again in a minute" : `GeckoTerminal returned ${res.status}`);
      const v = await res.json();
      cache.set(pathQs, { t: Date.now(), v });
      return { data: v, stale: false };
    } catch (e) {
      if (hit?.v) { cache.set(pathQs, { ...hit, pending: null }); return { data: hit.v, stale: true }; }
      cache.delete(pathQs);
      throw e;
    }
  })();
  cache.set(pathQs, { ...(hit || {}), pending });
  return pending;
}

const num = (x) => (x == null || x === "" ? null : Number(x));
const DEX = {
  "pump-fun": "pump.fun", pumpswap: "PumpSwap", raydium: "Raydium", "raydium-clmm": "Raydium CLMM", "raydium-cp": "Raydium CPMM",
  "raydium-launchlab": "LaunchLab", "meteora": "Meteora", "meteora-dlmm": "Meteora DLMM", "meteora-dbc": "Meteora DBC",
  "meteora-damm-v2": "Meteora DAMM", orca: "Orca", fluxbeam: "FluxBeam", lifinity: "Lifinity", "moonit": "Moonit",
};
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bV(\d)\b/g, "v$1");
const dexName = (id = "") => DEX[id] || (/launchlab/.test(id) ? "LaunchLab" : /^raydium/.test(id) ? "Raydium" : /^meteora/.test(id) ? "Meteora" : /^orca/.test(id) ? "Orca" : titleCase(id.replace(/-solana$/, "").replace(/-/g, " ")));

function normPools(json) {
  const tokens = new Map((json.included || []).filter((x) => x.type === "token").map((x) => [x.id, x.attributes]));
  return (json.data || []).map((p) => {
    const a = p.attributes, base = tokens.get(p.relationships?.base_token?.data?.id) || {};
    const tx = a.transactions?.h24 || {};
    const stock = STOCK_MINTS.has(base.address);
    if (base.address && base.image_url) remember(base.address, base.image_url);
    return {
      pool: a.address, name: a.name, dex: dexName(p.relationships?.dex?.data?.id), dexId: p.relationships?.dex?.data?.id || null,
      token: { address: base.address || null, symbol: base.symbol || a.name?.split(" / ")[0] || "?", name: base.name || null, image: base.image_url || null, stock: !!stock },
      priceUsd: num(a.base_token_price_usd), priceSol: num(a.base_token_price_native_currency),
      change: { m5: num(a.price_change_percentage?.m5), h1: num(a.price_change_percentage?.h1), h24: num(a.price_change_percentage?.h24) },
      volume24hUsd: num(a.volume_usd?.h24), volume1hUsd: num(a.volume_usd?.h1), liquidityUsd: num(a.reserve_in_usd),
      fdvUsd: num(a.fdv_usd), marketCapUsd: num(a.market_cap_usd),
      txns24h: { buys: tx.buys ?? null, sells: tx.sells ?? null, traders: tx.unique_traders ?? null },
      createdAt: a.pool_created_at || null,
    };
  });
}

const LISTS = {
  trending: `networks/${NET}/trending_pools?include=base_token&page=1`,
  top: `networks/${NET}/pools?sort=h24_volume_usd_desc&include=base_token&page=1`,
  new: `networks/${NET}/new_pools?include=base_token&page=1`,
};

/** pools({ kind: "trending" | "top" | "new", limit }) */
export async function pools({ kind = "trending", limit = 20 } = {}) {
  if (!LISTS[kind]) throw Object.assign(new Error("kind must be trending, top or new"), { status: 400 });
  if (MOCK) return { kind, stale: false, updatedAt: new Date().toISOString(), pools: mockPools(kind).slice(0, limit) };
  const r = await gecko(LISTS[kind], kind === "new" ? 20_000 : 45_000);
  return { kind, stale: r.stale, updatedAt: new Date(cache.get(LISTS[kind])?.t || Date.now()).toISOString(), pools: normPools(r.data).slice(0, Math.min(50, limit)) };
}

/** token({ address }) — a mint's pools (by volume), price and change from the busiest one, totals across all of them. */
export async function token({ address }) {
  if (!isSolAddress(address)) throw Object.assign(new Error("address must be a Solana token mint"), { status: 400 });
  const list = MOCK ? mockPools("top").filter((p) => p.token.address === address)
    : normPools((await gecko(`networks/${NET}/tokens/${address}/pools?include=base_token&page=1`, 30_000)).data);
  const own = list.filter((p) => p.token.address === address).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
  const main = own[0] || null;
  const sum = (f) => own.reduce((s, p) => s + (f(p) || 0), 0);
  const totals = own.length ? {
    volume24hUsd: sum((p) => p.volume24hUsd), liquidityUsd: sum((p) => p.liquidityUsd),
    buys24h: sum((p) => p.txns24h.buys), sells24h: sum((p) => p.txns24h.sells), pools: own.length,
  } : null;
  return { address, token: main?.token || null, main, totals, pools: own.slice(0, 12), explorer: `${EXPLORER}/token/${address}`, geckoterminal: `https://www.geckoterminal.com/solana/tokens/${address}` };
}

/** stocks() — every xStock (tokenized stocks and ETFs on Solana) with its price, 24h change and volume from Jupiter. */
export async function stocks() {
  let stale = false, recs = [];
  try { recs = await searchTokens(STOCKS.map((s) => s.mint)); } catch { stale = true; }
  const by = new Map(recs.map((r) => [r.id, r]));
  return {
    stale,
    stocks: STOCKS.map((s) => {
      const r = by.get(s.mint);
      const vol = r?.stats24h ? (r.stats24h.buyVolume || 0) + (r.stats24h.sellVolume || 0) : null;
      return { symbol: s.symbol, ticker: s.ticker, name: s.name, address: s.mint, icon: r?.icon || s.icon, priceUsd: r?.usdPrice ?? null, change24hPct: r?.stats24h?.priceChange ?? null, volume24hUsd: vol, liquidityUsd: r?.liquidity ?? null };
    }),
  };
}

// ---------- chain status ----------
let statusCache = { t: 0, v: null };
export async function chainStatus() {
  if (statusCache.v && Date.now() - statusCache.t < 4000) return statusCache.v;
  const [slot, perf] = await Promise.all([rpc("getSlot", [{ commitment: "confirmed" }]), rpc("getRecentPerformanceSamples", [1]).catch(() => [])]);
  const p = perf?.[0];
  const v = { chain: "solana", slot, block: slot, tps: p ? Math.round(p.numTransactions / p.samplePeriodSecs) : null };
  statusCache = { t: Date.now(), v };
  return v;
}

// ---------- portfolio ----------
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/** portfolio({ address }) — SOL and every SPL / Token-2022 balance in the wallet, priced by Jupiter. */
export async function portfolio({ address }) {
  if (!isSolAddress(address)) throw Object.assign(new Error("Connect a wallet, or pass a Solana address"), { status: 400 });
  const [sol, ...lists] = await Promise.all([
    rpc("getBalance", [address]),
    ...TOKEN_PROGRAMS.map((programId) => rpc("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] }))),
  ]);
  const amounts = new Map([[SOL_MINT, { raw: BigInt(sol.value), decimals: 9 }]]);
  for (const l of lists) for (const a of l.value || []) {
    const i = a.account.data.parsed.info, raw = BigInt(i.tokenAmount.amount);
    if (raw === 0n) continue;
    const prev = amounts.get(i.mint);
    amounts.set(i.mint, { raw: (prev?.raw || 0n) + raw, decimals: i.tokenAmount.decimals });
  }
  const mints = [...amounts.keys()].filter((m) => amounts.get(m).raw > 0n).slice(0, 100);
  const recs = new Map((await searchTokens(mints).catch(() => [])).map((r) => [r.id, r]));
  const holdings = mints.map((m) => {
    const { raw, decimals } = amounts.get(m), r = recs.get(m);
    const amount = Number(formatUnits(raw, decimals, 8));
    const price = r?.usdPrice ?? (m === SOL_MINT ? null : null);
    return { symbol: m === SOL_MINT ? "SOL" : r?.symbol || m.slice(0, 4) + "…", name: m === SOL_MINT ? "Solana" : r?.name || null, address: m, icon: m === SOL_MINT ? BASE.SOL.icon : r?.icon || null,
      stock: STOCK_MINTS.has(m), amount, priceUsd: price, valueUsd: price != null ? +(amount * price).toFixed(2) : null };
  }).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  return { address, chain: "solana", holdings, totalUsd: +holdings.reduce((s, h) => s + (h.valueUsd || 0), 0).toFixed(2), note: "Every SPL and Token-2022 balance in the wallet, priced by Jupiter where a price exists." };
}

// ---------- mock ----------
function mockPools(kind) {
  const now = Date.now();
  return MOCK_POOLS().map((t, i) => ({
    pool: t.mint, name: `${t.symbol} / SOL`, dex: t.tax ? "LaunchLab" : t.symbol === "TSLAx" ? "Raydium CLMM" : "pump.fun", dexId: null,
    token: { address: t.mint, symbol: t.symbol, name: t.symbol, image: null, stock: t.symbol === "TSLAx" },
    priceUsd: t.price, priceSol: t.price / 150, change: { m5: 0.5, h1: 2 - i, h24: 20 - i * 9 },
    volume24hUsd: t.depth * 2, volume1hUsd: t.depth / 10, liquidityUsd: t.depth, fdvUsd: t.depth * 30, marketCapUsd: null,
    txns24h: { buys: 400 + i * 30, sells: 380 + i * 20, traders: 120 + i * 9 },
    createdAt: new Date(now - (kind === "new" ? (i + 1) * 300_000 : (i + 3) * 86400_000)).toISOString(),
  }));
}
