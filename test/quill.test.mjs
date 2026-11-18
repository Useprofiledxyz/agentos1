// End-to-end tests in mock mode: no network, no real chain. Run with `npm test`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";

process.env.QUILL_MOCK = "1";
process.env.QUILL_DATA = mkdtempSync(path.join(tmpdir(), "quill-test-"));
delete process.env.ANTHROPIC_API_KEY;

const { parseUnits, formatUnits } = await import("../src/units.mjs");
const { verifySignature } = await import("../src/auth.mjs");
const { gateSwap } = await import("../src/sol/gate.mjs");
const { MOCK_RISKY, MOCK_COIN, TSLAX } = await import("../src/sol/mock.mjs");
const { encode58 } = await import("../src/sol/base58.mjs");
const { writeJson } = await import("../src/store.mjs");
const { DEFAULT_POLICY } = await import("../src/policy.mjs");
const { createToken, setToken } = await import("../src/apitokens.mjs");
const { server } = await import("../server.mjs");

// Test wallet: a fixed ed25519 key, like a Phantom account
const SK = new Uint8Array(32).fill(3);
const ADDR = encode58(ed25519.getPublicKey(SK));
function personalSign(message) {
  return Buffer.from(ed25519.sign(new TextEncoder().encode(message), SK)).toString("base64");
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

test("Solana sign-in signature verifies for the right wallet only", () => {
  assert.equal(verifySignature("hello", personalSign("hello"), ADDR), true);
  assert.equal(verifySignature("hello!", personalSign("hello"), ADDR), false);
});

test("Checkpoint passes a liquid pair", async () => {
  const g = await gateSwap({ tokenIn: "SOL", tokenOut: "USDC", amount: "0.5" });
  assert.equal(g.status, "pass");
  assert.equal(g.chain, "solana");
  assert.ok(g.checks.find((c) => c.id === "route" && c.status === "pass"));
});

test("Checkpoint flags a taxed token with live authorities", async () => {
  const g = await gateSwap({ tokenIn: "SOL", tokenOut: MOCK_RISKY, amount: "0.1" });
  assert.notEqual(g.status, "pass");
  const tok = g.checks.find((c) => c.id.startsWith("token_"));
  assert.match(tok.detail, /Freeze authority is live/);
  assert.match(tok.detail, /transfer fee/);
  assert.notEqual(g.checks.find((c) => c.id === "test_sell").status, "pass");
});

test("Checkpoint fails a trade over the per-trade cap", async () => {
  await writeJson("policy.json", { ...DEFAULT_POLICY, perTradeUsd: 100 });
  try {
    const g = await gateSwap({ tokenIn: "SOL", tokenOut: "USDC", amount: "1" }); // $150
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

  const t = await call("/api/swap/prepare", { method: "POST", cookie, body: { tokenIn: "USDC", tokenOut: "TSLAx", amount: "50" } });
  assert.equal(t.json.ok, true);
  assert.match(t.json.id, /^tk_/);

  const b = await call(`/api/tickets/${t.json.id}/build`, { method: "POST", cookie, body: {} });
  assert.equal(b.json.ok, true);
  assert.equal(b.json.chain, "solana");
  assert.equal(b.json.txs.length, 1);
  assert.ok(Buffer.from(b.json.txs[0].tx, "base64").length > 10, "a serialized Solana transaction");
  assert.match(b.json.explorer, /solscan/);

  const again = await call(`/api/tickets/${t.json.id}/build`, { method: "POST", cookie, body: {} });
  assert.equal(again.status, 409, "tickets are single use");

  const hash = encode58(new Uint8Array(64).fill(5));
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
  const r = await call("/api/chat", { method: "POST", cookie, body: { message: "swap 0.2 sol to usdc" } });
  assert.equal(r.json.mode, "parser");
  assert.equal(r.json.tickets.length, 1);
  assert.equal(r.json.tickets[0].gate.swap.chain, "solana");
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
  try {
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
  } finally { child.kill(); }
});

test("Solana is the chain: base tokens and xStocks resolve, symbols like TSLA map to TSLAx", async () => {
  const g = await gateSwap({ tokenIn: "SOL", tokenOut: "TSLA", amount: "0.1" });
  assert.equal(g.swap.chainName, "Solana");
  assert.equal(g.swap.tokenOut.address, TSLAX);
  const tokens = await call("/api/tokens");
  assert.equal(tokens.json.chain, "solana");
  assert.ok(tokens.json.stocks.some((s) => s.symbol === "NVDAx"));
  const r = await call("/api/chat", { method: "POST", body: { message: "buy NVDAx with 0.1 SOL" } });
  assert.equal(r.json.tickets[0].gate.swap.chain, "solana");
});

test("onchain live tools: pools, token, stocks, chain status, portfolio and chat commands", async () => {
  const tr = await call("/api/tools/onchain_pools?kind=trending&limit=3");
  assert.equal(tr.json.pools.length, 3);
  assert.ok(tr.json.pools[0].token.symbol);
  assert.equal((await call("/api/tools/onchain_pools?kind=bogus")).status, 400);
  const tk = await call(`/api/tools/onchain_token?address=${MOCK_COIN}`);
  assert.equal(tk.json.token.symbol, "QUILL");
  assert.ok(tk.json.totals.volume24hUsd > 0);
  const st = await call("/api/tools/stock_prices");
  assert.equal(st.json.stocks.length, 20);
  assert.ok(st.json.stocks.find((s) => s.symbol === "TSLAx").priceUsd > 0);
  assert.ok((await call("/api/tools/chain_status")).json.slot > 0);
  const pf = await call(`/api/tools/get_portfolio?address=${ADDR}`);
  assert.ok(pf.json.holdings.some((h) => h.symbol === "SOL") && pf.json.holdings.some((h) => h.symbol === "TSLAx"));
  const chat = await call("/api/chat", { method: "POST", body: { message: "what's trending?" } });
  assert.match(chat.json.reply, /Trending on Solana/);
  const np = await call("/api/chat", { method: "POST", body: { message: "show new pairs" } });
  assert.match(np.json.reply, /Newest pairs/);
});

test("homepage and app shell are served", async () => {
  const home = await fetch(base + "/");
  assert.match(await home.text(), /The trading desk/);
  const redirect = await fetch(base + "/app", { redirect: "manual" });
  assert.equal(redirect.status, 301);
  const app = await fetch(base + "/app/");
  assert.match(await app.text(), /Onchain live/);
});

test("logo endpoint always returns an image", async () => {
  const r = await fetch(base + `/api/logo/${encode58(new Uint8Array(32).fill(11))}?s=ZZ`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^image\//);
  assert.match(r.headers.get("cache-control"), /public/);
  const svg = await r.text();
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<script/i);
  const evil = await (await fetch(base + `/api/logo/${encode58(new Uint8Array(32).fill(12))}?s=` + encodeURIComponent("<b>&"))).text();
  assert.doesNotMatch(evil, /<b>/);
  assert.equal((await fetch(base + "/api/logo/nope")).status, 404);
});

test("AI chat: workspace header is sent, and an API error falls back to command mode", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const fake = createServer((req, res) => {
    seen.push(req.headers["anthropic-workspace-id"] || null);
    res.writeHead(400, { "content-type": "application/json", "request-id": "req_test" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header." } }));
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.address().port}`, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" });
  try {
    const r = await call("/api/chat", { method: "POST", body: { message: "buy TSLAx with 0.1 SOL" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, "parser");
    assert.match(r.json.reply, /AI chat is unavailable: .*workspace/);
    assert.equal(r.json.tickets.length, 1, "command mode still prepares the ticket");
    assert.equal(seen[0], "wrkspc_test");
  } finally {
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_WORKSPACE_ID"]) delete process.env[k];
    fake.close();
  }
});
