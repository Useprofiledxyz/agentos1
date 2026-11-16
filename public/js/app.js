// Quill app: hash-routed views, the agent drawer, and ticket signing in the user's own wallet.
import {
  api, checkpointHtml, connectWallet, disconnectWallet, ensureChain, esc, localStorageGet, localStorageSet,
  price, sendTx, short, signed, state, toast, usd, waitReceipt,
} from "./lib.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const tickets = new Map(); // id → prepare result, for re-render after signing

// ---------------- boot ----------------

async function boot() {
  const theme = localStorageGet("quill.theme");
  if (theme) document.documentElement.dataset.theme = theme;
  $("#themeBtn").onclick = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    localStorageSet("quill.theme", document.documentElement.dataset.theme);
  };

  const [health, chains, me] = await Promise.all([api("/health"), api("/chains"), api("/auth/me").catch(() => ({}))]);
  state.health = health; state.chains = chains; state.address = me.address || null;
  if (!chains.some((c) => c.key === state.chain)) state.chain = "base";
  const sel = $("#chain");
  sel.innerHTML = chains.map((c) => `<option value="${c.key}">${esc(c.name)}</option>`).join("");
  sel.value = state.chain;
  sel.onchange = () => { state.chain = sel.value; localStorageSet("quill.chain", sel.value); route(); };
  if (health.mock) { const p = $("#modePill"); p.hidden = false; p.textContent = "mock data"; p.title = "QUILL_MOCK=1: quotes and chain reads are simulated"; }
  $("#chatMode").textContent = health.llm ? "· AI" : "· command mode";

  renderWallet();
  $("#walletBtn").onclick = onWallet;
  $("#askBtn").onclick = () => openDrawer();
  $("#drawerClose").onclick = closeDrawer;
  $("#scrim").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openDrawer(); }
    if (e.key === "Escape") closeDrawer();
  });
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); sendChat(); };
  $("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  window.ethereum?.on?.("accountsChanged", async (accs) => {
    if (state.address && accs[0]?.toLowerCase() !== state.address) { await disconnectWallet().catch(() => {}); renderWallet(); route(); toast("Wallet changed. Sign in again."); }
  });
  window.addEventListener("hashchange", route);
  route();
}

function renderWallet() {
  const b = $("#walletBtn");
  b.textContent = state.address ? short(state.address) : "Connect wallet";
  b.classList.toggle("primary", !state.address);
  b.title = state.address ? "Signed in. Click to sign out." : "Connect and sign in with your wallet";
}

async function onWallet() {
  try {
    if (state.address) { await disconnectWallet(); toast("Signed out"); }
    else { await connectWallet(); toast(`Signed in as ${short(state.address)}`); }
    renderWallet(); route();
  } catch (e) { toast(e.message || String(e)); }
}

// ---------------- routing ----------------

const ROUTES = { desk, swap, check, markets, limits, journal, api: apiDocs };

function route() {
  const [name, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const r = ROUTES[name] ? name : "desk";
  document.querySelectorAll(".rail a").forEach((a) => a.classList.toggle("on", a.dataset.route === r));
  ROUTES[r](new URLSearchParams(query));
  view.focus({ preventScroll: true });
}

const chainName = () => state.chains.find((c) => c.key === state.chain)?.name || state.chain;

// ---------------- views ----------------

function desk() {
  view.innerHTML = `
    <section class="hero">
      <div>
        <h1>Ask in plain words.<br>Sign only what passed.</h1>
        <p>Quill reads live prices and contracts, runs the <b>Checkpoint</b> on every trade, and writes you a ticket. The agent never holds a key: nothing moves until you sign it in your own wallet.</p>
        <div class="row">
          <button class="btn primary" data-ask="">Ask the agent</button>
          <a class="btn ghost" href="#/swap">Open swap</a>
          <a class="btn ghost" href="#/check">Check a token</a>
        </div>
      </div>
      <div class="flow">
        <div><b>01 READ</b><span>Prices, books, balances and bytecode. Read tools cannot move funds.</span></div>
        <div><b>02 CHECK</b><span>Route, impact, test sell, contract flags, simulation and your limits.</span></div>
        <div><b>03 SIGN</b><span>You review the ticket and sign it. Tickets expire in 10 minutes.</span></div>
      </div>
    </section>
    <div class="grid">
      <div class="card span-7">
        <div class="row between"><h3>Perp pulse</h3><a class="muted" href="#/markets">all →</a></div>
        <div id="pulse"><span class="spinner"></span></div>
      </div>
      <div class="card span-5 stack">
        <h3>Try asking</h3>
        <div class="chips">
          ${["swap 0.01 ETH to USDC", "price BTC", "movers", "funding", "what are my limits?"].map((t) => `<button class="chip" data-ask="${esc(t)}">${esc(t)}</button>`).join("")}
        </div>
        <h3 style="margin-top:8px">Your desk</h3>
        <div id="deskMe" class="muted">${state.address ? '<span class="spinner"></span>' : "Connect a wallet to see your limits and journal."}</div>
      </div>
    </div>`;
  view.querySelectorAll("[data-ask]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.ask)));
  api("/tools/get_movers?limit=6").then((rows) => {
    $("#pulse").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Perp</th><th class="num">Mark</th><th class="num">24h</th><th class="num">Funding APR</th></tr></thead><tbody>${rows.map((m) => `
      <tr><td><b>${esc(m.coin)}</b></td><td class="num">${price(m.markPx)}</td><td class="num">${signed(m.change24hPct)}</td><td class="num">${m.fundingAprPct.toFixed(2)}%</td></tr>`).join("")}</tbody></table></div>`;
  }).catch((e) => ($("#pulse").innerHTML = `<div class="empty">Hyperliquid data unavailable: ${esc(e.message)}</div>`));
  if (state.address) api("/policy").then((p) => {
    $("#deskMe").innerHTML = `<dl class="kv"><dt>Per trade</dt><dd>${usd(p.perTradeUsd)}</dd><dt>Today</dt><dd>${usd(p.usedTodayUsd)} / ${usd(p.dailyUsd)}</dd><dt>Status</dt><dd>${p.killSwitch ? "operator stop" : p.paused ? "paused" : "active"}</dd></dl>`;
  }).catch(() => {});
}

function swap(q) {
  const chain = state.chains.find((c) => c.key === state.chain);
  const known = chain?.tokens || [];
  view.innerHTML = `
    <h1>Swap <span class="muted" style="font-size:.5em">on ${esc(chainName())}</span></h1>
    <div class="grid">
      <form class="card span-5 stack" id="swapForm" autocomplete="off">
        <div class="field"><label for="sIn">You pay</label><input id="sIn" list="known" value="${esc(q.get("in") || "ETH")}" required></div>
        <div class="field"><label for="sAmt">Amount</label><input id="sAmt" inputmode="decimal" value="${esc(q.get("amount") || "0.01")}" pattern="[0-9]*[.]?[0-9]+" required></div>
        <button type="button" class="swap-arrow" id="flip" aria-label="Flip tokens">⇅</button>
        <div class="field"><label for="sOut">You receive</label><input id="sOut" list="known" value="${esc(q.get("out") || "USDC")}" placeholder="symbol or 0x…" required></div>
        <datalist id="known">${known.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
        <div class="field"><label>Slippage</label><div class="seg" id="slip">${[0.5, 1, 3, 5].map((s) => `<button type="button" data-s="${s}" class="${s === 1 ? "on" : ""}">${s}%</button>`).join("")}</div></div>
        <button class="btn primary" type="submit">Check &amp; make ticket</button>
        <p class="muted" style="margin:0;font-size:13px">Routes from KyberSwap. The ticket is re-checked on the live pool right before you sign.</p>
      </form>
      <div class="span-7 stack" id="swapOut"><div class="empty">Enter a pair and press <b>Check &amp; make ticket</b>.</div></div>
    </div>`;
  let slip = 1;
  $("#slip").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; slip = Number(b.dataset.s); $("#slip").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  $("#flip").onclick = () => { const a = $("#sIn").value; $("#sIn").value = $("#sOut").value; $("#sOut").value = a; };
  $("#swapForm").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#swapOut");
    out.innerHTML = `<div class="card"><span class="spinner"></span> Running the Checkpoint…</div>`;
    const args = { chain: state.chain, tokenIn: $("#sIn").value.trim(), tokenOut: $("#sOut").value.trim(), amount: $("#sAmt").value.trim(), slippagePct: slip };
    try {
      if (!state.address) {
        const g = await api(`/tools/quote_swap?${new URLSearchParams(args)}`);
        out.innerHTML = `<div class="card">${quoteHead(g.swap)}${checkpointHtml(g)}<p class="muted">Connect a wallet to turn this into a ticket you can sign.</p></div>`;
        return;
      }
      const t = await api("/swap/prepare", { method: "POST", body: args });
      out.innerHTML = "";
      out.append(ticketCard(t));
    } catch (err) { out.innerHTML = `<div class="card"><div class="verdict fail"><span class="stamp">ERROR</span><span>${esc(err.message)}</span></div></div>`; }
  };
}

function quoteHead(s) {
  if (!s) return "";
  return `<div class="ticket-legs" style="margin-bottom:12px">
    <div class="leg"><b>${esc(s.amountIn)}</b><span>${esc(s.tokenIn.symbol)} · ${usd(s.inUsd)}</span></div><div>→</div>
    <div class="leg"><b>${esc(s.amountOut)}</b><span>${esc(s.tokenOut.symbol)} · ${usd(s.outUsd)}</span></div></div>`;
}

function check(q) {
  view.innerHTML = `
    <h1>Checkpoint</h1>
    <p class="muted">Paste a token contract on ${esc(chainName())}. Quill reads its bytecode and runs a small test buy and test sell: the same checks that run before every swap. A heuristic, not an audit.</p>
    <form class="card row" id="checkForm" style="margin-bottom:16px">
      <input id="addr" placeholder="0x…" style="flex:1;min-width:220px" value="${esc(q.get("address") || "")}" pattern="0x[0-9a-fA-F]{40}" required>
      <button class="btn primary" type="submit">Run checks</button>
    </form>
    <div id="checkOut"></div>`;
  const run = async () => {
    const out = $("#checkOut");
    out.innerHTML = `<div class="card"><span class="spinner"></span> Checking…</div>`;
    try {
      const r = await api(`/tools/check_token?${new URLSearchParams({ chain: state.chain, address: $("#addr").value.trim() })}`);
      out.innerHTML = `<div class="card">
        <div class="row between"><h2>${esc(r.swap?.tokenOut?.symbol || "Token")} <span class="muted mono">${esc(short($("#addr").value.trim()))}</span></h2>
        ${r.health ? `<span class="mono">score ${r.health.score}/100</span>` : ""}</div>
        ${checkpointHtml(r)}
        ${r.health?.flags?.length ? `<h3 style="margin-top:16px">Bytecode flags</h3><ul>${r.health.flags.map((f) => `<li><span class="tag ${f.severity === "info" ? "info" : f.severity}">${esc(f.severity)}</span> ${esc(f.text)}</li>`).join("")}</ul>` : ""}
        <div class="row" style="margin-top:12px"><a class="btn" href="#/swap?in=ETH&out=${esc($("#addr").value.trim())}">Swap into it</a></div>
      </div>`;
    } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $("#checkForm").onsubmit = (e) => { e.preventDefault(); run(); };
  if (q.get("address")) run();
}

async function markets() {
  view.innerHTML = `<h1>Perp data <span class="muted" style="font-size:.5em">Hyperliquid · read-only</span></h1>
    <div class="grid">
      <div class="card span-8"><h3>Movers (24h)</h3><div id="mv"><span class="spinner"></span></div></div>
      <div class="card span-4"><h3>Funding extremes</h3><div id="fx"><span class="spinner"></span></div></div>
      <form class="card span-12 stack" id="simForm">
        <h3>Simulate a fill</h3>
        <div class="row">
          <input id="simCoin" value="ETH" size="8" aria-label="Coin">
          <div class="seg" id="simSide"><button type="button" class="on" data-v="long">long</button><button type="button" data-v="short">short</button></div>
          <input id="simUsd" value="25000" inputmode="decimal" size="10" aria-label="Size in USD">
          <button class="btn primary">Walk the book</button>
        </div>
        <div id="simOut"></div>
      </form>
    </div>`;
  api("/tools/get_movers?limit=15").then((rows) => ($("#mv").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Perp</th><th class="num">Mark</th><th class="num">24h</th><th class="num">Funding APR</th><th class="num">OI</th><th class="num">Volume</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td><b>${esc(m.coin)}</b> <span class="muted">${m.maxLeverage}x</span></td><td class="num">${price(m.markPx)}</td><td class="num">${signed(m.change24hPct)}</td><td class="num">${m.fundingAprPct.toFixed(2)}%</td><td class="num">${usd(m.openInterestUsd)}</td><td class="num">${usd(m.volume24hUsd)}</td></tr>`).join("")}</tbody></table></div>`))
    .catch((e) => ($("#mv").innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  api("/tools/get_funding_extremes?limit=4").then((r) => ($("#fx").innerHTML = `
    <p class="muted" style="margin:0">Longs pay most</p>${r.highest.map((m) => `<div class="row between"><b>${esc(m.coin)}</b><span class="mono up">${m.fundingAprPct.toFixed(1)}%</span></div>`).join("")}
    <p class="muted" style="margin:10px 0 0">Shorts pay most</p>${r.lowest.map((m) => `<div class="row between"><b>${esc(m.coin)}</b><span class="mono down">${m.fundingAprPct.toFixed(1)}%</span></div>`).join("")}`))
    .catch((e) => ($("#fx").innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  let side = "long";
  $("#simSide").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; side = b.dataset.v; $("#simSide").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  $("#simForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/tools/simulate_perp_fill?${new URLSearchParams({ coin: $("#simCoin").value, side, sizeUsd: $("#simUsd").value })}`);
      $("#simOut").innerHTML = `<dl class="kv"><dt>Mid</dt><dd>${price(r.mid)}</dd><dt>Avg fill</dt><dd>${price(r.avgPx)}</dd><dt>Slippage</dt><dd>${r.slippagePct}%</dd><dt>Filled</dt><dd>${usd(r.filledUsd)}${r.fitsVisibleBook ? "" : ` (${usd(r.unfilledUsd)} does not fit the visible book)`}</dd></dl>`;
    } catch (err) { $("#simOut").innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
}

async function limits() {
  if (!state.address) { view.innerHTML = `<h1>Limits</h1><div class="empty">Connect a wallet to see and tighten your limits.</div>`; return; }
  const p = await api("/policy");
  view.innerHTML = `<h1>Limits</h1>
    <p class="muted">The operator sets the ceiling in <code>data/policy.json</code>. You can only make yours stricter. They are enforced by the server on every action, outside the model.</p>
    <div class="grid">
      <form class="card span-7 stack" id="limForm">
        ${[["perTradeUsd", "Per trade (USD)"], ["dailyUsd", "Per day (USD)"], ["maxSlippagePct", "Max slippage (%)"], ["maxPriceImpactPct", "Max price impact (%)"]].map(([k, l]) => `
          <div class="field"><label for="${k}">${l} · ceiling ${p[k]}</label><input id="${k}" inputmode="decimal" value="${p.userLimits[k] ?? ""}" placeholder="${p[k]} (operator)"></div>`).join("")}
        <div class="row"><button class="btn primary">Save limits</button><button type="button" class="btn ${p.paused ? "primary" : ""}" id="pause">${p.paused ? "Resume" : "Pause everything"}</button></div>
      </form>
      <div class="card span-5"><h3>Now</h3><dl class="kv">
        <dt>Used today</dt><dd>${usd(p.usedTodayUsd)}</dd><dt>Kill switch</dt><dd>${p.killSwitch ? "ON" : "off"}</dd><dt>Paused</dt><dd>${p.paused ? "yes" : "no"}</dd>
        <dt>Chains</dt><dd>${p.allowedChains.join(", ")}</dd><dt>Blocked tokens</dt><dd>${p.blockedTokens.length || "none"}</dd></dl></div>
    </div>`;
  $("#limForm").onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of ["perTradeUsd", "dailyUsd", "maxSlippagePct", "maxPriceImpactPct"]) { const v = $(`#${k}`).value.trim(); patch[k] = v === "" ? null : Number(v); }
    await api("/policy", { method: "POST", body: patch }); toast("Limits saved"); limits();
  };
  $("#pause").onclick = async () => { await api("/policy", { method: "POST", body: { paused: !p.paused } }); toast(p.paused ? "Resumed" : "Paused"); limits(); };
}

async function journal() {
  if (!state.address) { view.innerHTML = `<h1>Journal</h1><div class="empty">Connect a wallet to see your journal.</div>`; return; }
  const rows = await api("/journal?limit=100");
  view.innerHTML = `<h1>Journal</h1><div class="card table-wrap">${rows.length ? `<table><thead><tr><th>When</th><th>Stage</th><th>Outcome</th><th>Trade</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td class="mono">${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.stage)}</td><td><span class="tag ${r.outcome === "blocked" ? "fail" : r.outcome === "sent" ? "pass" : "info"}">${esc(r.outcome)}</span></td>
    <td>${r.params ? esc(`${r.params.amount} ${short(r.params.tokenIn)} → ${short(r.params.tokenOut)} (${r.params.chain})`) : ""}</td>
    <td class="muted">${r.hash ? `<code>${esc(short(r.hash))}</code>` : esc(r.reason || r.gateStatus || "")}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Nothing yet.</div>`}</div>`;
}

function apiDocs() {
  const origin = location.origin;
  view.innerHTML = `<h1>API &amp; MCP</h1>
    <div class="grid"><div class="card span-12">
      <p>Every tool the agent uses is also a REST endpoint and an MCP tool. Read tools are public. Prepare tools need an API token; execute needs the <code>execute</code> scope and an <code>Idempotency-Key</code>. New tokens start in dry-run.</p>
      <h3>Create a token (on the server)</h3>
      <pre class="code">npm run token -- my-laptop --owner 0xYourWallet</pre>
      <h3>REST</h3>
      <pre class="code">GET  ${esc(origin)}/api/tools                          # list tools, tiers, schemas
GET  ${esc(origin)}/api/tools/quote_swap?tokenIn=ETH&amp;tokenOut=USDC&amp;amount=0.01
POST ${esc(origin)}/api/tools/prepare_swap   x-api-key   {"tokenOut":"USDC","amount":"0.01"}
POST ${esc(origin)}/api/tools/execute_intent x-api-key + Idempotency-Key  {"confirmationId":"cf_…"}</pre>
      <h3>MCP (Claude Code)</h3>
      <pre class="code">claude mcp add quill --env QUILL_URL=${esc(origin)} --env QUILL_API_KEY=quill_… -- node /path/to/quill/mcp/index.mjs</pre>
      <h3>Tools</h3><div id="toolList"><span class="spinner"></span></div>
    </div></div>`;
  api("/tools").then((ts) => ($("#toolList").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Tool</th><th>Tier</th><th>What it does</th></tr></thead><tbody>${ts.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><span class="tag ${t.tier === "read" ? "pass" : t.tier === "prepare" ? "warn" : "fail"}">${esc(t.tier)}</span></td><td>${esc(t.description)}</td></tr>`).join("")}</tbody></table></div>`));
}

// ---------------- tickets ----------------

function ticketCard(t) {
  const el = document.createElement("div");
  el.className = "ticket";
  const render = (status = "") => {
    const s = t.gate?.swap;
    const expired = t.expiresAt && Date.parse(t.expiresAt) < Date.now();
    el.innerHTML = `
      <div class="ticket-head"><span>Ticket ${t.ok ? esc(t.id.slice(0, 9)) : "· blocked"}</span><span>${s ? esc(s.chainName) : ""}</span></div>
      <div class="ticket-body">
        ${s ? quoteHead(s) : ""}
        ${checkpointHtml(t.gate)}
        ${t.ok ? `<div class="ticket-perf">
          <span class="muted" style="margin-right:auto;font-size:13px">${expired ? "Expired" : `Valid until ${new Date(t.expiresAt).toLocaleTimeString()}`} · slippage ${s.slippagePct}%</span>
          ${status ? `<span>${status}</span>` : `<button class="btn primary" data-sign ${expired ? "disabled" : ""}>Re-check &amp; sign</button>`}
        </div>` : ""}
      </div>`;
    el.querySelector("[data-sign]")?.addEventListener("click", () => signTicket(t, render));
  };
  tickets.set(t.id, t);
  render();
  return el;
}

async function signTicket(t, render) {
  try {
    if (!state.address) { await connectWallet(); renderWallet(); }
    render('<span class="spinner"></span> Re-checking on the live pool…');
    const b = await api(`/tickets/${t.id}/build`, { method: "POST", body: {} });
    if (!b.ok) { t.gate = b.gate; t.ok = false; render(); toast(b.reason); return; }
    t.gate = b.gate;
    await ensureChain(b.chainId);
    let last;
    for (const [i, tx] of b.txs.entries()) {
      render(`<span class="spinner"></span> ${esc(tx.label)}: confirm in your wallet (${i + 1}/${b.txs.length})`);
      const hash = await sendTx(tx);
      render(`<span class="spinner"></span> ${esc(tx.label)}: waiting for the chain…`);
      await waitReceipt(hash);
      last = hash;
    }
    await api(`/tickets/${t.id}/sent`, { method: "POST", body: { hash: last } });
    render(`✓ Done · <a href="${esc(b.explorer)}/tx/${esc(last)}" target="_blank" rel="noopener">view transaction</a>`);
    toast("Swap confirmed");
  } catch (e) {
    render(`<span class="down">${esc(e.message || String(e))}</span>`);
  }
}

// ---------------- agent drawer ----------------

let sessionId = null;

function openDrawer(prefill) {
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#scrim").hidden = false;
  const log = $("#chatLog");
  if (!log.children.length) addMsg("bot", state.health?.llm
    ? "Ask me for prices, a token check or a swap. I prepare tickets; you sign them."
    : "AI chat is off on this server, so I take commands: swap 0.01 ETH to USDC · check 0x… · price BTC · movers · funding · limits.");
  if (prefill != null) { $("#chatInput").value = prefill; if (prefill) sendChat(); }
  $("#chatInput").focus();
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").hidden = true; }

function addMsg(who, text, extra = "") {
  const d = document.createElement("div");
  d.className = `msg ${who}`;
  d.textContent = text;
  if (extra) d.insertAdjacentHTML("beforeend", extra);
  $("#chatLog").append(d);
  $("#chatLog").scrollTop = 1e9;
  return d;
}

async function sendChat() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMsg("user", text);
  const wait = addMsg("bot thinking", "Working…");
  try {
    const r = await api("/chat", { method: "POST", body: { message: text, sessionId } });
    sessionId = r.sessionId || sessionId;
    wait.remove();
    addMsg("bot", r.reply || "(no reply)", r.tools?.length ? `<span class="tools">tools: ${r.tools.map(esc).join(", ")}</span>` : "");
    for (const t of r.tickets || []) { $("#chatLog").append(ticketCard(t)); $("#chatLog").scrollTop = 1e9; }
  } catch (e) { wait.remove(); addMsg("bot", `Error: ${e.message}`); }
}

boot().catch((e) => { view.innerHTML = `<div class="empty">Could not start: ${esc(e.message)}</div>`; });
