// QUILL_MOCK=1: deterministic stand-ins for Jupiter, GeckoTerminal-free market data and the Solana RPC, so the whole
// app (sign-in → chat → ticket → Checkpoint → build) runs offline and in tests. Never use for real trades.
import { encode58 } from "./base58.mjs";

export const MOCK = process.env.QUILL_MOCK === "1";

export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
// A thin, taxed token with live authorities, so tests can exercise warnings and failures.
export const MOCK_RISKY = encode58(new Uint8Array(32).fill(7));
export const MOCK_COIN = encode58(new Uint8Array(32).fill(9));

const T = {
  [SOL]: { symbol: "SOL", decimals: 9, price: 150, depth: 5e8, verified: true },
  [USDC]: { symbol: "USDC", decimals: 6, price: 1, depth: 5e8, verified: true },
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]: { symbol: "USDT", decimals: 6, price: 1, depth: 3e8, verified: true },
  [TSLAX]: { symbol: "TSLAx", decimals: 8, price: 380, depth: 2e6, verified: true },
  ["Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"]: { symbol: "NVDAx", decimals: 8, price: 156, depth: 2e6, verified: true },
  [MOCK_COIN]: { symbol: "QUILL", decimals: 6, price: 0.0042, depth: 3e5, verified: false, top: 22 },
  [MOCK_RISKY]: { symbol: "RISKY", decimals: 6, price: 0.0001, depth: 2e4, verified: false, top: 81, tax: 0.07 },
};

const record = (mint) => {
  const t = T[mint];
  return t && { id: mint, symbol: t.symbol, name: t.symbol, decimals: t.decimals, icon: null, usdPrice: t.price, isVerified: t.verified, liquidity: t.depth,
    organicScore: t.verified ? 95 : 30, holderCount: 1000, audit: { topHoldersPercentage: t.top ?? 10, mintAuthorityDisabled: !t.tax, freezeAuthorityDisabled: !t.tax },
    stats24h: { priceChange: 2.5, buyVolume: t.depth / 10, sellVolume: t.depth / 12 }, stats1h: { priceChange: 0.4 }, firstPool: { createdAt: new Date(Date.now() - 600_000).toISOString() } };
};

export function mockJup(path, body) {
  const u = new URL(path, "http://jup");
  if (u.pathname === "/swap/v1/quote") {
    const a = T[u.searchParams.get("inputMint")], b = T[u.searchParams.get("outputMint")];
    if (!a || !b) throw new Error("Jupiter found no route");
    const amount = BigInt(u.searchParams.get("amount"));
    const usdIn = (Number(amount) / 10 ** a.decimals) * a.price;
    const impact = usdIn / (Math.min(a.depth, b.depth) + usdIn);
    const fee = 0.0025 + (a.tax || 0) + (b.tax || 0);
    const out = BigInt(Math.floor(((usdIn * (1 - impact) * (1 - fee)) / b.price) * 10 ** b.decimals));
    return { inputMint: u.searchParams.get("inputMint"), outputMint: u.searchParams.get("outputMint"), inAmount: amount.toString(), outAmount: out.toString(), priceImpactPct: String(impact),
      routePlan: [{ swapInfo: { label: a.tax || b.tax ? "Raydium LaunchLab" : "Meteora DLMM" } }] };
  }
  if (u.pathname === "/swap/v1/swap") {
    const tx = Buffer.from(JSON.stringify({ user: body.userPublicKey, in: body.quoteResponse.inAmount, out: body.quoteResponse.outAmount })).toString("base64");
    return { swapTransaction: tx, lastValidBlockHeight: 1000, simulationError: null };
  }
  if (u.pathname === "/tokens/v2/search") return u.searchParams.get("query").split(",").map(record).filter(Boolean);
  if (u.pathname.startsWith("/tokens/v2/toptrending") || u.pathname === "/tokens/v2/recent") return [MOCK_COIN, TSLAX, MOCK_RISKY].map(record);
  if (u.pathname === "/price/v3") return Object.fromEntries(u.searchParams.get("ids").split(",").filter((m) => T[m]).map((m) => [m, { usdPrice: T[m].price, priceChange24h: 1.2, decimals: T[m].decimals }]));
  throw new Error(`mock Jupiter: ${u.pathname} not implemented`);
}

export function mockRpc(method, params) {
  if (method === "getAccountInfo") {
    const mint = params[0], t = T[mint];
    if (!t) return { value: null };
    const risky = !!t.tax;
    return { value: { owner: risky ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: {
      decimals: t.decimals, mintAuthority: risky ? MOCK_COIN : null, freezeAuthority: risky ? MOCK_COIN : null,
      extensions: risky ? [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 400 } } }] : [],
    } } } } };
  }
  if (method === "getBalance") return { value: 5_000_000_000 };
  if (method === "getTokenAccountsByOwner") {
    const holdings = [[USDC, "25000000", 6], [TSLAX, "10000000", 8]];
    const f = params[1] || {};
    const list = holdings.filter(([m]) => !f.mint || f.mint === m);
    const tk = f.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? [] : list;
    return { value: tk.map(([mint, amount, decimals]) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } })) };
  }
  if (method === "simulateTransaction") return { value: { err: null, unitsConsumed: 120000, logs: [] } };
  if (method === "getSlot") return 300_000_000;
  if (method === "getRecentPerformanceSamples") return [{ numTransactions: 3600, samplePeriodSecs: 1, slot: 300_000_000 }];
  if (method === "getSignatureStatuses") return { value: params[0].map(() => ({ confirmationStatus: "confirmed", err: null })) };
  throw new Error(`mock RPC: ${method} not implemented`);
}

export const MOCK_POOLS = () => [MOCK_COIN, TSLAX, MOCK_RISKY].map((m, i) => ({ mint: m, ...T[m], i }));
