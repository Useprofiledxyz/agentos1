// Limits live here, outside any model. data/policy.json (operator) is re-read on every action;
// each address can only make them stricter (data/limits.json) or pause.
import { readJson, update, writeJson } from "./store.mjs";

export const DEFAULT_POLICY = {
  killSwitch: false,
  perTradeUsd: 1000,
  dailyUsd: 5000,
  maxSlippagePct: 5,
  maxPriceImpactPct: 8,
  maxRoundTripLossPct: 20,
  blockedTokens: [],
  allowedChains: ["base", "arbitrum", "ethereum"],
  freeMessagesPerDay: 30,
  note: "Operator policy. Edit this file to change limits; it is re-read on every action.",
};

const today = () => new Date().toISOString().slice(0, 10);
const lc = (a) => String(a || "").toLowerCase();

export async function operatorPolicy() {
  const p = await readJson("policy.json", null);
  if (!p) { await writeJson("policy.json", DEFAULT_POLICY); return structuredClone(DEFAULT_POLICY); }
  return { ...DEFAULT_POLICY, ...p };
}

const USER_FIELDS = ["perTradeUsd", "dailyUsd", "maxSlippagePct", "maxPriceImpactPct"];

/** Effective limits for an address: the stricter of operator and user values. */
export async function getPolicy(address) {
  const op = await operatorPolicy();
  const u = address ? (await readJson("limits.json", {}))[lc(address)] || {} : {};
  const eff = { ...op };
  for (const f of USER_FIELDS) if (Number.isFinite(u[f])) eff[f] = Math.min(op[f], u[f]);
  eff.paused = !!u.paused;
  eff.usedTodayUsd = address ? await usedToday(address) : 0;
  eff.userLimits = u;
  return eff;
}

/** setUserLimits(address, patch) — values above the operator ceiling are clamped. */
export async function setUserLimits(address, patch) {
  const op = await operatorPolicy();
  return update("limits.json", {}, (all) => {
    const cur = all[lc(address)] || {};
    for (const f of USER_FIELDS) {
      if (patch[f] === null) delete cur[f];
      else if (patch[f] != null && Number.isFinite(Number(patch[f])) && Number(patch[f]) >= 0) cur[f] = Math.min(op[f], Number(patch[f]));
    }
    if (typeof patch.paused === "boolean") cur.paused = patch.paused;
    all[lc(address)] = cur;
  }).then((all) => all[lc(address)]);
}

export async function usedToday(address) {
  const u = (await readJson("usage.json", {}))[lc(address)];
  return u && u.day === today() ? u.usd : 0;
}

export async function recordUsage(address, usd) {
  if (!(usd > 0) || !address) return;
  await update("usage.json", {}, (all) => {
    const k = lc(address);
    const u = all[k]?.day === today() ? all[k] : { day: today(), usd: 0 };
    u.usd = Math.round((u.usd + usd) * 100) / 100;
    all[k] = u;
  });
}

/** checkPolicy({ address, chain, tokens, usd, slippagePct }) → Gate-style check rows. */
export async function checkPolicy({ address, chain, tokens = [], usd, slippagePct }) {
  const p = await getPolicy(address);
  const rows = [];
  const row = (id, label, status, detail) => rows.push({ id, label, status, detail });
  if (p.killSwitch) row("kill", "Operator kill switch", "fail", "All execution is stopped by the operator.");
  if (p.paused) row("pause", "Paused", "fail", "You paused all actions. Unpause in Limits.");
  if (!p.allowedChains.includes(chain)) row("chain", "Chain allowed", "fail", `${chain} is not allowed by policy.`);
  const blocked = tokens.filter((t) => p.blockedTokens.map(lc).includes(lc(t)));
  if (blocked.length) row("blocked", "Token allowed", "fail", `Blocked by policy: ${blocked.join(", ")}`);
  if (usd != null) {
    row("per_trade", "Per-trade cap", usd <= p.perTradeUsd ? "pass" : "fail", `$${usd.toFixed(2)} of $${p.perTradeUsd} per trade`);
    const after = p.usedTodayUsd + usd;
    row("daily", "Daily cap", after <= p.dailyUsd ? "pass" : "fail", `$${after.toFixed(2)} of $${p.dailyUsd} today after this trade`);
  }
  if (slippagePct != null) row("slippage", "Slippage", slippagePct <= p.maxSlippagePct ? "pass" : "fail", `${slippagePct}% (max ${p.maxSlippagePct}%)`);
  return { rows, policy: p };
}
