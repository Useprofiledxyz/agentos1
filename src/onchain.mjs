// Live on-chain market data for Robinhood Chain: pools from GeckoTerminal (trending, top volume, new pairs), tokenized
// stock prices, the latest block, and a wallet's balances read straight from the chain.
// GeckoTerminal's public API allows about 30 calls a minute: calls go through one paced queue and are cached; when a
// call fails the last good copy is served with stale: true.
import { CHAINS, NATIVE } from "./chains.mjs";
import { MOCK } from "./mock.mjs";
import { rpc, rpcBatch } from "./rpc.mjs";
import { formatUnits } from "./units.mjs";
import { remember } from "./logos.mjs";

const GECKO = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";
const RH = CHAINS.robinhood;
const STOCKS = Object.entries(RH.tokens).filter(([, t]) => t.stock).map(([symbol, t]) => ({ symbol, name: t.name, address: t.address }));

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
  "uniswap-v3-robinhood": "Uniswap v3", "uniswap-v4-robinhood": "Uniswap v4", "pons-v2": "Pons", "pons-v2-dex": "Pons", "pons-dot-family": "Pons",
  "pancake-infinity-cl": "PancakeSwap", "bankr": "Bankr", "virtuals": "Virtuals", "clank-trade": "Clank.trade", "abyss": "Abyss",
};
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bV(\d)\b/g, "v$1");
const dexName = (id = "") => DEX[id] || (/^pons/.test(id) ? "Pons" : /^uniswap/.test(id) ? "Uniswap" : /^clank/.test(id) ? "Clanker" : /^long-/.test(id) ? "Long" : /^frontier/.test(id) ? "Frontier" : /^goo-/.test(id) ? "Goo" : /^o1-/.test(id) ? "o1" : /^aero-/.test(id) ? "Aerodrome" : titleCase(id.replace(/-robinhood$/, "").replace(/-/g, " ")));

function normPools(json) {
  const tokens = new Map((json.included || []).filter((x) => x.type === "token").map((x) => [x.id, x.attributes]));
  return (json.data || []).map((p) => {
    const a = p.attributes, base = tokens.get(p.relationships?.base_token?.data?.id) || {};
    const tx = a.transactions?.h24 || {};
    const stock = STOCKS.find((s) => s.address.toLowerCase() === String(base.address || "").toLowerCase());
    if (base.address && base.image_url) remember(base.address, base.image_url);
    return {
      pool: a.address, name: a.name, dex: dexName(p.relationships?.dex?.data?.id), dexId: p.relationships?.dex?.data?.id || null,
      token: { address: base.address || null, symbol: base.symbol || a.name?.split(" / ")[0] || "?", name: base.name || null, image: base.image_url || null, stock: !!stock },
      priceUsd: num(a.base_token_price_usd), priceEth: num(a.base_token_price_native_currency),
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

/** token({ address }) — its pools (by volume), price and change from the busiest one, totals across all of them. */
export async function token({ address }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) throw Object.assign(new Error("address must be a 0x… token contract"), { status: 400 });
  const list = MOCK ? mockPools("top").filter((p) => p.token.address?.toLowerCase() === address.toLowerCase())
    : normPools((await gecko(`networks/${NET}/tokens/${address.toLowerCase()}/pools?include=base_token&page=1`, 30_000)).data);
  const own = list.filter((p) => p.token.address?.toLowerCase() === address.toLowerCase()).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
  const main = own[0] || null;
  const sum = (f) => own.reduce((s, p) => s + (f(p) || 0), 0);
  const totals = own.length ? {
    volume24hUsd: sum((p) => p.volume24hUsd), liquidityUsd: sum((p) => p.liquidityUsd),
    buys24h: sum((p) => p.txns24h.buys), sells24h: sum((p) => p.txns24h.sells), pools: own.length,
  } : null;
  return { address, token: main?.token || null, main, totals, pools: own.slice(0, 12), explorer: `${RH.explorer}/token/${address}`, geckoterminal: `https://www.geckoterminal.com/robinhood/tokens/${address}` };
}

/** stocks() — every tokenized stock and ETF on Robinhood Chain with its on-chain price, 24h change and volume. */
export async function stocks() {
  if (MOCK) return { stale: false, stocks: STOCKS.map((s, i) => ({ ...s, priceUsd: 50 + i * 7.5, change24hPct: ((i % 7) - 3) * 0.8, volume24hUsd: 1e5 * (i + 1) })) };
  let stale = false;
  const out = new Map();
  for (let i = 0; i < STOCKS.length; i += 30) {
    const chunk = STOCKS.slice(i, i + 30).map((s) => s.address.toLowerCase());
    try {
      const r = await gecko(`simple/networks/${NET}/token_price/${chunk.join(",")}?include_24hr_price_change=true&include_24hr_vol=true`, 60_000);
      stale ||= r.stale;
      const a = r.data?.data?.attributes || {};
      for (const addr of chunk) out.set(addr, { priceUsd: num(a.token_prices?.[addr]), change24hPct: num(a.h24_price_change_percentage?.[addr]), volume24hUsd: num(a.h24_volume_usd?.[addr]) });
    } catch { stale = true; }
  }
  return { stale, stocks: STOCKS.map((s) => ({ ...s, ...(out.get(s.address.toLowerCase()) || { priceUsd: null, change24hPct: null, volume24hUsd: null }) })) };
}

// ---------- chain status ----------
let statusCache = { t: 0, v: null };
export async function chainStatus() {
  if (statusCache.v && Date.now() - statusCache.t < 4000) return statusCache.v;
  if (MOCK) return { chainId: 4663, block: 1234567, timestamp: Math.floor(Date.now() / 1000) - 1, ageSec: 1, baseFeeGwei: 0.02, txCount: 4, gasUsedPct: 0.1 };
  const b = await rpc("robinhood", "eth_getBlockByNumber", ["latest", false]);
  const ts = Number(BigInt(b.timestamp));
  const v = {
    chainId: 4663, block: Number(BigInt(b.number)), timestamp: ts, ageSec: Math.max(0, Math.round(Date.now() / 1000 - ts)),
    baseFeeGwei: b.baseFeePerGas ? Number(BigInt(b.baseFeePerGas)) / 1e9 : null,
    txCount: Array.isArray(b.transactions) ? b.transactions.length : null,
  };
  statusCache = { t: Date.now(), v };
  return v;
}

// ---------- portfolio ----------
/** portfolio({ address }) — ETH, WETH, USDG and every tokenized stock held, read from Robinhood Chain in one batch. */
export async function portfolio({ address }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) throw Object.assign(new Error("Connect a wallet, or pass an address"), { status: 400 });
  const list = Object.entries(RH.tokens).map(([symbol, t]) => ({ symbol, ...t }));
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const calls = list.map((t) => (t.address === NATIVE
    ? { method: "eth_getBalance", params: [address, "latest"] }
    : { method: "eth_call", params: [{ to: t.address, data: "0x70a08231" + pad(address) }, "latest"] }));
  const raw = MOCK ? list.map((t, i) => (i === 0 ? "0x" + (5n * 10n ** 16n).toString(16) : i === 2 ? "0x" + (25n * 10n ** 6n).toString(16) : t.symbol === "TSLA" ? "0x" + (10n ** 17n).toString(16) : "0x0"))
    : await rpcBatch("robinhood", calls);
  const held = list.map((t, i) => ({ ...t, raw: (() => { try { return BigInt(raw[i] && raw[i] !== "0x" ? raw[i] : 0); } catch { return 0n; } })() })).filter((t) => t.raw > 0n);

  const [st, eth] = await Promise.all([
    held.some((t) => t.stock) ? stocks().catch(() => ({ stocks: [] })) : { stocks: [] },
    ethPriceUsd().catch(() => null),
  ]);
  const priceOf = (t) => (t.symbol === "ETH" || t.symbol === "WETH" ? eth : t.symbol === "USDG" ? 1 : st.stocks.find((s) => s.symbol === t.symbol)?.priceUsd ?? null);
  const holdings = held.map((t) => {
    const amount = Number(formatUnits(t.raw, t.decimals, 8));
    const p = priceOf(t);
    return { symbol: t.symbol, name: t.name || null, address: t.address, stock: !!t.stock, amount, priceUsd: p, valueUsd: p != null ? +(amount * p).toFixed(2) : null };
  }).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  return { address, chain: "robinhood", holdings, totalUsd: +holdings.reduce((s, h) => s + (h.valueUsd || 0), 0).toFixed(2), note: "Known tokens only (ETH, WETH, USDG, tokenized stocks). Other coins: check them by address." };
}

async function ethPriceUsd() {
  if (MOCK) return 3200;
  const w = RH.tokens.WETH.address.toLowerCase();
  const r = await gecko(`simple/networks/${NET}/token_price/${w}`, 60_000);
  return num(r.data?.data?.attributes?.token_prices?.[w]);
}

// ---------- mock ----------
function mockPools(kind) {
  const now = Date.now();
  const rows = [
    ["CASHCAT", "0x020bfc650a365f8bb26819deaabf3e21291018b4", "Uniswap v3", 0.0494, 20.8, 4.5e6, 7.2e5],
    ["PONS", "0x00000000000000000000000000000000000a0001", "Uniswap v3", 0.1205, 0.5, 1.2e6, 2.1e6],
    ["TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "Uniswap v4", 382.07, -0.85, 1.8e6, 9.0e5],
    ["NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "Uniswap v4", 159.31, -0.93, 3.7e7, 4.0e6],
    ["RISKY", "0x000000000000000000000000000000000000dEaD", "Pons", 0.00003, 230.1, 4.2e3, 1.1e3],
  ];
  return rows.map(([sym, addr, dex, price, ch, vol, liq], i) => ({
    pool: "0x" + String(i + 1).padStart(40, "0"), name: `${sym} / WETH`, dex, dexId: null,
    token: { address: addr, symbol: sym, name: sym, image: null, stock: ["TSLA", "NVDA"].includes(sym) },
    priceUsd: price, priceEth: price / 3200, change: { m5: ch / 20, h1: ch / 5, h24: ch },
    volume24hUsd: vol, volume1hUsd: vol / 20, liquidityUsd: liq, fdvUsd: liq * 30, marketCapUsd: null,
    txns24h: { buys: 400 + i * 30, sells: 380 + i * 20, traders: 120 + i * 9 },
    createdAt: new Date(now - (kind === "new" ? (i + 1) * 300_000 : (i + 3) * 86400_000)).toISOString(),
  }));
}
