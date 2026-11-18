// Solana tokens Quill knows by symbol (SOL, stablecoins, xStocks). Any other token is used by its mint address;
// its symbol, decimals, icon and risk signals come from Jupiter's token API, with the chain as the fallback.
import xs from "../data/xstocks.json" with { type: "json" };
import { isSolAddress } from "./base58.mjs";
import { searchTokens } from "./jup.mjs";
import { rpc } from "./rpc.mjs";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const EXPLORER = "https://solscan.io";

export const BASE = {
  SOL: { mint: SOL_MINT, decimals: 9, name: "Solana", icon: "/img/sol.svg" },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, name: "USD Coin", icon: "https://static.datapi.jup.ag/token-icons/6c4e5669d2a438653105399865445682e4a6cb51e19e1e61dc97578cd27bb9b2.webp" },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, name: "Tether USD", icon: "https://static.datapi.jup.ag/token-icons/36574a5ee2cd469e059d070180985e59fbd57c82a54ea95763fab39973174100.webp" },
  QUILL: { mint: "DujzX238tv1yhe1PNBAfHbXofdjFUwoitYKwzxriBAGS", decimals: 9, name: "Quill HQ", icon: "/img/quill.svg" },
  JUP: { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, name: "Jupiter", icon: "https://static.datapi.jup.ag/token-icons/12254fdd34fa9a0ad62075bd3872df61e28584f9519fe00c744b71b514d4c3d7.webp" },
};
export const STOCKS = xs.stocks; // [{ symbol: "TSLAx", ticker: "TSLA", name, mint, decimals, icon }]

const byMint = new Map([
  ...Object.entries(BASE).map(([symbol, t]) => [t.mint, { symbol, ...t, known: true }]),
  ...STOCKS.map((s) => [s.mint, { symbol: s.symbol, mint: s.mint, decimals: s.decimals, name: s.name, icon: s.icon, stock: true, known: true }]),
]);
const bySymbol = new Map([...byMint.values()].map((t) => [t.symbol.toUpperCase(), t]));
// "TSLA" means the TSLAx xStock, "WSOL" means SOL
for (const s of STOCKS) if (!bySymbol.has(s.ticker.toUpperCase())) bySymbol.set(s.ticker.toUpperCase(), bySymbol.get(s.symbol.toUpperCase()));
bySymbol.set("WSOL", bySymbol.get("SOL"));

const out = (t) => ({ symbol: t.symbol, address: t.mint, decimals: t.decimals, name: t.name || null, icon: t.icon || null, stock: !!t.stock, known: !!t.known });

/** knownToken("TSLA" | "TSLAx" | mint) → token or null */
export function knownToken(ref) {
  const r = String(ref || "").trim();
  const t = bySymbol.get(r.toUpperCase()) || byMint.get(r);
  return t ? out(t) : null;
}
export const isKnownMint = (mint) => byMint.has(String(mint));

const meta = new Map(); // mint → { token, info, t }
/** tokenInfo(mint) → Jupiter's record (symbol, decimals, icon, audit, isVerified, organicScore, usdPrice, liquidity…) or null */
export async function tokenInfo(mint) {
  const hit = meta.get(mint);
  if (hit && Date.now() - hit.t < 60_000) return hit.info;
  const [info] = await searchTokens([mint]).catch(() => []);
  meta.set(mint, { info: info || null, t: Date.now() });
  return info || null;
}

/** resolveToken(ref) → { symbol, address, decimals, name, icon, stock, known } */
export async function resolveToken(ref) {
  const k = knownToken(ref);
  if (k) return k;
  const mint = String(ref || "").trim();
  if (!isSolAddress(mint)) throw new Error(`Unknown token "${ref}". Use SOL, USDC, USDT, an xStock like TSLAx, or a token mint address.`);
  const info = await tokenInfo(mint);
  if (info?.decimals != null) return { symbol: info.symbol || mint.slice(0, 4), address: mint, decimals: info.decimals, name: info.name || null, icon: info.icon || null, stock: false, known: false };
  // Not indexed by Jupiter yet (brand-new launch): read the mint account itself.
  const acc = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const parsed = acc?.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint") throw new Error(`${mint} is not a token mint on Solana`);
  return { symbol: mint.slice(0, 4) + "…", address: mint, decimals: parsed.info.decimals, name: null, icon: null, stock: false, known: false };
}

export function publicTokens() {
  return {
    chain: "solana",
    base: Object.entries(BASE).map(([symbol, t]) => ({ symbol, name: t.name, address: t.mint, icon: t.icon })),
    stocks: STOCKS.map((s) => ({ symbol: s.symbol, ticker: s.ticker, name: s.name, address: s.mint, icon: s.icon })),
  };
}
