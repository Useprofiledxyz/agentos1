// One tool registry shared by the chat agent, the REST API and the MCP server. Solana.
// tier: "read" (public, cannot move funds) · "prepare" (needs an API key over REST; returns a ticket/confirmationId)
//       · "execute" (needs an API key with the execute scope and an Idempotency-Key).
import { gateSwap, gateToken, tokenHealth } from "./sol/gate.mjs";
import { analyzeTicker, getFundingExtremes, getMovers, simulateTrade } from "./hyperliquid.mjs";
import { executeIntent, prepareSwap } from "./intents.mjs";
import { readJournal } from "./journal.mjs";
import { getPolicy } from "./policy.mjs";
import { chainStatus, pools, portfolio, stocks, token } from "./onchain.mjs";
import { publicTokens } from "./sol/tokens.mjs";
import { rpc } from "./sol/rpc.mjs";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOKEN = (what) => str(`${what}: SOL, USDC, USDT, JUP, an xStock like TSLAx (or TSLA), or a token mint address`);

export const TOOLS = [
  { name: "list_tokens", tier: "read", description: "Tokens Quill knows by symbol on Solana (SOL, USDC, USDT, JUP) and every xStock (tokenized stocks and ETFs: NVDAx, TSLAx, SPYx…). Any other token can be used by its mint address.",
    input_schema: obj({}), run: async () => publicTokens() },
  { name: "quote_swap", tier: "read", description: "Quote a Solana swap through Jupiter and run the Quill Checkpoint on it (route, test sell, price impact, vs market, token authorities and Token-2022 extensions, simulation, limits). amount is in units of tokenIn, e.g. \"0.1\".",
    input_schema: obj({ tokenIn: TOKEN("Token to sell (default SOL)"), tokenOut: TOKEN("Token to buy"), amount: str("Amount of tokenIn, decimal string"), slippagePct: num("Slippage tolerance in percent (default 1, max 5)") }, ["tokenOut", "amount"]),
    run: (a, ctx) => gateSwap({ ...a, sender: ctx.address || undefined }) },
  { name: "check_token", tier: "read", description: "Checkpoint a Solana token by mint: mint and freeze authority, Token-2022 transfer fees / permanent delegate / hooks, holder concentration, Jupiter's suspicious flag, plus a ~$10 test buy and test sell from SOL. A heuristic, not an audit.",
    input_schema: obj({ address: str("Token mint address") }, ["address"]), run: (a) => gateToken(a) },
  { name: "token_health", tier: "read", description: "Risk signals only for a Solana token mint (no quotes).",
    input_schema: obj({ address: str("Token mint address") }, ["address"]), run: (a) => tokenHealth(a.address) },
  { name: "onchain_pools", tier: "read", description: "Live Solana pools from GeckoTerminal: kind 'trending', 'top' (24h volume) or 'new' (newest pairs, pump.fun / LaunchLab launches included). Each row: token, venue, price, 5m/1h/24h change, volume, liquidity, FDV, buys/sells, age.",
    input_schema: obj({ kind: str("trending, top or new", { enum: ["trending", "top", "new"] }), limit: num("How many, default 20") }), run: (a) => pools(a) },
  { name: "onchain_token", tier: "read", description: "Live market data for one Solana token by mint: price, change, volume, liquidity, FDV and its pools.",
    input_schema: obj({ address: str("Token mint address") }, ["address"]), run: (a) => token(a) },
  { name: "stock_prices", tier: "read", description: "Every xStock on Solana (tokenized stocks and ETFs: NVDAx, TSLAx, SPYx…) with price, 24h change and volume.",
    input_schema: obj({}), run: () => stocks() },
  { name: "chain_status", tier: "read", description: "Latest Solana slot and recent transactions per second.", input_schema: obj({}), run: () => chainStatus() },
  { name: "get_portfolio", tier: "read", description: "Every SOL and token balance in a Solana wallet (defaults to the connected wallet), priced in USD.",
    input_schema: obj({ address: str("Wallet address; defaults to the connected wallet") }), run: (a, ctx) => portfolio({ address: a.address || ctx.address }) },
  { name: "tx_status", tier: "read", description: "Confirmation status of a Solana transaction signature.",
    input_schema: obj({ signature: str("Transaction signature") }, ["signature"]),
    run: async (a) => { const r = await rpc("getSignatureStatuses", [[a.signature], { searchTransactionHistory: true }]); const v = r?.value?.[0]; return { signature: a.signature, status: v?.confirmationStatus || "unknown", err: v?.err ? JSON.stringify(v.err) : null }; } },
  { name: "analyze_ticker", tier: "read", description: "Price, 24h change, funding, open interest and volume for a Hyperliquid perp, e.g. SOL.", input_schema: obj({ coin: str("Perp ticker") }, ["coin"]), run: (a) => analyzeTicker(a) },
  { name: "get_movers", tier: "read", description: "Biggest 24h movers among liquid Hyperliquid perps.", input_schema: obj({ limit: num("How many, default 10") }), run: (a) => getMovers(a) },
  { name: "get_funding_extremes", tier: "read", description: "Highest and lowest annualised funding among liquid Hyperliquid perps.", input_schema: obj({ limit: num("How many per side") }), run: (a) => getFundingExtremes(a) },
  { name: "simulate_perp_fill", tier: "read", description: "Walk the Hyperliquid order book to estimate fill price and slippage. Read-only.", input_schema: obj({ coin: str("Perp ticker"), side: str("long or short", { enum: ["long", "short"] }), sizeUsd: num("Notional in USD") }, ["coin", "sizeUsd"]), run: (a) => simulateTrade(a) },
  { name: "get_policy", tier: "read", description: "Effective limits for the connected wallet, today's usage and pause state.", input_schema: obj({}), run: (_a, ctx) => getPolicy(ctx.address) },
  { name: "get_journal", tier: "read", description: "Recent journal entries (prepared, blocked, built, sent) for the connected wallet.", input_schema: obj({ limit: num("How many, default 20") }), run: (a, ctx) => readJournal({ owner: ctx.address, limit: a.limit || 20 }) },
  { name: "prepare_swap", tier: "prepare", description: "Prepare a Solana swap: quote through Jupiter, run the Checkpoint and the limits, and return a ticket the user signs in their own wallet (chat: 10 minutes) or a one-time confirmationId (API: 120 seconds). Nothing is sent by this tool. If the Checkpoint fails, no ticket is made.",
    input_schema: obj({ tokenIn: TOKEN("Token to sell (default SOL)"), tokenOut: TOKEN("Token to buy"), amount: str("Amount of tokenIn, decimal string"), slippagePct: num("Slippage tolerance in percent (default 1, max 5)") }, ["tokenOut", "amount"]),
    run: (a, ctx) => prepareSwap({ ...a, sender: ctx.address || null }, { kind: ctx.surface === "chat" ? "ticket" : "confirmation", owner: ctx.owner || ctx.address }) },
  { name: "execute_intent", tier: "execute", description: "Execute a prepared confirmationId. Re-quotes and re-runs the Checkpoint and limits. Dry-run unless the API token has dry-run off; live execution returns an unsigned Solana transaction for your wallet, since Quill holds no keys.",
    input_schema: obj({ confirmationId: str("cf_… id from prepare_swap"), sender: str("Wallet that will sign (live mode)") }, ["confirmationId"]),
    run: (a, ctx) => executeIntent(a.confirmationId, { dryRun: ctx.dryRun !== false, owner: ctx.owner, sender: a.sender }) },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const publicToolList = () => TOOLS.map(({ name, tier, description, input_schema }) => ({ name, tier, description, input_schema }));

/** Coerce query-string args (all strings) to the schema's number types. */
export function coerceArgs(tool, args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    const s = tool.input_schema.properties[k];
    if (!s) continue;
    out[k] = s.type === "number" && typeof v === "string" ? Number(v) : v;
  }
  for (const r of tool.input_schema.required || []) if (out[r] == null || out[r] === "") throw Object.assign(new Error(`Missing argument: ${r}`), { status: 400 });
  return out;
}
