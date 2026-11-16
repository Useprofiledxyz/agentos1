// Token and stock logos for Robinhood Chain, served from Quill's own /api/logo/:address so pages load them from one
// cached origin. Lookups are batched (up to 30 addresses per upstream call) and remembered; images are proxied from an
// allowlist of image hosts only, and when no source has a logo a deterministic gradient avatar is returned instead.
// Sources, in order: GeckoTerminal token info, DexScreener profiles, then (stocks only) a ticker logo service.
import { createHash } from "node:crypto";
import { CHAINS, NATIVE } from "./chains.mjs";
import { MOCK } from "./mock.mjs";
import { geckoGet } from "./onchain.mjs";

const RH = CHAINS.robinhood;
const STOCK_BY_ADDR = new Map(Object.entries(RH.tokens).filter(([, t]) => t.stock).map(([s, t]) => [t.address.toLowerCase(), s]));
const WETH = RH.tokens.WETH.address.toLowerCase();
const IMAGE_HOSTS = new Set(["coin-images.coingecko.com", "assets.coingecko.com", "assets.geckoterminal.com", "cdn.dexscreener.com", "dd.dexscreener.com", "financialmodelingprep.com"]);
const FOUND_MS = 24 * 3600_000, MISSING_MS = 30 * 60_000;

const urls = new Map(); // address → { url|null, t, ttl? }
const lc = (a) => String(a || "").toLowerCase();
// Stock logos never wait on an API: the company logo by ticker, with the token's own GeckoTerminal image (a generic
// Robinhood mark for most stocks) as the fallback.
const stockLogo = (sym) => `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
for (const [sym, t] of Object.entries(RH.tokens)) if (t.stock) urls.set(lc(t.address), { url: stockLogo(sym), alt: t.logo || null, t: Infinity });
const GECKO_WAIT_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** remember(address, url) — lets other modules (pool lists) feed logos they already have, at no extra cost. */
export function remember(address, url) {
  const a = lc(address);
  if (!a || !url || !isAllowedImage(url)) return;
  const cur = urls.get(a);
  if (!cur?.url) urls.set(a, { url, t: Date.now() });
}

function isAllowedImage(u) {
  try { const x = new URL(u); return x.protocol === "https:" && IMAGE_HOSTS.has(x.hostname); } catch { return false; }
}

// ---- batched resolution ----
let pending = new Map(); // address → [resolve]
let timer = null;

function fresh(a) {
  const c = urls.get(a);
  return c && Date.now() - c.t < (c.ttl ?? (c.url ? FOUND_MS : MISSING_MS)) ? c : null;
}

/** logoUrl(address) → upstream image URL or null. Concurrent callers are batched into one lookup. */
export function logoUrl(address) {
  let a = lc(address);
  if (a === lc(NATIVE)) a = WETH;
  const c = fresh(a);
  if (c) return Promise.resolve(c.url);
  return new Promise((resolve) => {
    if (!pending.has(a)) pending.set(a, []);
    pending.get(a).push(resolve);
    if (!timer) timer = setTimeout(flush, 40);
  });
}

async function flush() {
  timer = null;
  const batch = pending; pending = new Map();
  const addrs = [...batch.keys()];
  for (let i = 0; i < addrs.length; i += 30) await lookup(addrs.slice(i, i + 30)).catch(() => {});
  for (const [a, resolvers] of batch) { const c = urls.get(a); resolvers.forEach((r) => r(c?.url || null)); }
}

async function lookup(addrs) {
  if (MOCK) { addrs.forEach((a) => urls.set(a, { url: null, t: Date.now() })); return; }
  const found = new Map();
  const fromGecko = (v) => {
    for (const t of v?.data?.data || []) {
      const u = t.attributes?.image_url;
      if (u && u !== "missing.png" && isAllowedImage(u)) found.set(lc(t.attributes.address), u);
    }
  };
  // GeckoTerminal has the widest coverage but shares a paced queue with the market data; DexScreener answers fast.
  // Wait for DexScreener, give GeckoTerminal a short head start, and let a late GeckoTerminal answer fill the cache
  // for the next request instead of holding this one.
  let geckoDone = false;
  const geckoP = geckoGet(`networks/robinhood/tokens/multi/${addrs.join(",")}`, FOUND_MS)
    .then((v) => { geckoDone = true; fromGecko(v); return v; })
    .catch(() => { geckoDone = true; });
  const dex = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${addrs.join(",")}`, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const dexFound = new Map();
  if (Array.isArray(dex)) for (const p of dex) {
    const a = lc(p.baseToken?.address), u = p.info?.imageUrl;
    if (a && u && isAllowedImage(u)) dexFound.set(a, u);
  }
  await Promise.race([geckoP, sleep(GECKO_WAIT_MS)]);
  const settle = (complete) => {
    for (const a of addrs) {
      let u = found.get(a) || dexFound.get(a) || null;
      if (!u && STOCK_BY_ADDR.has(a)) u = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(STOCK_BY_ADDR.get(a))}.png`;
      const prev = urls.get(a);
      if (prev?.url && !u) continue;
      urls.set(a, { url: u, t: Date.now(), ...(complete || u ? {} : { ttl: 60_000 }) });
    }
  };
  settle(geckoDone);
  if (!geckoDone) geckoP.then(() => settle(true));
}

/** lookupIncomplete(address) — true while a "no logo" answer may still change soon (GeckoTerminal was slow). */
export const lookupIncomplete = (address) => urls.get(lc(address))?.ttl === 60_000;

// ---- image proxy ----
const images = new Map(); // url → { type, body, t }
const MAX_BYTES = 600 * 1024;
const OK_TYPES = /^image\/(png|jpe?g|webp|gif|avif)$/; // no SVG: it could carry script on our origin

async function fetchImage(url) {
  const hit = images.get(url);
  if (hit && Date.now() - hit.t < FOUND_MS) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5" }, redirect: "follow" });
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !OK_TYPES.test(type)) throw new Error("not an image");
  if (!isAllowedImage(res.url || url)) throw new Error("redirected off the allowlist");
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES || body.length < 100) throw new Error("bad size");
  const v = { type, body, t: Date.now() };
  images.set(url, v);
  if (images.size > 400) images.delete(images.keys().next().value);
  return v;
}

/** fallbackSvg(address, symbol) — a gradient disc with up to two letters, stable per address. */
export function fallbackSvg(address, symbol) {
  const h = createHash("sha256").update(lc(address) || String(symbol)).digest();
  const hue1 = h[0] * 360 / 256, hue2 = (hue1 + 40 + h[1] % 80) % 360;
  const letters = String(symbol || "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase().replace(/[<>&"']/g, "") || "?";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1.toFixed(0)},70%,55%)"/><stop offset="1" stop-color="hsl(${hue2.toFixed(0)},75%,40%)"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#g)"/><text x="32" y="33" text-anchor="middle" dominant-baseline="middle" font-family="ui-monospace,Menlo,monospace" font-size="${letters.length > 1 ? 22 : 28}" font-weight="700" fill="#fff">${letters}</text></svg>`;
}

/** logoResponse(address, symbol) → { status, headers, body } for /api/logo/:address */
export async function logoResponse(address, symbol) {
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cross-origin-resource-policy": "same-origin" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) return { status: 400, headers: { ...base, "content-type": "text/plain" }, body: "bad address" };
  try {
    const url = await logoUrl(address);
    for (const u of [url, urls.get(lc(address))?.alt].filter(Boolean)) {
      try {
        const img = await fetchImage(u);
        return { status: 200, headers: { ...base, "content-type": img.type, "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000" }, body: img.body };
      } catch {}
    }
  } catch {}
  // No logo yet: a short cache, so a logo added upstream later shows up within the hour (or within a minute when
  // the lookup was cut short).
  const cache = lookupIncomplete(address) ? "public, max-age=30, s-maxage=60" : "public, max-age=1800, s-maxage=3600";
  return { status: 200, headers: { ...base, "content-type": "image/svg+xml", "cache-control": cache }, body: fallbackSvg(address, symbol) };
}
