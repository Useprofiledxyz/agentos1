// End-to-end tests in mock mode: no network, no real chain. Run with `npm test`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

process.env.QUILL_MOCK = "1";
process.env.QUILL_DATA = mkdtempSync(path.join(tmpdir(), "quill-test-"));
delete process.env.ANTHROPIC_API_KEY;

const { parseUnits, formatUnits } = await import("../src/units.mjs");
const { recoverAddress } = await import("../src/auth.mjs");
const { gateSwap } = await import("../src/gate.mjs");
const { MOCK_RISKY } = await import("../src/mock.mjs");
const { writeJson } = await import("../src/store.mjs");
const { DEFAULT_POLICY } = await import("../src/policy.mjs");
const { createToken, setToken } = await import("../src/apitokens.mjs");
const { server } = await import("../server.mjs");

// Test wallet: private key 0x…01 → 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
const SK = new Uint8Array(32); SK[31] = 1;
const ADDR = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
function personalSign(message) {
  const m = new TextEncoder().encode(message);
  const h = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
  const rec = secp256k1.sign(h, SK, { prehash: false, format: "recovered" });
  return "0x" + Buffer.from([...rec.slice(1), rec[0] + 27]).toString("hex");
}

let base;
before(async () => { await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

async function call(p, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

async function signIn() {
  const n = await call("/api/auth/nonce", { method: "POST", body: { address: ADDR } });
  const v = await call("/api/auth/verify", { method: "POST", body: { nonce: n.json.nonce, signature: personalSign(n.json.message) } });
  assert.equal(v.status, 200);
  return v.headers.get("set-cookie").split(";")[0];
}

test("units round-trip", () => {
  assert.equal(parseUnits("1.5", 18), 1500000000000000000n);
  assert.equal(formatUnits(1500000n, 6), "1.5");
  assert.throws(() => parseUnits("1.1234567", 6));
  assert.throws(() => parseUnits("abc", 6));
});

test("personal_sign recovery matches the known address", () => {
  assert.equal(recoverAddress("hello", personalSign("hello")), ADDR);
});

test("Checkpoint passes a liquid pair", async () => {
  const g = await gateSwap({ chain: "base", tokenIn: "ETH", tokenOut: "USDC", amount: "0.1" });
  assert.equal(g.status, "pass");
  assert.ok(g.checks.find((c) => c.id === "route" && c.status === "pass"));
});

test("Checkpoint flags a taxed token with risky bytecode", async () => {
  const g = await gateSwap({ chain: "base", tokenIn: "ETH", tokenOut: MOCK_RISKY, amount: "0.01" });
  assert.notEqual(g.status, "pass");
  const contract = g.checks.find((c) => c.id.startsWith("contract_"));
  assert.equal(contract.status, "warn");
  assert.match(contract.detail, /fee or tax setters/);
  assert.equal(g.checks.find((c) => c.id === "test_sell").status, "warn");
});

test("Checkpoint fails a trade over the per-trade cap", async () => {
  await writeJson("policy.json", { ...DEFAULT_POLICY, perTradeUsd: 100 });
  try {
    const g = await gateSwap({ chain: "base", tokenIn: "ETH", tokenOut: "USDC", amount: "0.1" }); // $320
    assert.equal(g.status, "fail");
    assert.equal(g.checks.find((c) => c.id === "per_trade").status, "fail");
  } finally { await writeJson("policy.json", DEFAULT_POLICY); }
});

test("read tools are public over REST", async () => {
  const r = await call("/api/tools/analyze_ticker?coin=btc");
  assert.equal(r.status, 200);
  assert.equal(r.json.coin, "BTC");
  const list = await call("/api/tools");
  assert.ok(list.json.some((t) => t.name === "prepare_swap" && t.tier === "prepare"));
});

test("browser POSTs must be JSON (CSRF guard)", async () => {
  const res = await fetch(base + "/api/policy", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "paused=true" });
  assert.equal(res.status, 415);
});

test("sign in, prepare a ticket, re-check and build unsigned txs, record the hash", async () => {
  assert.equal((await call("/api/swap/prepare", { method: "POST", body: { tokenOut: "USDC", amount: "0.01" } })).status, 401);
  const cookie = await signIn();
  assert.equal((await call("/api/auth/me", { cookie })).json.address, ADDR);

  const t = await call("/api/swap/prepare", { method: "POST", cookie, body: { chain: "base", tokenIn: "USDC", tokenOut: "ETH", amount: "50" } });
  assert.equal(t.json.ok, true);
  assert.match(t.json.id, /^tk_/);

  const b = await call(`/api/tickets/${t.json.id}/build`, { method: "POST", cookie, body: {} });
  assert.equal(b.json.ok, true);
  assert.equal(b.json.chainId, 8453);
  assert.equal(b.json.txs.length, 2, "USDC needs an approval before the swap");
  assert.match(b.json.txs[0].data, /^0x095ea7b3/);

  const again = await call(`/api/tickets/${t.json.id}/build`, { method: "POST", cookie, body: {} });
  assert.equal(again.status, 409, "tickets are single use");

  const hash = "0x" + "ab".repeat(32);
  assert.equal((await call(`/api/tickets/${t.json.id}/sent`, { method: "POST", cookie, body: { hash } })).json.ok, true);
  const j = await call("/api/journal", { cookie });
  assert.deepEqual(j.json.slice(0, 3).map((r) => r.stage), ["sent", "build", "prepare"]);
});

test("another wallet cannot build my ticket", async () => {
  const cookie = await signIn();
  const t = await call("/api/swap/prepare", { method: "POST", cookie, body: { tokenOut: "USDC", amount: "0.01" } });
  const other = await call(`/api/tickets/${t.json.id}/build`, { method: "POST", body: {} });
  assert.equal(other.status, 400, "anonymous build is refused");
});

test("personal limits can only tighten, and pause blocks", async () => {
  const cookie = await signIn();
  const p = await call("/api/policy", { method: "POST", cookie, body: { perTradeUsd: 999999 } });
  assert.equal(p.json.perTradeUsd, DEFAULT_POLICY.perTradeUsd);
  await call("/api/policy", { method: "POST", cookie, body: { paused: true } });
  const t = await call("/api/swap/prepare", { method: "POST", cookie, body: { tokenOut: "USDC", amount: "0.01" } });
  assert.equal(t.json.ok, false);
  await call("/api/policy", { method: "POST", cookie, body: { paused: false } });
});

test("API token: prepare gives a confirmationId; execute is dry-run and idempotent", async () => {
  const tok = await createToken({ label: "t", scopes: ["prepare", "execute"] });
  assert.equal((await call("/api/tools/prepare_swap", { method: "POST", body: { tokenOut: "USDC", amount: "0.01" } })).status, 401);
  const prep = await call("/api/tools/prepare_swap", { method: "POST", headers: { "x-api-key": tok.token }, body: { tokenOut: "USDC", amount: "0.01" } });
  assert.match(prep.json.id, /^cf_/);
  const headers = { "x-api-key": tok.token, "idempotency-key": "k1" };
  assert.equal((await call("/api/tools/execute_intent", { method: "POST", headers: { "x-api-key": tok.token }, body: { confirmationId: prep.json.id } })).status, 400);
  const ex = await call("/api/tools/execute_intent", { method: "POST", headers, body: { confirmationId: prep.json.id } });
  assert.equal(ex.json.dryRun, true);
  const ex2 = await call("/api/tools/execute_intent", { method: "POST", headers, body: { confirmationId: prep.json.id } });
  assert.deepEqual(ex2.json, ex.json, "same Idempotency-Key returns the same result");

  const ro = await createToken({ label: "ro" });
  await setToken(ro.id, { scopes: ["prepare"] });
  assert.equal((await call("/api/tools/execute_intent", { method: "POST", headers: { "x-api-key": ro.token, "idempotency-key": "k2" }, body: { confirmationId: "cf_x" } })).status, 403);
});

test("chat without an API key uses the command parser and makes tickets", async () => {
  const cookie = await signIn();
  const r = await call("/api/chat", { method: "POST", cookie, body: { message: "swap 0.02 eth to usdc on arbitrum" } });
  assert.equal(r.json.mode, "parser");
  assert.equal(r.json.tickets.length, 1);
  assert.equal(r.json.tickets[0].gate.swap.chain, "arbitrum");
  const p = await call("/api/chat", { method: "POST", body: { message: "price eth" } });
  assert.match(p.json.reply, /ETH-PERP/);
});

test("MCP server lists tools and calls a read tool", async () => {
  const child = spawn(process.execPath, [path.resolve("mcp/index.mjs")], { env: { ...process.env, QUILL_URL: base }, stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buf = "";
  const waitFor = (id) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("MCP timeout")), 10000);
    const check = () => { const m = lines.find((l) => l.id === id); if (m) { clearTimeout(t); resolve(m); } else setTimeout(check, 20); };
    check();
  });
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal((await waitFor(1)).result.serverInfo.name, "quill");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await waitFor(2);
  assert.ok(list.result.tools.some((t) => t.name === "quote_swap" && t.annotations.readOnlyHint));
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quote_swap", arguments: { tokenOut: "USDC", amount: "0.01" } } });
  const res = await waitFor(3);
  assert.equal(JSON.parse(res.result.content[0].text).status, "pass");
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "prepare_swap", arguments: { tokenOut: "USDC", amount: "0.01" } } });
  assert.equal((await waitFor(4)).result.isError, true, "prepare needs QUILL_API_KEY");
  child.kill();
});
