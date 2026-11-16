// Prepared actions. A chat ticket lives 10 minutes; an API confirmationId lives 120 seconds and is bound to a hash
// of its exact parameters. Both are single use. Executing never trusts what was prepared: it re-quotes, re-runs the
// Checkpoint and the policy, and builds calldata from that fresh route.
import { createHash, randomBytes } from "node:crypto";
import { build } from "./kyber.mjs";
import { gateSwap, quoteSwap } from "./gate.mjs";
import { allowance, encodeApprove } from "./rpc.mjs";
import { CHAINS, isNative } from "./chains.mjs";
import { journal } from "./journal.mjs";
import { recordUsage } from "./policy.mjs";

const TICKET_MS = 10 * 60_000, CONFIRM_MS = 120_000;
const intents = new Map();

const canonical = (p) => JSON.stringify(Object.keys(p).sort().reduce((o, k) => ((o[k] = p[k]), o), {}));
const hashParams = (p) => createHash("sha256").update(canonical(p)).digest("hex");

function sweep() { const now = Date.now(); for (const [id, x] of intents) if (x.expiresAt < now - 60_000) intents.delete(id); }

/** prepareSwap(params, { kind: "ticket" | "confirmation", owner }) → Checkpoint result plus id, or a refusal. */
export async function prepareSwap(params, { kind = "ticket", owner = null } = {}) {
  sweep();
  const p = {
    chain: params.chain || "base",
    tokenIn: String(params.tokenIn || "ETH"),
    tokenOut: String(params.tokenOut || ""),
    amount: String(params.amount ?? params.amountIn ?? ""),
    slippagePct: Number(params.slippagePct ?? 1),
    sender: params.sender || null,
  };
  if (![0.5, 1, 2, 3, 5].includes(p.slippagePct)) p.slippagePct = Math.min(5, Math.max(0.1, p.slippagePct || 1));
  const gate = await gateSwap(p);
  if (gate.status === "fail") {
    await journal({ owner: owner || p.sender, kind: "swap", stage: "prepare", outcome: "blocked", reason: gate.checks.filter((c) => c.status === "fail").map((c) => c.label).join(", "), params: p });
    return { ok: false, reason: "Blocked by the Quill Checkpoint", gate };
  }
  const id = (kind === "ticket" ? "tk_" : "cf_") + randomBytes(9).toString("base64url");
  const ttl = kind === "ticket" ? TICKET_MS : CONFIRM_MS;
  intents.set(id, { id, kind, params: p, paramsHash: hashParams(p), owner: owner || p.sender, gate, createdAt: Date.now(), expiresAt: Date.now() + ttl, used: false });
  await journal({ owner: owner || p.sender, kind: "swap", stage: "prepare", outcome: "ready", id, params: p, gateStatus: gate.status });
  return { ok: true, id, kind, expiresAt: new Date(Date.now() + ttl).toISOString(), paramsHash: hashParams(p), gate };
}

export function getIntent(id) {
  const x = intents.get(id);
  if (!x) return null;
  return { id: x.id, kind: x.kind, params: x.params, gate: x.gate, expiresAt: new Date(x.expiresAt).toISOString(), expired: Date.now() > x.expiresAt, used: x.used };
}

function take(id, { owner } = {}) {
  const x = intents.get(id);
  if (!x) throw Object.assign(new Error("Unknown or expired id"), { status: 404 });
  if (x.used) throw Object.assign(new Error("This id was already used"), { status: 409 });
  if (Date.now() > x.expiresAt) throw Object.assign(new Error("Expired. Prepare it again."), { status: 410 });
  if (x.paramsHash !== hashParams(x.params)) throw Object.assign(new Error("Parameters changed after prepare"), { status: 409 });
  if (owner && x.owner && owner.toLowerCase() !== String(x.owner).toLowerCase()) throw Object.assign(new Error("This ticket belongs to another wallet"), { status: 403 });
  return x;
}

/**
 * buildTicket(id, sender) — for the browser: re-gate on the current pool, then return the unsigned transactions
 * (an approval if needed, then the swap). The wallet signs; the server never holds a key.
 */
export async function buildTicket(id, sender) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(sender || ""))) throw Object.assign(new Error("Connect a wallet first"), { status: 400 });
  const x = take(id, { owner: sender });
  const p = { ...x.params, sender };
  const gate = await gateSwap(p);
  if (gate.status === "fail") {
    await journal({ owner: sender, kind: "swap", stage: "build", outcome: "blocked", id, reason: "Checkpoint failed on re-check", params: p });
    return { ok: false, reason: "Checkpoint failed on the re-check, nothing was built", gate };
  }
  const q = await quoteSwap(p);
  const txs = [];
  if (!isNative(q.tokenIn.address) && (await allowance(q.chain, q.tokenIn.address, sender, q.quote.router)) < q.amountIn) {
    txs.push({ label: `Approve ${q.amount} ${q.tokenIn.symbol}`, to: q.tokenIn.address, data: encodeApprove(q.quote.router, q.amountIn), value: "0x0" });
  }
  const swap = await build({ chain: q.chain, quote: q.quote, sender, slippageBps: p.slippagePct * 100 });
  txs.push({ label: `Swap ${q.amount} ${q.tokenIn.symbol} → ${q.tokenOut.symbol}`, to: swap.to, data: swap.data, value: "0x" + swap.value.toString(16) });
  x.used = true;
  await recordUsage(sender, q.quote.inUsd || 0);
  await journal({ owner: sender, kind: "swap", stage: "build", outcome: "built", id, params: p, gateStatus: gate.status });
  return { ok: true, chainId: CHAINS[q.chain].id, explorer: CHAINS[q.chain].explorer, minOutRaw: swap.minOut.toString(), txs, gate };
}

/** executeIntent(id, { dryRun, owner }) — API/MCP path. Quill holds no keys, so live execution returns unsigned txs. */
export async function executeIntent(id, { dryRun = true, owner, sender } = {}) {
  const x = take(id, { owner });
  if (dryRun) {
    const gate = await gateSwap(x.params);
    x.used = true;
    await journal({ owner: owner || x.owner, kind: "swap", stage: "execute", outcome: "dry_run", id, params: x.params, gateStatus: gate.status });
    return { ok: gate.status !== "fail", dryRun: true, note: "Checked and logged, nothing was sent.", gate };
  }
  return buildTicket(id, sender || x.params.sender);
}

export async function markSent(id, { owner, hash }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw Object.assign(new Error("Invalid transaction hash"), { status: 400 });
  const x = intents.get(id);
  await journal({ owner, kind: "swap", stage: "sent", outcome: "sent", id, hash, params: x?.params });
  return { ok: true };
}
