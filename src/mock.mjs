// AGENTOS_MOCK=1: deterministic stand-ins for the chain RPC and the KyberSwap API, so the whole app
// (chat → ticket → Gate → build) runs offline and in tests. Never use for real trades.
export const MOCK = process.env.AGENTOS_MOCK === "1";

// USD prices for mock quotes, and a pool depth (USD) that sets the simulated price impact.
const PRICES = { ETH: 3200, WETH: 3200, USDC: 1, USDT: 1, DAI: 1, CBBTC: 95000, WBTC: 95000, ARB: 0.6 };
const DEPTH = { USDC: 5e7, USDT: 3e7, DAI: 1e7, WETH: 8e7, ETH: 8e7, CBBTC: 2e7, WBTC: 2e7, ARB: 4e6 };
// A thin, taxed token at this address lets tests exercise Gate warnings and failures.
export const MOCK_RISKY = "0x000000000000000000000000000000000000dEaD";
export const MOCK_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

// setFee(uint256), mint(address,uint256) and owner() as PUSH4 operands
const RISKY_CODE = "0x6369fe0e2d6340c10f19638da5cb5b6000";

export function mockRpc(chain, method, params) {
  if (method === "eth_getCode") return String(params[0]).toLowerCase() === MOCK_RISKY.toLowerCase() ? RISKY_CODE : "0x60006000";
  if (method === "eth_getStorageAt") return "0x" + "0".repeat(64);
  if (method === "eth_getBalance") return "0x" + (10n ** 19n).toString(16);
  if (method === "eth_call") {
    const { data = "", to } = params[0] || {};
    if (data === "0x313ce567") return "0x" + "12".padStart(64, "0");
    if (data === "0x8da5cb5b") return "0x" + "1234".padStart(64, "0");
    if (data === "0x95d89b41") return "0x" + Buffer.from("RISKY").toString("hex").padEnd(64, "0");
    if (data.startsWith("0xdd62ed3e")) return "0x0";
    if (data.startsWith("0x70a08231")) return "0x" + (10n ** 24n).toString(16);
    // a swap whose minimum-out is impossible reverts; everything else succeeds
    if (to === MOCK_ROUTER && data.includes("dead")) { const e = new Error("execution reverted: Return amount is not enough"); throw e; }
    return "0x";
  }
  if (method === "eth_blockNumber") return "0x1";
  throw new Error(`mock RPC: ${method} not implemented`);
}

function symOf(chainTokens, address) {
  if (address.toLowerCase() === MOCK_RISKY.toLowerCase()) return "RISKY";
  for (const [s, t] of Object.entries(chainTokens)) if (t.address.toLowerCase() === address.toLowerCase()) return s;
  return null;
}

/** mockRoute(chainTokens, tokenIn, tokenOut, amountIn, decIn, decOut) — shaped like a Kyber routeSummary. */
export function mockRoute(chainTokens, tokenIn, tokenOut, amountIn, decIn, decOut) {
  const a = symOf(chainTokens, tokenIn), b = symOf(chainTokens, tokenOut);
  if (!a || !b) throw new Error("KyberSwap found no route");
  const pIn = PRICES[a] ?? 0.01, pOut = PRICES[b] ?? 0.01;
  const usdIn = (Number(amountIn) / 10 ** decIn) * pIn;
  const depth = Math.min(DEPTH[a] ?? 20000, DEPTH[b] ?? 20000);
  const impact = usdIn / (depth + usdIn);
  const fee = a === "RISKY" || b === "RISKY" ? 0.07 : 0.003; // the risky token also charges a 4% transfer tax both ways
  const usdOut = usdIn * (1 - impact) * (1 - fee);
  const out = BigInt(Math.floor((usdOut / pOut) * 10 ** decOut));
  return {
    routerAddress: MOCK_ROUTER,
    routeSummary: {
      tokenIn, tokenOut, amountIn: String(amountIn), amountOut: String(out),
      amountInUsd: String(usdIn), amountOutUsd: String(usdOut), gasUsd: "0.02",
      route: [[{ pool: "0xpool", tokenIn, tokenOut, exchange: a === "RISKY" || b === "RISKY" ? "mock-v2" : "uniswap-v3" }]],
    },
  };
}

export function mockBuild(routeSummary, sender, slippageBps) {
  const minOut = (BigInt(routeSummary.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
  return {
    routerAddress: MOCK_ROUTER,
    data: "0xe21fd0e9" + BigInt(routeSummary.amountIn).toString(16).padStart(64, "0") + minOut.toString(16).padStart(64, "0") + sender.slice(2).toLowerCase().padStart(64, "0"),
    transactionValue: routeSummary.tokenIn.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? routeSummary.amountIn : "0",
    amountOut: routeSummary.amountOut,
  };
}
