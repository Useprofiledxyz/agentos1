// The Solana Checkpoint: pre-trade checks on every swap quote. A failed check blocks the action; a warning shows on
// the ticket. Routes and token data come from Jupiter; authorities, Token-2022 extensions and the simulation come from
// the chain itself.
import { buildSwap, quote } from "./jup.mjs";
import { rpc, simulate } from "./rpc.mjs";
import { isKnownMint, resolveToken, SOL_MINT, tokenInfo } from "./tokens.mjs";
import { checkPolicy } from "../policy.mjs";
import { formatUnits, parseUnits } from "../units.mjs";

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const usdOf = async (mint, raw, decimals) => {
  const info = await tokenInfo(mint).catch(() => null);
  return info?.usdPrice != null ? (Number(raw) / 10 ** decimals) * info.usdPrice : null;
};

/** quoteSwap({ tokenIn, tokenOut, amount, slippagePct }) → tokens, raw amounts and the Jupiter quote */
export async function quoteSwap({ tokenIn, tokenOut, amount, slippagePct = 1, excludeDexes = [] }) {
  const [tIn, tOut] = await Promise.all([resolveToken(tokenIn || "SOL"), resolveToken(tokenOut)]);
  if (tIn.address === tOut.address) throw new Error("You pay and receive the same token");
  const amountIn = parseUnits(amount, tIn.decimals);
  if (amountIn <= 0n) throw new Error("Amount must be above zero");
  const q = await quote({ inMint: tIn.address, outMint: tOut.address, amount: amountIn, slippageBps: Math.round(slippagePct * 100), excludeDexes });
  return { chain: "solana", tokenIn: tIn, tokenOut: tOut, amount: String(amount), amountIn, amountOut: BigInt(q.outAmount), quote: q };
}

/** tokenHealth(mint) → { flags[], summary, score, known } from the mint account and Jupiter's audit */
export async function tokenHealth(mint) {
  if (isKnownMint(mint) && mint !== SOL_MINT) {
    const t = await resolveToken(mint);
    return { address: mint, known: true, flags: [], score: 100, summary: `${t.symbol} is on Quill's known-token list${t.stock ? " (a tokenized stock: its issuer keeps compliance controls)" : ""}.` };
  }
  if (mint === SOL_MINT) return { address: mint, known: true, flags: [], score: 100, summary: "Native SOL." };
  const [acc, info] = await Promise.all([rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]), tokenInfo(mint).catch(() => null)]);
  const p = acc?.value?.data?.parsed;
  if (!p || p.type !== "mint") return { address: mint, known: false, flags: [{ id: "no_mint", severity: "fail", text: "Not a token mint on Solana." }], score: 0, summary: "Not a token mint." };
  const m = p.info, flags = [];
  const add = (id, severity, text) => flags.push({ id, severity, text });
  const verified = !!info?.isVerified;
  const soft = (s) => (verified ? "info" : s); // verified issuers (stablecoins, xStocks) keep admin controls by design

  add("mint_auth", m.mintAuthority ? soft("warn") : "info", m.mintAuthority ? `Mint authority is live: new supply can be created (${m.mintAuthority.slice(0, 4)}…)` : "Mint authority revoked: supply is fixed.");
  add("freeze_auth", m.freezeAuthority ? soft("warn") : "info", m.freezeAuthority ? "Freeze authority is live: your tokens could be frozen so you cannot sell." : "Freeze authority revoked.");
  for (const e of m.extensions || []) {
    if (e.extension === "transferFeeConfig") {
      const bps = Number(e.state?.newerTransferFee?.transferFeeBasisPoints ?? e.state?.olderTransferFee?.transferFeeBasisPoints ?? 0);
      if (bps > 0) add("transfer_fee", bps > 1000 ? "fail" : "warn", `Token-2022 transfer fee: ${(bps / 100).toFixed(2)}% on every transfer.`);
    }
    if (e.extension === "permanentDelegate") add("perm_delegate", soft("warn"), "Permanent delegate: the issuer can move tokens out of any wallet.");
    if (e.extension === "transferHook") add("transfer_hook", soft("warn"), "Transfer hook: a program runs on every transfer and can block it.");
    if (e.extension === "pausableConfig") add("pausable", soft("warn"), "Pausable: transfers can be paused.");
    if (e.extension === "defaultAccountState" && e.state?.accountState === "frozen") add("default_frozen", soft("warn"), "New token accounts start frozen.");
  }
  const top = info?.audit?.topHoldersPercentage;
  if (top != null) add("holders", top > 60 ? "warn" : "info", `Top holders own ${top.toFixed(1)}% of supply${info?.holderCount ? `, ${info.holderCount.toLocaleString("en-US")} holders` : ""}.`);
  if (info?.audit?.isSus) add("sus", "fail", "Flagged as suspicious by Jupiter.");
  if (info && !verified && info.organicScore != null && info.organicScore < 20) add("organic", "info", `Low organic activity score (${info.organicScore.toFixed(0)}/100).`);
  if (!info) add("unindexed", "info", "Not indexed by Jupiter yet (very new token).");

  const warns = flags.filter((f) => f.severity === "warn").length, fails = flags.filter((f) => f.severity === "fail").length;
  return {
    address: mint, known: false, verified, flags,
    score: Math.max(0, 100 - warns * 15 - fails * 50),
    summary: fails ? "Serious risk flags on this token." : warns ? `${warns} risk flag${warns > 1 ? "s" : ""} on this token.` : "No risky authorities or extensions found.",
    tokenProgram: acc?.value?.owner || null,
  };
}

/**
 * gateSwap({ tokenIn, tokenOut, amount, sender?, slippagePct? }) → { status, checks[], swap }
 * sender (a wallet address) turns on the exact-transaction simulation from that wallet.
 */
export async function gateSwap({ tokenIn, tokenOut, amount, sender, slippagePct = 1 }) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  let q;
  try {
    q = await quoteSwap({ tokenIn, tokenOut, amount, slippagePct });
    const venues = [...new Set((q.quote.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))];
    add("route", "Route", "pass", `${venues.join(" → ") || "aggregated"} via Jupiter`);
  } catch (e) {
    add("route", "Route", "fail", String(e.message || e));
    return finish({ checks });
  }
  const { tokenIn: tIn, tokenOut: tOut, amountIn, amountOut, quote: jq } = q;
  const [inUsd, outUsd] = await Promise.all([usdOf(tIn.address, amountIn, tIn.decimals), usdOf(tOut.address, amountOut, tOut.decimals)]);
  const policy = await checkPolicy({ address: sender, chain: "solana", tokens: [tIn.address, tOut.address], usd: inUsd, slippagePct });
  const P = policy.policy;

  // Test sell: sell back what you would receive. A round trip pays fees and impact twice; one way costs about half.
  let rt = null;
  try {
    const back = await quote({ inMint: tOut.address, outMint: tIn.address, amount: amountOut, slippageBps: 300 });
    rt = Math.max(0, 1 - Number(BigInt(back.outAmount)) / Number(amountIn));
    add("test_sell", "Test sell (round trip)", rt > P.maxRoundTripLossPct / 100 ? "fail" : rt > 0.06 ? "warn" : "pass", `selling back returns ${formatUnits(BigInt(back.outAmount), tIn.decimals)} ${tIn.symbol} (${pct(rt)} round-trip loss)`);
  } catch (e) { add("test_sell", "Test sell (round trip)", "fail", `No route to sell back: ${e.message}`); }

  const max = P.maxPriceImpactPct / 100;
  const impact = Number(jq.priceImpactPct || 0);
  if (rt != null) {
    const oneWay = Math.max(rt / 2, impact);
    add("impact", "Price impact + fees", oneWay > max ? "fail" : oneWay > Math.min(0.03, max / 2) ? "warn" : "pass", `about ${pct(oneWay)} one way (limit ${P.maxPriceImpactPct}%)`);
  }
  if (inUsd && outUsd) {
    const gap = 1 - outUsd / inUsd;
    add("market", "Vs market price", gap > 0.4 ? "fail" : gap > 0.15 ? "warn" : "info", `$${inUsd.toFixed(2)} in → $${outUsd.toFixed(2)} out at market prices (${pct(Math.abs(gap))} ${gap >= 0 ? "below" : "above"})`);
  }

  for (const t of [tIn, tOut]) {
    if (t.address === SOL_MINT) continue;
    try {
      const h = await tokenHealth(t.address);
      if (h.known) continue;
      const worst = h.flags.some((f) => f.severity === "fail") ? "fail" : h.flags.some((f) => f.severity === "warn") ? "warn" : "pass";
      add(`token_${t.symbol}`, `Token: ${t.symbol}`, worst, `${h.summary} ${h.flags.filter((f) => f.severity !== "info" || worst === "pass").map((f) => f.text).join(" ")}`.trim());
    } catch (e) { add(`token_${t.symbol}`, `Token: ${t.symbol}`, "warn", `Could not read the token: ${e.message}`); }
  }

  if (sender) {
    try {
      const built = await buildSwap({ quoteResponse: jq, user: sender });
      const sim = built.simulationError ? { ok: false, error: built.simulationError.error || JSON.stringify(built.simulationError) } : await simulate(built.swapTransaction);
      const poor = !sim.ok && /insufficient|0x1\b|lamports|debit an account/i.test(sim.error || "");
      add("simulation", "Simulation", sim.ok ? "pass" : poor ? "warn" : "fail",
        sim.ok ? "The exact transaction succeeds from your wallet right now." : poor ? `Your wallet does not hold enough ${tIn.symbol} (plus SOL for fees) for this amount. Top up or lower it.` : `Fails in simulation: ${String(sim.error).slice(0, 160)}`);
    } catch (e) { add("simulation", "Simulation", "warn", `Could not simulate: ${e.message}`); }
  } else add("simulation", "Simulation", "info", "Connect a wallet to simulate the exact transaction from your address.");

  checks.push(...policy.rows);
  return finish({
    checks,
    swap: {
      chain: "solana", chainName: "Solana", tokenIn: tIn, tokenOut: tOut,
      amountIn: q.amount, amountInRaw: amountIn.toString(), amountOut: formatUnits(amountOut, tOut.decimals), amountOutRaw: amountOut.toString(),
      inUsd, outUsd, slippagePct, venues: [...new Set((jq.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))],
    },
  });
}

function finish({ checks, swap = null }) {
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return { status, chain: "solana", swap, checks, checkedAt: new Date().toISOString() };
}

/** gateToken({ address }) — "Check a coin": token health plus a ~$10 buy and test sell from SOL. */
export async function gateToken({ address }) {
  const health = await tokenHealth(address);
  const sol = await tokenInfo(SOL_MINT).catch(() => null);
  const amount = sol?.usdPrice ? (10 / sol.usdPrice).toFixed(4) : "0.05";
  const gate = await gateSwap({ tokenIn: "SOL", tokenOut: address, amount });
  return { ...gate, health };
}
