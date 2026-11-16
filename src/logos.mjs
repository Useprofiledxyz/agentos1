// Token and stock logos for Solana, served from Quill's own /api/logo/:mint so pages load them from one cached origin.
// Lookups are batched (up to 100 mints per Jupiter call) and remembered; images are proxied from an allowlist of image
// hosts only, and when no source has a logo a deterministic gradient avatar is returned instead.
// Sources, in order: the icon a pool list already carried, Jupiter's token API, DexScreener profiles; xStocks use the
// company logo by ticker, with their Jupiter icon as the fallback.
import { createHash } from "node:crypto";
import { MOCK } from "./sol/mock.mjs";
import { isSolAddress } from "./sol/base58.mjs";
import { searchTokens } from "./sol/jup.mjs";
import { BASE, STOCKS } from "./sol/tokens.mjs";

const IMAGE_HOSTS = new Set([
  "static.datapi.jup.ag", "coin-images.coingecko.com", "assets.coingecko.com", "assets.geckoterminal.com", "cdn.dexscreener.com", "dd.dexscreener.com",
  "financialmodelingprep.com", "ipfs.io", "arweave.net", "gateway.irys.xyz", "gateway.pinata.cloud", "cf-ipfs.com", "dweb.link", "raw.githubusercontent.com",
]);
const FOUND_MS = 24 * 3600_000, MISSING_MS = 30 * 60_000;

const urls = new Map(); // mint → { url|null, alt?, t, ttl? }
const lc = (a) => String(a || "").trim(); // Solana mints are case-sensitive: keys are kept as given
const stockLogo = (ticker) => `https://financialmodelingprep.com/image-stock/${encodeURIComponent(ticker)}.png`;
for (const s of STOCKS) urls.set(s.mint, { url: stockLogo(s.ticker), alt: s.icon, t: Infinity });
for (const t of Object.values(BASE)) if (/^https:/.test(t.icon || "")) urls.set(t.mint, { url: t.icon, t: Infinity });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** remember(mint, url) — lets other modules (pool lists) feed logos they already have, at no extra cost. */
export function remember(address, url) {
  const a = lc(address);
  if (!a || !url || !isAllowedImage(url)) return;
  const cur = urls.get(a);
  if (!cur?.url) urls.set(a, { url, t: Date.now() });
}

function isAllowedImage(u) {
  try { const x = new URL(u); return x.protocol === "https:" && (IMAGE_HOSTS.has(x.hostname) || x.hostname.endsWith(".ipfs.dweb.link") || x.hostname.endsWith(".ipfs.nftstorage.link")); } catch { return false; }
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
  for (let i = 0; i < addrs.length; i += 100) await lookup(addrs.slice(i, i + 100)).catch(() => {});
  for (const [a, resolvers] of batch) { const c = urls.get(a); resolvers.forEach((r) => r(c?.url || null)); }
}

async function lookup(addrs) {
  if (MOCK) { addrs.forEach((a) => urls.set(a, { url: null, t: Date.now() })); return; }
  const found = new Map();
  let complete = true;
  try {
    for (const t of await searchTokens(addrs)) if (t.icon && isAllowedImage(t.icon)) found.set(t.id, t.icon);
  } catch { complete = false; } // a failed lookup is not "no logo": leave it incomplete so the next request tries again
  const missing = addrs.filter((a) => !found.has(a));
  if (missing.length) {
    const dex = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${missing.slice(0, 30).join(",")}`, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : [])).catch(() => { complete = false; return []; });
    if (Array.isArray(dex)) for (const p of dex) { const a = p.baseToken?.address, u = p.info?.imageUrl; if (a && u && !found.has(a) && isAllowedImage(u)) found.set(a, u); }
  }
  for (const a of addrs) {
    const u = found.get(a) || null, prev = urls.get(a);
    if (prev?.url && !u) continue;
    urls.set(a, { url: u, t: Date.now(), ...(complete || u ? {} : { ttl: 60_000 }) });
  }
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
export async function logoResponse(address, symbol, hint) {
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cross-origin-resource-policy": "same-origin" };
  if (!isSolAddress(address)) return { status: 400, headers: { ...base, "content-type": "text/plain" }, body: "bad address" };
  try {
    // A pool list already knows the image: try that first, so no lookup (and no other instance's memory) is needed.
    const known = hint && isAllowedImage(hint) ? hint : null;
    if (known) remember(address, known);
    const url = known || (await logoUrl(address));
    for (const u of [...new Set([url, urls.get(lc(address))?.url, urls.get(lc(address))?.alt])].filter(Boolean)) {
      try {
        const img = await fetchImage(u);
        return { status: 200, headers: { ...base, "content-type": img.type, "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000" }, body: img.body };
      } catch {}
    }
  } catch {}
  // No logo yet: a short cache, so a logo added upstream later shows up within the hour (or within a minute when
  // the lookup was cut short).
  const cache = lookupIncomplete(address) ? "public, max-age=30, s-maxage=60" : "public, max-age=300, s-maxage=600";
  return { status: 200, headers: { ...base, "content-type": "image/svg+xml", "cache-control": cache }, body: fallbackSvg(address, symbol) };
}
