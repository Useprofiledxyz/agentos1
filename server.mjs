// Quill: static app + JSON API on one port.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, llmOn } from "./src/agent.mjs";
import { findToken } from "./src/apitokens.mjs";
import { clearCookie, logout, newNonce, sessionAddress, sessionCookie, verifyLogin } from "./src/auth.mjs";
import { publicChains } from "./src/chains.mjs";
import { secretSource } from "./src/seal.mjs";
import { logoResponse } from "./src/logos.mjs";
import { buildTicket, getIntent, markSent, prepareSwap } from "./src/intents.mjs";
import { readJournal } from "./src/journal.mjs";
import { MOCK } from "./src/mock.mjs";
import { getPolicy, setUserLimits } from "./src/policy.mjs";
import { TOOL_MAP, coerceArgs, publicToolList } from "./src/tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
// Hosting platforms (Railway, Render, Fly, Heroku…) set PORT and route traffic through their proxy, so the server must
// listen on all interfaces there. Locally it stays on 127.0.0.1 unless HOST says otherwise.
const ON_PLATFORM = !!(process.env.PORT || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME || process.env.DYNO);
const PORT = Number(process.env.PORT || 9330);
const HOST = process.env.HOST || (ON_PLATFORM ? "0.0.0.0" : "127.0.0.1");
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === "1" : ON_PLATFORM;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// Idempotency for execute calls: same key → same response for 10 minutes.
const idem = new Map();

// Read tools whose answer does not depend on who asks, and how long (seconds) a shared cache may keep them.
const PUBLIC_CACHE = { onchain_pools: 30, onchain_token: 30, stock_prices: 60, chain_status: 3, list_chains: 3600, analyze_ticker: 15, get_movers: 30, get_funding_extremes: 60, token_health: 300 };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json(body));
}

async function body(req, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

const clientIp = (req) => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, "");
  const q = Object.fromEntries(url.searchParams);
  const wallet = sessionAddress(req); // signed-in wallet (cookie session), or null

  // Browser POSTs must be JSON: a cross-site form cannot send that without a CORS preflight, which this server never grants.
  if (req.method === "POST" && !req.headers["x-api-key"] && !String(req.headers["content-type"] || "").startsWith("application/json")) {
    return send(res, 415, { error: "Send application/json" });
  }

  if (p === "/auth/nonce" && req.method === "POST") return send(res, 200, newNonce((await body(req)).address, req.headers.host));
  if (p === "/auth/verify" && req.method === "POST") {
    const v = verifyLogin(await body(req));
    const https = TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
    return send(res, 200, { address: v.address }, { "set-cookie": sessionCookie(v.token, { secure: https }) });
  }
  if (p === "/auth/me") return send(res, 200, { address: wallet });
  if (p === "/auth/logout" && req.method === "POST") { logout(); return send(res, 200, { ok: true }, { "set-cookie": clearCookie() }); }

  if (p === "/health") return send(res, 200, { ok: true, llm: llmOn(), mock: MOCK, secret: secretSource, chains: publicChains().map((c) => c.key) });
  if (p === "/chains") return send(res, 200, publicChains());

  // GET /api/logo/:address?s=SYMBOL — token or stock logo (proxied image, or a generated avatar).
  const lg = p.match(/^\/logo\/(0x[0-9a-fA-F]{40})(?:\.png)?$/);
  if (lg && (req.method === "GET" || req.method === "HEAD")) {
    const r = await logoResponse(lg[1], String(q.s || "").slice(0, 12));
    res.writeHead(r.status, r.headers);
    return res.end(req.method === "HEAD" ? undefined : r.body);
  }
  if (p === "/tools" && req.method === "GET") return send(res, 200, publicToolList());

  // GET /api/tools/:name?arg=… (read) · POST /api/tools/:name {args} (prepare/execute with x-api-key)
  const m = p.match(/^\/tools\/([a-z_]+)$/);
  if (m) {
    const tool = TOOL_MAP[m[1]];
    if (!tool) return send(res, 404, { error: `Unknown tool ${m[1]}` });
    const args = coerceArgs(tool, req.method === "POST" ? await body(req) : q);
    if (tool.tier === "read") {
      // Public market data is the same for everyone: let the CDN (Vercel edge, a proxy) and browsers cache it briefly so
      // many visitors cost one upstream call. Anything that depends on the signed-in wallet stays no-store.
      const ttl = PUBLIC_CACHE[tool.name];
      const headers = ttl ? { "cache-control": `public, max-age=${Math.min(ttl, 10)}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` } : {};
      return send(res, 200, await tool.run(args, { address: ttl ? null : wallet, surface: "api" }), headers);
    }
    if (req.method !== "POST") return send(res, 405, { error: "Use POST for prepare and execute tools" });
    const tok = await findToken(req.headers["x-api-key"]);
    if (!tok) return send(res, 401, { error: "x-api-key required (create one with: npm run token)" });
    if (!tok.scopes.includes(tool.tier)) return send(res, 403, { error: `This token lacks the ${tool.tier} scope` });
    const ctx = { address: tok.owner, owner: tok.owner || tok.id, surface: "api", dryRun: tok.dryRun };
    if (tool.tier === "execute") {
      const key = req.headers["idempotency-key"];
      if (!key) return send(res, 400, { error: "Idempotency-Key header required" });
      const k = `${tok.id}:${key}`, hit = idem.get(k);
      if (hit && Date.now() - hit.t < 600_000) return send(res, 200, hit.v);
      const v = await tool.run(args, ctx);
      idem.set(k, { t: Date.now(), v });
      return send(res, 200, v);
    }
    return send(res, 200, await tool.run(args, ctx));
  }

  if (p === "/chat" && req.method === "POST") {
    const b = await body(req);
    return send(res, 200, await chat({ sessionId: b.sessionId, message: b.message, address: wallet, ip: clientIp(req) }));
  }

  if (p === "/swap/prepare" && req.method === "POST") {
    if (!wallet) return send(res, 401, { error: "Sign in with your wallet to make a ticket" });
    const b = await body(req);
    return send(res, 200, await prepareSwap({ chain: b.chain, tokenIn: b.tokenIn, tokenOut: b.tokenOut, amount: b.amount, slippagePct: b.slippagePct, sender: wallet }, { kind: "ticket", owner: wallet }));
  }

  const t = p.match(/^\/tickets\/([A-Za-z0-9_.-]+)(\/build|\/sent)?$/);
  if (t) {
    if (!t[2] && req.method === "GET") { const x = getIntent(t[1]); return x ? send(res, 200, x) : send(res, 404, { error: "Unknown or expired ticket" }); }
    if (!t[1].startsWith("tk_")) return send(res, 400, { error: "Only chat tickets can be signed here; API ids go through execute_intent" });
    if (t[2] === "/build" && req.method === "POST") return send(res, 200, await buildTicket(t[1], wallet));
    if (t[2] === "/sent" && req.method === "POST") return send(res, 200, await markSent(t[1], { owner: wallet, hash: (await body(req)).hash }));
  }

  if (p === "/policy") {
    if (req.method === "GET") return send(res, 200, await getPolicy(wallet));
    if (req.method === "POST") {
      if (!wallet) return send(res, 401, { error: "Sign in with your wallet to set personal limits" });
      await setUserLimits(wallet, await body(req));
      return send(res, 200, await getPolicy(wallet));
    }
  }
  if (p === "/journal") return send(res, 200, wallet ? await readJournal({ owner: wallet, limit: Number(q.limit) || 50 }) : []);

  return send(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/app") { res.writeHead(301, { location: "/app/" + url.search }); return res.end(); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    return res.end(await readFile(file));
  } catch {
    // SPA: unknown paths without an extension get the app shell
    if (!path.extname(rel)) { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(await readFile(path.join(PUBLIC, "index.html"))); }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found");
  }
}

/** The request handler: used by the long-running server below and by serverless entries (api/index.js on Vercel). */
export async function handler(req, res) {
  const url = new URL(req.url, "http://local");
  // Vercel rewrites /api/* to the function and passes the original path as __path.
  if (url.searchParams.has("__path")) { url.pathname = "/api/" + url.searchParams.get("__path"); url.searchParams.delete("__path"); }
  try {
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: String(e.message || e).slice(0, 300) });
  }
}

export const server = createServer(handler);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  server.listen(PORT, HOST, () => console.log(`Quill on http://${HOST}:${PORT}  (AI chat: ${llmOn() ? "on" : "off, parser mode"}${MOCK ? ", MOCK data" : ""})`));
}
