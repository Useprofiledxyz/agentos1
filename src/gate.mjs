// Quill Checkpoint: pre-trade checks on every swap quote. A failed check blocks the action; a warning shows on the ticket.
// Checks run against live routes and the live chain; thresholds come from the operator policy.
import { CHAINS, chainKey, isNative } from "./chains.mjs";
import { tokenHealth } from "./health.mjs";
import { route, build } from "./kyber.mjs";
import { checkPolicy } from "./policy.mjs";
import { allowance, resolveToken, simulate } from "./rpc.mjs";
import { formatUnits, parseUnits } from "./units.mjs";

const pct = (x) => `${(x * 100).toFixed(2)}%`;

/** quoteSwap({ chain, tokenIn, tokenOut, amount }) — human amount ("0.1"); resolves tokens and fetches a route. */
export async function quoteSwap({ chain, tokenIn, tokenOut, amount }) {
  const key = chainKey(chain);
  const [tIn, tOut] = await Promise.all([resolveToken(key, tokenIn || "ETH"), resolveToken(key, tokenOut)]);
  if (tIn.address.toLowerCase() === tOut.address.toLowerCase()) throw new Error("tokenIn and tokenOut are the same token");
  const amountIn = parseUnits(amount, tIn.decimals);
  if (amountIn <= 0n) throw new Error("Amount must be above zero");
  const q = await route({ chain: key, tokenIn: tIn, tokenOut: tOut, amountIn });
  return { chain: key, tokenIn: tIn, tokenOut: tOut, amount: String(amount), amountIn, quote: q };
}

/**
 * gateSwap({ chain, tokenIn, tokenOut, amount, sender?, slippagePct? }) → { status, checks[], quote summary }
 * sender (optional) turns on the exact-transaction simulation from that address.
 */
export async function gateSwap({ chain, tokenIn, tokenOut, amount, sender, slippagePct = 1 }) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  let q;
  try {
    q = await quoteSwap({ chain, tokenIn, tokenOut, amount });
    add("route", "Route", "pass", `${q.quote.exchanges.join(" + ") || "aggregated"} via KyberSwap`);
  } catch (e) {
    add("route", "Route", "fail", String(e.message || e));
    return finish({ checks, chain: chainKey(chain) });
  }
  const { tokenIn: tIn, tokenOut: tOut, amountIn, quote } = q;
  const policy = await checkPolicy({ address: sender, chain: q.chain, tokens: [tIn.address, tOut.address], usd: quote.inUsd, slippagePct });
  const P = policy.policy;

  // Test sell: quote selling back exactly what you would receive. Exposes transfer taxes and one-way pools, and gives
  // the real cost of the trade: a round trip pays fees and impact twice, so one way costs about half of it.
  // (Tiny probe quotes and the aggregator's USD prices were both tried as the reference and both misled on live
  // Robinhood Chain data: small sizes get better market-maker quotes, and USD prices for thin tokens are often stale.)
  let rt = null;
  try {
    const back = await route({ chain: q.chain, tokenIn: tOut, tokenOut: tIn, amountIn: quote.amountOut });
    rt = Math.max(0, 1 - Number(back.amountOut) / Number(amountIn));
    const maxRt = P.maxRoundTripLossPct / 100;
    add("test_sell", "Test sell (round trip)", rt > maxRt ? "fail" : rt > 0.06 ? "warn" : "pass", `selling back returns ${formatUnits(back.amountOut, tIn.decimals)} ${tIn.symbol} (${pct(rt)} round-trip loss)`);
  } catch (e) { add("test_sell", "Test sell (round trip)", "fail", `No route to sell back: ${e.message}`); }

  const max = P.maxPriceImpactPct / 100;
  if (rt != null) {
    const oneWay = rt / 2;
    add("impact", "Price impact + fees", oneWay > max ? "fail" : oneWay > Math.min(0.03, max / 2) ? "warn" : "pass", `about ${pct(oneWay)} one way, from the test sell (limit ${P.maxPriceImpactPct}%)`);
  }
  // Against market USD prices: informational unless far off, since USD prices for thin tokens lag the pools.
  if (quote.inUsd && quote.outUsd) {
    const gap = 1 - quote.outUsd / quote.inUsd;
    // A pool can sell you a token far above market and buy it back at the same wrong price; the round trip
    // would look clean, so a very large gap blocks.
    add("market", "Vs market price", gap > 0.4 ? "fail" : gap > 0.15 ? "warn" : "info", `$${quote.inUsd.toFixed(2)} in → $${quote.outUsd.toFixed(2)} out at reference USD prices (${gap >= 0 ? "" : "+"}${pct(Math.abs(gap))}${gap >= 0 ? " below" : " above"})`);
  }

  // Contract heuristics on whichever side is not on the known list.
  for (const t of [tIn, tOut]) {
    if (isNative(t.address)) continue;
    try {
      const h = await tokenHealth(q.chain, t.address);
      if (h.known) continue;
      const worst = h.flags.some((f) => f.severity === "fail") ? "fail" : h.flags.some((f) => f.severity === "warn") ? "warn" : "pass";
      add(`contract_${t.symbol}`, `Contract: ${t.symbol}`, worst, `${h.summary}${h.flags.length ? " " + h.flags.map((f) => f.text).join("; ") : ""}`);
    } catch (e) { add(`contract_${t.symbol}`, `Contract: ${t.symbol}`, "warn", `Could not read: ${e.message}`); }
  }

  if (quote.gasUsd != null && quote.inUsd) {
    const share = quote.gasUsd / quote.inUsd;
    add("gas", "Gas cost", share > 0.2 ? "warn" : "pass", `~$${quote.gasUsd.toFixed(3)} (${pct(share)} of the trade)`);
  }

  // Exact transaction simulation from the sender (needs an allowance first for ERC-20 input).
  if (sender) {
    try {
      const needsApproval = !isNative(tIn.address) && (await allowance(q.chain, tIn.address, sender, quote.router)) < amountIn;
      if (needsApproval) add("simulation", "Simulation", "warn", `Needs approval of ${tIn.symbol} first; the swap is simulated again after you approve.`);
      else {
        const tx = await build({ chain: q.chain, quote, sender, slippageBps: slippagePct * 100 });
        const sim = await simulate(q.chain, { from: sender, ...tx });
        const insufficient = !sim.ok && /insufficient|exceeds balance|funds/i.test(sim.error || "");
        add("simulation", "Simulation", sim.ok ? "pass" : insufficient ? "warn" : "fail", sim.ok ? "The exact swap succeeds against the current state." : insufficient ? `Your wallet does not hold enough ${tIn.symbol} for this amount plus gas, so the exact transaction could not be simulated. Top up or lower the amount.` : `Reverts: ${sim.error}`);
      }
    } catch (e) { add("simulation", "Simulation", "warn", `Could not simulate: ${e.message}`); }
  } else add("simulation", "Simulation", "info", "Connect a wallet to simulate the exact transaction from your address.");

  checks.push(...policy.rows);
  return finish({
    checks,
    chain: q.chain,
    swap: {
      chain: q.chain, chainName: CHAINS[q.chain].name,
      tokenIn: tIn, tokenOut: tOut,
      amountIn: q.amount, amountInRaw: amountIn.toString(),
      amountOut: formatUnits(quote.amountOut, tOut.decimals), amountOutRaw: quote.amountOut.toString(),
      inUsd: quote.inUsd, outUsd: quote.outUsd, gasUsd: quote.gasUsd,
      router: quote.router, exchanges: quote.exchanges, slippagePct,
    },
  });
}

function finish({ checks, chain, swap = null }) {
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return { status, chain, swap, checks, checkedAt: new Date().toISOString() };
}

/** gateToken({ chain, address }) — "Check a coin": health plus a $50-equivalent buy and test sell from ETH. */
export async function gateToken({ chain, address }) {
  const key = chainKey(chain);
  const health = await tokenHealth(key, address);
  const gate = await gateSwap({ chain: key, tokenIn: "ETH", tokenOut: address, amount: "0.015" });
  return { ...gate, health };
}
