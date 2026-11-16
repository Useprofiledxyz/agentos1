// Hyperliquid read tools (public info endpoint): market stats, movers, funding extremes, order-book fill simulation.
// AgentOS does not place Hyperliquid orders; these tools only read.
import { MOCK } from "./mock.mjs";

const INFO = process.env.HL_INFO_URL || "https://api.hyperliquid.xyz/info";

const MOCK_META = {
  universe: [{ name: "BTC", maxLeverage: 40 }, { name: "ETH", maxLeverage: 25 }, { name: "SOL", maxLeverage: 20 }, { name: "HYPE", maxLeverage: 10 }],
  ctxs: [
    { markPx: "95000", prevDayPx: "93000", funding: "0.0000125", openInterest: "21000", dayNtlVlm: "2100000000" },
    { markPx: "3200", prevDayPx: "3300", funding: "0.00002", openInterest: "500000", dayNtlVlm: "900000000" },
    { markPx: "180", prevDayPx: "170", funding: "-0.00001", openInterest: "3000000", dayNtlVlm: "300000000" },
    { markPx: "30", prevDayPx: "27", funding: "0.00005", openInterest: "9000000", dayNtlVlm: "150000000" },
  ],
};

async function info(body) {
  if (MOCK) {
    if (body.type === "metaAndAssetCtxs") return [{ universe: MOCK_META.universe }, MOCK_META.ctxs];
    if (body.type === "l2Book") {
      const i = MOCK_META.universe.findIndex((u) => u.name === body.coin);
      if (i < 0) return null;
      const mid = Number(MOCK_META.ctxs[i].markPx);
      const lvl = (side) => Array.from({ length: 20 }, (_, k) => ({ px: String(mid * (1 + side * (k + 1) * 0.0005)), sz: String(20000 / mid), n: 3 }));
      return { coin: body.coin, levels: [lvl(-1), lvl(1)] };
    }
  }
  const res = await fetch(INFO, { method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid returned ${res.status}`);
  return res.json();
}

let cache = { t: 0, v: null };
async function markets() {
  if (cache.v && Date.now() - cache.t < 10_000) return cache.v;
  const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" });
  const v = meta.universe.map((u, i) => {
    const c = ctxs[i] || {};
    const mark = Number(c.markPx), prev = Number(c.prevDayPx);
    return {
      coin: u.name, maxLeverage: u.maxLeverage, markPx: mark,
      change24hPct: prev ? +(((mark - prev) / prev) * 100).toFixed(2) : null,
      fundingHourly: Number(c.funding), fundingAprPct: +(Number(c.funding) * 24 * 365 * 100).toFixed(2),
      openInterestUsd: Math.round(Number(c.openInterest) * mark), volume24hUsd: Math.round(Number(c.dayNtlVlm)),
      delisted: !!u.isDelisted,
    };
  }).filter((m) => !m.delisted);
  cache = { t: Date.now(), v };
  return v;
}

export async function analyzeTicker({ coin }) {
  const c = String(coin || "").toUpperCase();
  const m = (await markets()).find((x) => x.coin === c);
  if (!m) throw new Error(`No Hyperliquid perp named ${c}`);
  return m;
}

export async function getMovers({ limit = 10 } = {}) {
  const liquid = (await markets()).filter((m) => m.volume24hUsd > 1e6 && m.change24hPct != null);
  return liquid.sort((a, b) => Math.abs(b.change24hPct) - Math.abs(a.change24hPct)).slice(0, Math.min(50, limit));
}

export async function getFundingExtremes({ limit = 5 } = {}) {
  const liquid = (await markets()).filter((m) => m.volume24hUsd > 1e6).sort((a, b) => b.fundingAprPct - a.fundingAprPct);
  const n = Math.min(20, limit);
  return { highest: liquid.slice(0, n), lowest: liquid.slice(-n).reverse() };
}

/** simulateTrade({ coin, side, sizeUsd }) — walk the live book level by level. */
export async function simulateTrade({ coin, side = "long", sizeUsd }) {
  const c = String(coin || "").toUpperCase();
  const usd = Number(sizeUsd);
  if (!(usd > 0)) throw new Error("sizeUsd must be above zero");
  const book = await info({ type: "l2Book", coin: c });
  if (!book?.levels) throw new Error(`No order book for ${c}`);
  const [bids, asks] = book.levels;
  const levels = side === "short" ? bids : asks;
  const mid = (Number(bids[0].px) + Number(asks[0].px)) / 2;
  let left = usd, filledSz = 0, cost = 0;
  for (const l of levels) {
    const px = Number(l.px), avail = Number(l.sz) * px;
    const take = Math.min(left, avail);
    filledSz += take / px; cost += take; left -= take;
    if (left <= 1e-9) break;
  }
  const avgPx = filledSz ? cost / filledSz : null;
  return {
    coin: c, side, sizeUsd: usd, mid,
    filledUsd: +cost.toFixed(2), unfilledUsd: +left.toFixed(2),
    avgPx, slippagePct: avgPx ? +((Math.abs(avgPx - mid) / mid) * 100).toFixed(4) : null,
    fitsVisibleBook: left <= 1e-9,
  };
}
