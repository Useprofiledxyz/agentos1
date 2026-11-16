// One tool registry shared by the chat agent, the REST API and the MCP server.
// tier: "read" (public, cannot move funds) · "prepare" (needs an API key over REST; returns a ticket/confirmationId)
//       · "execute" (needs an API key with the execute scope and an Idempotency-Key).
import { publicChains } from "./chains.mjs";
import { gateSwap, gateToken } from "./gate.mjs";
import { tokenHealth } from "./health.mjs";
import { analyzeTicker, getFundingExtremes, getMovers, simulateTrade } from "./hyperliquid.mjs";
import { executeIntent, prepareSwap } from "./intents.mjs";
import { readJournal } from "./journal.mjs";
import { getPolicy } from "./policy.mjs";
import { balanceOf, resolveToken } from "./rpc.mjs";
import { formatUnits } from "./units.mjs";
import { chainKey } from "./chains.mjs";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const CHAIN = str("Chain: robinhood (Robinhood Chain 4663, default), base, arbitrum or ethereum", { enum: ["robinhood", "base", "arbitrum", "ethereum"] });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS = [
  {
    name: "list_chains", tier: "read",
    description: "Chains Quill supports, the token symbols it knows on each, and the tokenized stocks and ETFs on Robinhood Chain (NVDA, TSLA, SPY…). Any other token can be used by contract address.",
    input_schema: obj({}),
    run: async () => publicChains(),
  },
  {
    name: "quote_swap", tier: "read",
    description: "Quote a swap through KyberSwap and run the Quill Checkpoint on it (route, price impact, value kept, test sell, contract heuristics, gas, limits). tokenIn/tokenOut: a known symbol or a contract address. amount is in tokenIn units, e.g. \"0.05\".",
    input_schema: obj({ chain: CHAIN, tokenIn: str("Token to sell (symbol or address)"), tokenOut: str("Token to buy (symbol or address)"), amount: str("Amount of tokenIn, decimal string"), slippagePct: num("Slippage tolerance in percent (default 1, max 5)") }, ["tokenOut", "amount"]),
    run: (a, ctx) => gateSwap({ ...a, sender: ctx.address || undefined }),
  },
  {
    name: "check_token", tier: "read",
    description: "Checkpoint a token by contract address: bytecode heuristics (mint, pause, blacklist, fee setters, proxy, live owner) plus a small test buy and test sell from ETH. A heuristic, not an audit.",
    input_schema: obj({ chain: CHAIN, address: str("Token contract address 0x…") }, ["address"]),
    run: (a) => gateToken(a),
  },
  {
    name: "token_health", tier: "read",
    description: "Bytecode heuristics only for a token contract (no quotes).",
    input_schema: obj({ chain: CHAIN, address: str("Token contract address 0x…") }, ["address"]),
    run: (a) => tokenHealth(a.chain, a.address),
  },
  {
    name: "get_balance", tier: "read",
    description: "Balance of a token (default ETH) for an address (defaults to the connected wallet).",
    input_schema: obj({ chain: CHAIN, token: str("Symbol or address, default ETH"), address: str("Wallet address; defaults to the connected wallet") }),
    run: async (a, ctx) => {
      const who = a.address || ctx.address;
      if (!who) throw new Error("No address: connect a wallet or pass one");
      const t = await resolveToken(a.chain, a.token || "ETH");
      const raw = await balanceOf(chainKey(a.chain), t.address, who);
      return { address: who, chain: chainKey(a.chain), token: t.symbol, balance: formatUnits(raw, t.decimals) };
    },
  },
  {
    name: "analyze_ticker", tier: "read",
    description: "Price, 24h change, funding (hourly and APR), open interest and volume for a Hyperliquid perp, e.g. BTC.",
    input_schema: obj({ coin: str("Perp ticker, e.g. BTC") }, ["coin"]),
    run: (a) => analyzeTicker(a),
  },
  {
    name: "get_movers", tier: "read",
    description: "Biggest 24h movers among liquid Hyperliquid perps (volume above $1M).",
    input_schema: obj({ limit: num("How many, default 10") }),
    run: (a) => getMovers(a),
  },
  {
    name: "get_funding_extremes", tier: "read",
    description: "Highest and lowest annualised funding among liquid Hyperliquid perps.",
    input_schema: obj({ limit: num("How many per side, default 5") }),
    run: (a) => getFundingExtremes(a),
  },
  {
    name: "simulate_perp_fill", tier: "read",
    description: "Walk the live Hyperliquid order book to estimate fill price and slippage for a perp order of sizeUsd. Read-only: Quill does not place perp orders.",
    input_schema: obj({ coin: str("Perp ticker"), side: str("long or short", { enum: ["long", "short"] }), sizeUsd: num("Notional in USD") }, ["coin", "sizeUsd"]),
    run: (a) => simulateTrade(a),
  },
  {
    name: "get_policy", tier: "read",
    description: "Effective limits for the connected wallet (stricter of operator and personal caps), today's usage and pause state.",
    input_schema: obj({}),
    run: (_a, ctx) => getPolicy(ctx.address),
  },
  {
    name: "get_journal", tier: "read",
    description: "Recent journal entries (prepared, blocked, built, sent) for the connected wallet.",
    input_schema: obj({ limit: num("How many, default 20") }),
    run: (a, ctx) => readJournal({ owner: ctx.address, limit: a.limit || 20 }),
  },
  {
    name: "prepare_swap", tier: "prepare",
    description: "Prepare a swap: quote, run the Checkpoint and the limits, and return a ticket the user reviews and signs in their own wallet (chat: valid 10 minutes) or a one-time confirmationId (API: valid 120 seconds). Nothing is sent by this tool. If the Checkpoint fails, no ticket is made.",
    input_schema: obj({ chain: CHAIN, tokenIn: str("Token to sell (symbol or address)"), tokenOut: str("Token to buy (symbol or address)"), amount: str("Amount of tokenIn, decimal string"), slippagePct: num("Slippage tolerance in percent (default 1, max 5)") }, ["tokenOut", "amount"]),
    run: (a, ctx) => prepareSwap({ ...a, sender: ctx.address || null }, { kind: ctx.surface === "chat" ? "ticket" : "confirmation", owner: ctx.owner || ctx.address }),
  },
  {
    name: "execute_intent", tier: "execute",
    description: "Execute a prepared confirmationId. Re-quotes and re-runs the Checkpoint and limits. Dry-run unless the API token has dry-run switched off; live execution returns unsigned transactions for your wallet, since Quill holds no keys.",
    input_schema: obj({ confirmationId: str("cf_… id from prepare_swap"), sender: str("Wallet that will sign (live mode)") }, ["confirmationId"]),
    run: (a, ctx) => executeIntent(a.confirmationId, { dryRun: ctx.dryRun !== false, owner: ctx.owner, sender: a.sender }),
  },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export function publicToolList() {
  return TOOLS.map(({ name, tier, description, input_schema }) => ({ name, tier, description, input_schema }));
}

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
