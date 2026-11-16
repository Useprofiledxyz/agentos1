// Prepared actions. A chat ticket lives 10 minutes; an API confirmationId lives 120 seconds. The id itself is a sealed
// token (HMAC over the exact parameters, owner and expiry), so it cannot be altered and needs no server memory.
// Both are single use (tracked per instance and in the data dir). Executing never trusts what was prepared: it re-quotes, re-runs the
// Checkpoint and the policy, and builds calldata from that fresh route.
import { randomBytes } from "node:crypto";
import { build } from "./kyber.mjs";
import { gateSwap, quoteSwap } from "./gate.mjs";
import { allowance, encodeApprove } from "./rpc.mjs";
import { CHAINS, chainKey, isNative } from "./chains.mjs";
import { journal } from "./journal.mjs";
import { recordUsage } from "./policy.mjs";
import { seal, unseal } from "./seal.mjs";
import { update } from "./store.mjs";

const TICKET_MS = 10 * 60_000, CONFIRM_MS = 120_000;
const PREFIX = { ticket: "tk_", confirmation: "cf_" };
const used = new Map(); // ref → expiry

/** prepareSwap(params, { kind: "ticket" | "confirmation", owner }) → Checkpoint result plus id, or a refusal. */
export async function prepareSwap(params, { kind = "ticket", owner = null } = {}) {
  const p = {
    chain: chainKey(params.chain),
    tokenIn: String(params.tokenIn || "ETH"),
    tokenOut: String(params.tokenOut || ""),
    amount: String(params.amount ?? params.amountIn ?? ""),
    slippagePct: Number(params.slippagePct ?? 1),
    sender: params.sender || null,
  };
  if (![0.5, 1, 2, 3, 5].includes(p.slippagePct)) p.slippagePct = Math.min(5, Math.max(0.1, p.slippagePct || 1));
  const who = owner || p.sender;
  const gate = await gateSwap(p);
  if (gate.status === "fail") {
    await journal({ owner: who, kind: "swap", stage: "prepare", outcome: "blocked", reason: gate.checks.filter((c) => c.status === "fail").map((c) => c.label).join(", "), params: p });
    return { ok: false, reason: "Blocked by the Quill Checkpoint", gate };
  }
  const ref = randomBytes(6).toString("hex");
  const ttl = kind === "ticket" ? TICKET_MS : CONFIRM_MS;
  const id = PREFIX[kind] + seal("intent", { k: kind, r: ref, p, o: who ? String(who).toLowerCase() : null }, ttl);
  await journal({ owner: who, kind: "swap", stage: "prepare", outcome: "ready", ref, params: p, gateStatus: gate.status });
  return { ok: true, id, ref, kind, expiresAt: new Date(Date.now() + ttl).toISOString(), gate };
}

function open(id) {
  const kind = String(id).startsWith("tk_") ? "ticket" : String(id).startsWith("cf_") ? "confirmation" : null;
  if (!kind) throw Object.assign(new Error("Unknown id"), { status: 404 });
  const x = unseal("intent", String(id).slice(3));
  if (x.k !== kind) throw Object.assign(new Error("Unknown id"), { status: 404 });
  return { kind, ref: x.r, params: x.p, owner: x.o, expiresAt: x.exp };
}

export function getIntent(id) {
  try {
    const x = open(id);
    return { kind: x.kind, ref: x.ref, params: x.params, expiresAt: new Date(x.expiresAt).toISOString(), used: used.has(x.ref) };
  } catch { return null; }
}

async function take(id, { owner } = {}) {
  const x = open(id);
  if (owner && x.owner && owner.toLowerCase() !== x.owner) throw Object.assign(new Error("This ticket belongs to another wallet"), { status: 403 });
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  let seen = used.has(x.ref);
  await update("used-intents.json", {}, (all) => {
    for (const [k, exp] of Object.entries(all)) if (exp < now) delete all[k];
    if (all[x.ref]) seen = true; else all[x.ref] = x.expiresAt;
  }).catch(() => {});
  if (seen) throw Object.assign(new Error("This id was already used"), { status: 409 });
  used.set(x.ref, x.expiresAt);
  return x;
}

/**
 * buildTicket(id, sender) — for the browser: re-check on the current pool, then return the unsigned transactions
 * (an approval if needed, then the swap). The wallet signs; the server never holds a key.
 */
export async function buildTicket(id, sender) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(sender || ""))) throw Object.assign(new Error("Connect a wallet first"), { status: 400 });
  const x = await take(id, { owner: sender });
  const p = { ...x.params, sender };
  const gate = await gateSwap(p);
  if (gate.status === "fail") {
    await journal({ owner: sender, kind: "swap", stage: "build", outcome: "blocked", ref: x.ref, reason: "Checkpoint failed on re-check", params: p });
    return { ok: false, reason: "Checkpoint failed on the re-check, nothing was built", gate };
  }
  const q = await quoteSwap(p);
  const txs = [];
  if (!isNative(q.tokenIn.address) && (await allowance(q.chain, q.tokenIn.address, sender, q.quote.router)) < q.amountIn) {
    txs.push({ label: `Approve ${q.amount} ${q.tokenIn.symbol}`, to: q.tokenIn.address, data: encodeApprove(q.quote.router, q.amountIn), value: "0x0" });
  }
  const swap = await build({ chain: q.chain, quote: q.quote, sender, slippageBps: p.slippagePct * 100 });
  txs.push({ label: `Swap ${q.amount} ${q.tokenIn.symbol} → ${q.tokenOut.symbol}`, to: swap.to, data: swap.data, value: "0x" + swap.value.toString(16) });
  await recordUsage(sender, q.quote.inUsd || 0);
  await journal({ owner: sender, kind: "swap", stage: "build", outcome: "built", ref: x.ref, params: p, gateStatus: gate.status });
  return { ok: true, ref: x.ref, chainId: CHAINS[q.chain].id, explorer: CHAINS[q.chain].explorer, minOutRaw: swap.minOut.toString(), txs, gate };
}

/** executeIntent(id, { dryRun, owner }) — API/MCP path. Quill holds no keys, so live execution returns unsigned txs. */
export async function executeIntent(id, { dryRun = true, owner, sender } = {}) {
  if (!dryRun) return buildTicket(id, sender || open(id).params.sender);
  const x = await take(id, { owner });
  const gate = await gateSwap(x.params);
  await journal({ owner: owner || x.owner, kind: "swap", stage: "execute", outcome: "dry_run", ref: x.ref, params: x.params, gateStatus: gate.status });
  return { ok: gate.status !== "fail", dryRun: true, note: "Checked and logged, nothing was sent.", gate };
}

export async function markSent(id, { owner, hash }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw Object.assign(new Error("Invalid transaction hash"), { status: 400 });
  let x = null;
  try { x = open(id); } catch {}
  await journal({ owner, kind: "swap", stage: "sent", outcome: "sent", ref: x?.ref, hash, params: x?.params });
  return { ok: true };
}
