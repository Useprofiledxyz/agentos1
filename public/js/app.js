// Quill app: hash-routed views, live Robinhood Chain data, the agent drawer, and ticket signing in the user's own wallet.
import {
  ago, api, avatar, checkpointHtml, connectWallet, disconnectWallet, ensureChain, esc, fmtPrice, initTheme,
  sendTx, short, signed, state, toast, usd, waitReceipt,
} from "./lib.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
let timers = []; // per-view refresh intervals, cleared on navigation
const every = (ms, fn) => { timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); };

// ---------------- boot ----------------

async function boot() {
  initTheme($("#themeBtn"));
  const [health, chains, me] = await Promise.all([api("/health"), api("/chains"), api("/auth/me").catch(() => ({}))]);
  state.health = health; state.chains = chains; state.address = me.address || null;
  // The website is Robinhood Chain only. (The API still accepts base, arbitrum and ethereum for developers.)
  state.chain = "robinhood";
  if (health.mock) { const p = $("#modePill"); p.hidden = false; p.textContent = "demo data"; p.title = "QUILL_MOCK=1: quotes and chain reads are simulated"; }
  $("#chatMode").textContent = health.llm ? "AI" : "command mode";

  renderWallet();
  $("#walletBtn").onclick = onWallet;
  $("#askBtn").onclick = () => openDrawer();
  $("#drawerClose").onclick = closeDrawer;
  $("#scrim").onclick = () => { closeDrawer(); document.body.classList.remove("nav-open"); };
  $("#menuBtn").onclick = () => { document.body.classList.toggle("nav-open"); $("#scrim").hidden = !document.body.classList.contains("nav-open"); };
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
  tickBlock(); setInterval(() => !document.hidden && tickBlock(), 6000);
  route();
}

async function tickBlock() {
  try {
    const s = await api("/tools/chain_status");
    $("#blockNum").textContent = "Robinhood Chain · live";
    $("#blockPill").title = `Live on Robinhood Chain. Latest block #${s.block.toLocaleString("en-US")}, ${s.ageSec}s ago, base fee ${s.baseFeeGwei?.toFixed(4)} gwei. Click to open it in the explorer.`;
    $("#blockPill").href = `https://robinhoodchain.blockscout.com/block/${s.block}`;
    $("#blockPill").classList.remove("offline");
  } catch { $("#blockNum").textContent = "Robinhood Chain · offline"; $("#blockPill").classList.add("offline"); }
}

function renderWallet() {
  const b = $("#walletBtn");
  b.textContent = state.address ? short(state.address) : "Connect wallet";
  b.classList.toggle("primary", !state.address);
  b.title = state.address ? "Signed in. Click to sign out." : "Connect and sign in with your wallet";
  document.body.classList.toggle("locked", !state.address);
}

async function onWallet() {
  try {
    if (state.address) { await disconnectWallet(); toast("Signed out"); }
    else { await connectWallet(); toast(`Signed in as ${short(state.address)}`); }
    renderWallet(); route();
  } catch (e) { toast(e.message || String(e)); }
}

// ---------------- routing ----------------

// The whole app needs a connected wallet; the homepage at / stays public.
const OPEN_ROUTES = new Set();
const ROUTE_NAMES = { desk: "The desk", swap: "Swap", check: "Checkpoint", live: "Onchain live", new: "New pairs", stocks: "Stocks", token: "Token", portfolio: "Portfolio", limits: "Limits", journal: "Journal", api: "API & MCP", ask: "The agent" };

function gate(r) {
  const hasWallet = !!window.ethereum;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const dappUrl = location.host + location.pathname + location.hash;
  view.innerHTML = `
    <section class="gate">
      <div class="gate-card card">
        <img src="/img/quill.svg" alt="" width="56" height="56">
        <span class="eyebrow">${esc(ROUTE_NAMES[r] || "Quill")} is locked</span>
        <h1>Connect your wallet<br><em>to open the desk.</em></h1>
        <p>Signing in is a free signature over a one-time message. It cannot move funds, and Quill never sees your keys.</p>
        <button class="btn primary" id="gateConnect" type="button" style="padding:14px 22px">${hasWallet ? "Connect wallet" : "Connect wallet"}</button>
        ${!hasWallet ? `<p class="muted" style="font-size:13.5px;margin:4px 0 0">No browser wallet found. ${mobile
          ? `Open Quill in your wallet app: <a href="https://metamask.app.link/dapp/${esc(dappUrl)}" style="text-decoration:underline">MetaMask</a> · <a href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}" style="text-decoration:underline">Coinbase Wallet</a>`
          : `Install <a href="https://metamask.io/download/" target="_blank" rel="noopener" style="text-decoration:underline">MetaMask</a> or <a href="https://rabby.io" target="_blank" rel="noopener" style="text-decoration:underline">Rabby</a>, then come back.`}</p>` : ""}
        <ul class="gate-list">
          <li>Swap coins, USDG and tokenized stocks on Robinhood Chain</li>
          <li>Run the Checkpoint on any token</li>
          <li>Onchain live, new pairs, stocks and your portfolio</li>
          <li>Ask the agent; it writes tickets you sign</li>
        </ul>
      </div>
    </section>`;
  $("#gateConnect").onclick = onWallet;
}

const ROUTES = { desk, swap, check, live, new: newPairs, stocks: stocksView, token: tokenView, portfolio, limits, journal, api: apiDocs };

function route() {
  timers.forEach(clearInterval); timers = [];
  document.body.classList.remove("nav-open"); $("#scrim").hidden = !$("#drawer").classList.contains("open");
  const [name, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const r = ROUTES[name] ? name : "desk";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === r || (r === "token" && a.dataset.route === "live")));
  if (!state.address && !OPEN_ROUTES.has(r)) gate(r);
  else ROUTES[r](new URLSearchParams(query));
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

const chainName = () => state.chains.find((c) => c.key === state.chain)?.name || state.chain;
const head = (title, sub, right = "") => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${right}</div>`;
const errorBox = (e) => `<div class="empty">${esc(e.message || e)}</div>`;

// ---------------- pool tables ----------------

function poolRows(pools, { showAge = false } = {}) {
  if (!pools.length) return `<div class="empty">No pools right now.</div>`;
  return `<div class="table-wrap"><table><thead><tr>
    <th>Token</th><th class="num">Price</th><th class="num hide-sm">5m</th><th class="num">1h</th><th class="num">24h</th>
    <th class="num">Volume</th><th class="num hide-sm">Liquidity</th><th class="num hide-sm">${showAge ? "Age" : "FDV"}</th><th class="num hide-sm">Txns</th></tr></thead><tbody>
    ${pools.map((p) => `
    <tr class="clickable" data-token="${esc(p.token.address || "")}">
      <td><div class="token-cell">${avatar(p.token.symbol, p.token.address)}<div><b>${esc(p.token.symbol)}${p.token.stock ? ' <span class="tag neutral">stock</span>' : ""}</b><small>${esc(p.dex)}${p.token.name && p.token.name !== p.token.symbol ? ` · ${esc(p.token.name)}` : ""}</small></div></div></td>
      <td class="num">${fmtPrice(p.priceUsd)}</td>
      <td class="num hide-sm">${signed(p.change.m5)}</td><td class="num">${signed(p.change.h1)}</td><td class="num">${signed(p.change.h24)}</td>
      <td class="num">${usd(p.volume24hUsd)}</td><td class="num hide-sm">${usd(p.liquidityUsd)}</td>
      <td class="num hide-sm">${showAge ? ago(p.createdAt) : usd(p.fdvUsd)}</td>
      <td class="num hide-sm"><span class="up">${p.txns24h.buys ?? "–"}</span><span class="faint"> / </span><span class="down">${p.txns24h.sells ?? "–"}</span></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function bindTokenRows(el) {
  el.querySelectorAll("tr[data-token]").forEach((tr) => tr.addEventListener("click", () => { if (tr.dataset.token) location.hash = `#/token?address=${tr.dataset.token}`; }));
}

async function loadPools(target, kind, limit, opts) {
  try {
    const r = await api(`/tools/onchain_pools?kind=${kind}&limit=${limit}`);
    target.innerHTML = poolRows(r.pools, opts) + (r.stale ? `<p class="muted" style="font-size:12px;margin:10px 0 0">Showing the last good copy: the data source is busy.</p>` : "");
    bindTokenRows(target);
    return r;
  } catch (e) { target.innerHTML = errorBox(e); }
}

// ---------------- views ----------------

function desk() {
  view.innerHTML = `
    <section class="desk-hero">
      <div class="card intro">
        <span class="eyebrow">Robinhood Chain desk</span>
        <h1 style="margin-top:14px">Ask in plain words.<br><em>Sign only what passed.</em></h1>
        <p>Coins, USDG and tokenized stocks on Robinhood Chain. Quill reads the chain, runs the Checkpoint on every trade and writes you a ticket. The agent never holds a key.</p>
        <div class="row">
          <button class="btn primary" data-ask="">✎ Ask Quill</button>
          <a class="btn" href="#/swap">Swap</a>
          <a class="btn ghost" href="#/live">Onchain live →</a>
        </div>
      </div>
      <div class="card">
        <div class="panel-head"><span class="panel-title">How a trade flows</span></div>
        <div class="steps">
          <div class="step"><b>01</b><div><strong>Read</strong><span>Live pools, prices, balances and bytecode. Read tools cannot move funds.</span></div></div>
          <div class="step"><b>02</b><div><strong>Check</strong><span>Route, test sell, contract flags, simulation and your limits.</span></div></div>
          <div class="step"><b>03</b><div><strong>Sign</strong><span>Re-checked on the live pool, then signed in your own wallet.</span></div></div>
        </div>
      </div>
    </section>
    <div class="stats" id="deskStats">${["Block", "Base fee", "Top 24h volume", "Your desk"].map((k) => `<div class="card stat"><div class="k">${k}</div><div class="v"><div class="skeleton" style="width:60%;height:22px"></div></div></div>`).join("")}</div>
    <div class="grid">
      <div class="card span-8">
        <div class="panel-head"><span class="panel-title"><i class="live-dot"></i>&nbsp; Trending on Robinhood Chain</span><a class="muted" href="#/live" style="font-size:13px">All →</a></div>
        <div id="deskTrending"><div class="skeleton"></div></div>
      </div>
      <div class="card span-4 stack">
        <div class="panel-head" style="margin:0"><span class="panel-title">Try asking</span></div>
        <div class="chips">${["buy TSLA with 0.01 ETH", "swap 0.01 ETH to USDG", "what's trending?", "check 0x020bfc650a365f8bb26819deaabf3e21291018b4", "my limits"].map((t) => `<button class="chip" data-ask="${esc(t)}">${esc(t.length > 30 ? t.slice(0, 28) + "…" : t)}</button>`).join("")}</div>
        <div class="panel-head" style="margin:10px 0 0"><span class="panel-title">Stocks</span><a class="muted" href="#/stocks" style="font-size:13px">All →</a></div>
        <div id="deskStocks"><div class="skeleton"></div></div>
      </div>
    </div>`;
  view.querySelectorAll("[data-ask]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.ask)));
  const stats = async () => {
    const [s, top, pol] = await Promise.all([api("/tools/chain_status").catch(() => null), api("/tools/onchain_pools?kind=top&limit=1").catch(() => null), state.address ? api("/policy").catch(() => null) : null]);
    const cells = $("#deskStats").children;
    if (s) { cells[0].innerHTML = `<div class="k"><i class="live-dot"></i> Block</div><div class="v">#${s.block.toLocaleString("en-US")}</div><div class="s">${s.ageSec}s ago · ${s.txCount ?? "–"} txs</div>`; cells[1].innerHTML = `<div class="k">Base fee</div><div class="v">${s.baseFeeGwei?.toFixed(4)}</div><div class="s">gwei · gas in ETH</div>`; }
    const t = top?.pools?.[0];
    cells[2].innerHTML = t ? `<div class="k">Top 24h volume</div><div class="v">${usd(t.volume24hUsd)}</div><div class="s">${esc(t.token.symbol)} · ${esc(t.dex)}</div>` : `<div class="k">Top 24h volume</div><div class="v">–</div>`;
    cells[3].innerHTML = pol ? `<div class="k">Your desk</div><div class="v">${usd(pol.usedTodayUsd)}</div><div class="s">of ${usd(pol.dailyUsd)} today · ${pol.paused ? "paused" : "active"}</div>` : `<div class="k">Your desk</div><div class="v" style="font-size:18px">Not signed in</div><div class="s">Connect to see limits</div>`;
  };
  const trending = () => loadPools($("#deskTrending"), "trending", 8);
  const st = async () => {
    try {
      const r = await api("/tools/stock_prices");
      const pick = r.stocks.filter((s) => s.priceUsd != null).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).slice(0, 6);
      $("#deskStocks").innerHTML = pick.map((s) => `<a class="row between" href="#/token?address=${esc(s.address)}" style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="token-cell">${avatar(s.symbol, s.address)}<span><b>${esc(s.symbol)}</b><small>${esc(s.name)}</small></span></span><span class="num" style="text-align:right">${fmtPrice(s.priceUsd)}<br>${signed(s.change24hPct)}</span></a>`).join("");
    } catch (e) { $("#deskStocks").innerHTML = errorBox(e); }
  };
  stats(); trending(); st();
  every(15000, stats); every(30000, trending);
}

function live(q) {
  const kind = ["trending", "top", "new"].includes(q.get("kind")) ? q.get("kind") : "trending";
  view.innerHTML = head(`Onchain <em>live</em>`, "Every pool on Robinhood Chain, straight from the chain's DEXes: Uniswap v3/v4, Pons, Long, Bankr, Virtuals and more. Refreshes on its own.",
    `<div class="row"><span class="block-pill"><i class="live-dot"></i><span id="liveUpd">live</span></span><div class="tabs" id="kindTabs">${[["trending", "Trending"], ["top", "Top volume"], ["new", "New pairs"]].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? "on" : ""}">${l}</button>`).join("")}</div></div>`)
    + `<div class="card"><div id="liveTable"><div class="skeleton"></div></div></div>`;
  $("#kindTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) location.hash = `#/live?kind=${b.dataset.k}`; };
  const load = async () => { const r = await loadPools($("#liveTable"), kind, 30, { showAge: kind === "new" }); if (r) $("#liveUpd").textContent = `updated ${new Date(r.updatedAt).toLocaleTimeString()}`; };
  load(); every(kind === "new" ? 20000 : 30000, load);
}

function newPairs() {
  view.innerHTML = head(`New <em>pairs</em>`, "The newest pools on Robinhood Chain, seconds after they appear. Run the Checkpoint before you touch any of them.",
    `<span class="block-pill"><i class="live-dot"></i><span id="newUpd">live</span></span>`)
    + `<div class="card"><div id="newTable"><div class="skeleton"></div></div></div>`;
  const load = async () => { const r = await loadPools($("#newTable"), "new", 30, { showAge: true }); if (r) $("#newUpd").textContent = `updated ${new Date(r.updatedAt).toLocaleTimeString()}`; };
  load(); every(20000, load);
}

function stocksView() {
  view.innerHTML = head(`Tokenized <em>stocks</em>`, "Stocks and ETFs on Robinhood Chain with prices from their on-chain pools. Buy any of them with ETH or USDG.")
    + `<div class="card"><div class="row between" style="margin-bottom:12px"><input id="stockFilter" placeholder="Filter: NVDA, Tesla, ETF…" style="max-width:280px"><span class="muted" id="stockCount" style="font-size:13px"></span></div><div id="stockTable"><div class="skeleton"></div></div></div>`;
  // Names and logos are known up front; prices fill in when they arrive.
  let rows = (state.chains.find((c) => c.key === "robinhood")?.stocks || []).map((s) => ({ ...s, priceUsd: null, change24hPct: null, volume24hUsd: null }));
  const render = () => {
    const f = $("#stockFilter").value.trim().toLowerCase();
    const list = rows.filter((s) => !f || s.symbol.toLowerCase().includes(f) || s.name.toLowerCase().includes(f));
    $("#stockCount").textContent = `${list.length} of ${rows.length}`;
    $("#stockTable").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">24h</th><th class="num">Volume</th><th class="num"></th></tr></thead><tbody>${list.map((s) => `
      <tr class="clickable" data-token="${esc(s.address)}"><td><div class="token-cell">${avatar(s.symbol, s.address)}<div><b>${esc(s.symbol)}</b><small>${esc(s.name)}</small></div></div></td>
      <td class="num">${fmtPrice(s.priceUsd)}</td><td class="num">${signed(s.change24hPct)}</td><td class="num">${usd(s.volume24hUsd)}</td>
      <td class="num"><a class="btn sm" href="#/swap?in=ETH&out=${esc(s.symbol)}" onclick="event.stopPropagation()">Buy</a></td></tr>`).join("")}</tbody></table></div>`;
    bindTokenRows($("#stockTable"));
  };
  const load = async () => {
    try { const r = await api("/tools/stock_prices"); rows = r.stocks.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)); render(); }
    catch { setTimeout(() => { if (location.hash.startsWith("#/stocks")) load(); }, 15000); }
  };
  if (rows.length) render();
  $("#stockFilter").oninput = render;
  load(); every(60000, load);
}

async function tokenView(q) {
  const address = q.get("address") || "";
  view.innerHTML = `<div id="tokHead"><div class="skeleton" style="width:240px;height:34px"></div></div>
    <div class="grid" style="margin-top:22px">
      <div class="span-7 stack"><div class="card"><div class="panel-head"><span class="panel-title">Pools</span></div><div id="tokPools"><div class="skeleton"></div></div></div></div>
      <div class="span-5 stack"><div class="card"><div class="panel-head"><span class="panel-title">Checkpoint</span><span class="muted" style="font-size:12px">test buy & sell from ETH</span></div><div id="tokCheck"><span class="spinner"></span> Checking…</div></div></div>
    </div>`;
  try {
    const t = await api(`/tools/onchain_token?address=${encodeURIComponent(address)}`);
    const m = t.main;
    $("#tokHead").innerHTML = `<div class="page-head" style="margin:0"><div class="token-hero">${avatar(t.token?.symbol, address)}<div><h1>${esc(t.token?.symbol || short(address))}</h1><span class="muted">${esc(t.token?.name || "")} · <span class="mono">${esc(short(address))}</span></span></div></div>
      <div class="row">${m ? `<div style="text-align:right"><div class="price-big">${fmtPrice(m.priceUsd)}</div><div>${signed(m.change.h24)} <span class="muted">24h</span></div></div>` : ""}
      <a class="btn primary" href="#/swap?in=ETH&out=${esc(address)}">Swap</a><a class="btn ghost" href="${esc(t.explorer)}" target="_blank" rel="noopener">Explorer ↗</a></div></div>
      ${t.totals ? `<div class="stats" style="margin-top:20px">${[["Volume 24h", usd(t.totals.volume24hUsd), `across ${t.totals.pools} pool${t.totals.pools > 1 ? "s" : ""}`], ["Liquidity", usd(t.totals.liquidityUsd), "all pools"], ["FDV", usd(m.fdvUsd), m.marketCapUsd ? `mcap ${usd(m.marketCapUsd)}` : ""], ["Txns 24h", `<span class="up">${t.totals.buys24h.toLocaleString("en-US")}</span><span class="faint"> / </span><span class="down">${t.totals.sells24h.toLocaleString("en-US")}</span>`, "buys / sells"]].map(([k, v, s]) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>` : ""}`;
    $("#tokPools").innerHTML = t.pools.length ? poolRows(t.pools) : `<div class="empty">No pools found for this token.</div>`;
  } catch (e) { $("#tokHead").innerHTML = errorBox(e); $("#tokPools").innerHTML = ""; }
  try {
    const r = await api(`/tools/check_token?${new URLSearchParams({ chain: "robinhood", address })}`);
    $("#tokCheck").innerHTML = checkpointHtml(r) + (r.health?.flags?.length ? `<div style="margin-top:14px">${r.health.flags.map((f) => `<div style="padding:4px 0"><span class="tag ${f.severity === "info" ? "info" : f.severity}">${esc(f.severity)}</span> ${esc(f.text)}</div>`).join("")}</div>` : "");
  } catch (e) { $("#tokCheck").innerHTML = errorBox(e); }
}

function swap(q) {
  const chain = state.chains.find((c) => c.key === state.chain);
  const known = [...(chain?.tokens || []), ...(chain?.stocks || []).map((s) => s.symbol)];
  const defOut = state.chain === "robinhood" ? "USDG" : "USDC";
  view.innerHTML = head(`Swap`, `On ${esc(chainName())}. Routes from KyberSwap; the ticket is re-checked on the live pool right before you sign.`)
    + `<div class="grid">
      <form class="card span-5 swap-card" id="swapForm" autocomplete="off">
        <div class="leg"><label for="sAmt">You pay</label><div class="leg-row"><input class="amt" id="sAmt" inputmode="decimal" value="${esc(q.get("amount") || "0.01")}" pattern="[0-9]*[.]?[0-9]+" required aria-label="Amount"><input class="tok" id="sIn" list="known" value="${esc(q.get("in") || "ETH")}" required aria-label="Token you pay"></div></div>
        <button type="button" class="flip" id="flip" aria-label="Flip tokens">⇅</button>
        <div class="leg"><label for="sOut">You receive</label><div class="leg-row"><span class="out-amt" id="outAmt">—</span><input class="tok" id="sOut" list="known" value="${esc(q.get("out") || defOut)}" placeholder="symbol or 0x…" required aria-label="Token you receive"></div></div>
        <datalist id="known">${known.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
        ${chain?.stocks?.length ? `<div class="field" style="margin-top:14px"><label>Stocks</label><div class="chips">${chain.stocks.slice(0, 10).map((s) => `<button type="button" class="chip" data-stock="${esc(s.symbol)}" title="${esc(s.name)}">${esc(s.symbol)}</button>`).join("")}</div></div>` : ""}
        <div class="row between" style="margin:14px 0 6px"><span class="field"><label>Slippage</label></span><div class="seg" id="slip">${[0.5, 1, 3, 5].map((s) => `<button type="button" data-s="${s}" class="${s === 1 ? "on" : ""}">${s}%</button>`).join("")}</div></div>
        <button class="btn primary block" type="submit" style="padding:14px">${state.address ? "Run Checkpoint & make ticket" : "Run Checkpoint"}</button>
      </form>
      <div class="span-7 stack" id="swapOut"><div class="card empty" style="border-style:dashed">Pick a pair and run the Checkpoint. Nothing is sent until you sign.</div></div>
    </div>`;
  let slip = 1;
  $("#slip").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; slip = Number(b.dataset.s); $("#slip").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  $("#flip").onclick = () => { const a = $("#sIn").value; $("#sIn").value = $("#sOut").value; $("#sOut").value = a; $("#outAmt").textContent = "—"; };
  view.querySelectorAll("[data-stock]").forEach((b) => (b.onclick = () => { $("#sIn").value = "ETH"; $("#sOut").value = b.dataset.stock; $("#outAmt").textContent = "—"; }));
  $("#swapForm").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#swapOut");
    out.innerHTML = `<div class="card"><span class="spinner"></span>&nbsp; Running the Checkpoint on the live pool…</div>`;
    const args = { chain: "robinhood", tokenIn: $("#sIn").value.trim(), tokenOut: $("#sOut").value.trim(), amount: $("#sAmt").value.trim(), slippagePct: slip };
    try {
      if (!state.address) {
        const g = await api(`/tools/quote_swap?${new URLSearchParams(args)}`);
        if (g.swap) $("#outAmt").textContent = g.swap.amountOut;
        out.innerHTML = `<div class="card">${quoteHead(g.swap)}${checkpointHtml(g)}<p class="muted" style="margin:14px 0 0">Connect a wallet to turn this into a ticket you can sign.</p></div>`;
        return;
      }
      const t = await api("/swap/prepare", { method: "POST", body: args });
      if (t.gate?.swap) $("#outAmt").textContent = t.gate.swap.amountOut;
      out.innerHTML = "";
      out.append(ticketCard(t));
    } catch (err) { out.innerHTML = `<div class="card"><div class="verdict fail"><span class="stamp">ERROR</span><span>${esc(err.message)}</span></div></div>`; }
  };
}

function quoteHead(s) {
  if (!s) return "";
  return `<div class="ticket-legs" style="margin-bottom:14px">
    <div class="tl"><b>${esc(s.amountIn)}</b><span>${esc(s.tokenIn.symbol)} · ${usd(s.inUsd)}</span></div><div class="arrow">→</div>
    <div class="tl"><b>${esc(s.amountOut)}</b><span>${esc(s.tokenOut.symbol)} · ${usd(s.outUsd)}</span></div></div>`;
}

function check(q) {
  view.innerHTML = head(`Checkpoint`, `Paste a token contract on ${esc(chainName())}. Quill reads its bytecode and runs a test buy and a test sell: the same checks that run before every swap. A heuristic, not an audit.`)
    + `<form class="card row" id="checkForm" style="margin-bottom:18px">
      <input id="addr" placeholder="0x… token contract" style="flex:1;min-width:220px" value="${esc(q.get("address") || "")}" pattern="0x[0-9a-fA-F]{40}" required>
      <button class="btn primary" type="submit">Run checks</button>
    </form><div id="checkOut"></div>`;
  const run = async () => {
    const out = $("#checkOut"), a = $("#addr").value.trim();
    out.innerHTML = `<div class="card"><span class="spinner"></span>&nbsp; Checking…</div>`;
    try {
      const r = await api(`/tools/check_token?${new URLSearchParams({ chain: "robinhood", address: a })}`);
      out.innerHTML = `<div class="card">
        <div class="panel-head"><div class="token-cell">${avatar(r.swap?.tokenOut?.symbol, a)}<div><b style="font-size:18px">${esc(r.swap?.tokenOut?.symbol || "Token")}</b><small class="mono">${esc(short(a))}</small></div></div>
        ${r.health ? `<span class="mono muted">score <b style="color:var(--text)">${r.health.score}</b>/100</span>` : ""}</div>
        ${checkpointHtml(r)}
        ${r.health?.flags?.length ? `<div style="margin-top:16px">${r.health.flags.map((f) => `<div style="padding:4px 0"><span class="tag ${f.severity === "info" ? "info" : f.severity}">${esc(f.severity)}</span> ${esc(f.text)}</div>`).join("")}</div>` : ""}
        <div class="row" style="margin-top:16px"><a class="btn primary" href="#/swap?in=ETH&out=${esc(a)}">Swap into it</a>${state.chain === "robinhood" ? `<a class="btn ghost" href="#/token?address=${esc(a)}">Market data →</a>` : ""}</div>
      </div>`;
    } catch (e) { out.innerHTML = errorBox(e); }
  };
  $("#checkForm").onsubmit = (e) => { e.preventDefault(); run(); };
  if (q.get("address")) run();
}

async function portfolio() {
  if (!state.address) { view.innerHTML = head(`Portfolio`, "") + `<div class="card empty">Connect a wallet to see what it holds on Robinhood Chain.</div>`; return; }
  view.innerHTML = head(`Portfolio`, `Read live from Robinhood Chain for <span class="mono">${esc(short(state.address))}</span>.`) + `<div id="pf"><div class="card"><span class="spinner"></span></div></div>`;
  try {
    const p = await api(`/tools/get_portfolio`);
    $("#pf").innerHTML = `<div class="stats" style="grid-template-columns:repeat(3,1fr)">
        <div class="card stat"><div class="k">Total value</div><div class="v">${usd(p.totalUsd)}</div><div class="s">known tokens</div></div>
        <div class="card stat"><div class="k">Positions</div><div class="v">${p.holdings.length}</div><div class="s">ETH, USDG and stocks</div></div>
        <div class="card stat"><div class="k">Network</div><div class="v" style="font-size:20px">Robinhood Chain</div><div class="s">chain 4663</div></div></div>
      <div class="card">${p.holdings.length ? `<div class="table-wrap"><table><thead><tr><th>Asset</th><th class="num">Amount</th><th class="num">Price</th><th class="num">Value</th><th class="num"></th></tr></thead><tbody>${p.holdings.map((h) => `
        <tr><td><div class="token-cell">${avatar(h.symbol, h.address)}<div><b>${esc(h.symbol)}</b><small>${esc(h.name || (h.stock ? "Tokenized stock" : ""))}</small></div></div></td>
        <td class="num">${h.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td><td class="num">${fmtPrice(h.priceUsd)}</td><td class="num">${usd(h.valueUsd)}</td>
        <td class="num"><a class="btn sm" href="#/swap?in=${esc(h.symbol)}&out=${h.symbol === "USDG" ? "ETH" : "USDG"}">Trade</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Nothing found among ETH, WETH, USDG and tokenized stocks.</div>`}
        <p class="muted" style="font-size:12.5px;margin:14px 0 0">${esc(p.note)}</p></div>`;
  } catch (e) { $("#pf").innerHTML = errorBox(e); }
}

async function limits() {
  if (!state.address) { view.innerHTML = head(`Limits`, "") + `<div class="card empty">Connect a wallet to see and tighten your limits.</div>`; return; }
  const p = await api("/policy");
  view.innerHTML = head(`Limits`, "The operator sets the ceiling. You can only make yours stricter. Enforced by the server on every action, outside the model.") + `
    <div class="grid">
      <form class="card span-7 stack" id="limForm">
        ${[["perTradeUsd", "Per trade (USD)"], ["dailyUsd", "Per day (USD)"], ["maxSlippagePct", "Max slippage (%)"], ["maxPriceImpactPct", "Max price impact (%)"]].map(([k, l]) => `
          <div class="field"><label for="${k}">${l} · ceiling ${p[k]}</label><input id="${k}" inputmode="decimal" value="${p.userLimits[k] ?? ""}" placeholder="${p[k]} (operator)"></div>`).join("")}
        <div class="row"><button class="btn primary">Save limits</button><button type="button" class="btn ${p.paused ? "primary" : ""}" id="pause">${p.paused ? "Resume" : "Pause everything"}</button></div>
      </form>
      <div class="card span-5"><div class="panel-head"><span class="panel-title">Now</span></div><dl class="kv">
        <dt>Used today</dt><dd>${usd(p.usedTodayUsd)}</dd><dt>Kill switch</dt><dd>${p.killSwitch ? "ON" : "off"}</dd><dt>Paused</dt><dd>${p.paused ? "yes" : "no"}</dd>
        <dt>Chains</dt><dd>${esc(p.allowedChains.join(", "))}</dd><dt>Blocked tokens</dt><dd>${p.blockedTokens.length || "none"}</dd></dl></div>
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
  if (!state.address) { view.innerHTML = head(`Journal`, "") + `<div class="card empty">Connect a wallet to see your journal.</div>`; return; }
  const rows = await api("/journal?limit=100");
  view.innerHTML = head(`Journal`, "Every prepare, block, build and sent transaction, with its reason.") + `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Stage</th><th>Outcome</th><th>Trade</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td class="mono" style="white-space:nowrap">${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.stage)}</td><td><span class="tag ${r.outcome === "blocked" ? "fail" : r.outcome === "sent" ? "pass" : "info"}">${esc(r.outcome)}</span></td>
    <td>${r.params ? esc(`${r.params.amount} ${short(r.params.tokenIn)} → ${short(r.params.tokenOut)} (${r.params.chain})`) : ""}</td>
    <td class="muted">${r.hash ? `<code>${esc(short(r.hash))}</code>` : esc(r.reason || r.gateStatus || "")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Nothing yet.</div>`}</div>`;
}

function apiDocs() {
  const origin = location.origin;
  view.innerHTML = head(`API &amp; <em>MCP</em>`, "Every tool the agent uses is also a REST endpoint and an MCP tool. Read tools are public. Prepare needs an API token; execute needs the execute scope and an Idempotency-Key. New tokens start in dry-run.") + `
    <div class="grid"><div class="card span-12">
      <div class="panel-head"><span class="panel-title">Create a token (on the server)</span></div>
      <pre class="code">npm run token -- my-laptop --owner 0xYourWallet</pre>
      <div class="panel-head"><span class="panel-title">REST</span></div>
      <pre class="code">GET  ${esc(origin)}/api/tools
GET  ${esc(origin)}/api/tools/onchain_pools?kind=trending
GET  ${esc(origin)}/api/tools/quote_swap?tokenIn=ETH&amp;tokenOut=TSLA&amp;amount=0.01
POST ${esc(origin)}/api/tools/prepare_swap   x-api-key   {"tokenOut":"USDG","amount":"0.01"}
POST ${esc(origin)}/api/tools/execute_intent x-api-key + Idempotency-Key  {"confirmationId":"cf_…"}</pre>
      <div class="panel-head"><span class="panel-title">MCP (Claude Code)</span></div>
      <pre class="code">claude mcp add quill --env QUILL_URL=${esc(origin)} --env QUILL_API_KEY=quill_… -- node /path/to/quill/mcp/index.mjs</pre>
      <div class="panel-head"><span class="panel-title">Tools</span></div><div id="toolList"><div class="skeleton"></div></div>
    </div></div>`;
  api("/tools").then((ts) => ($("#toolList").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Tool</th><th>Tier</th><th>What it does</th></tr></thead><tbody>${ts.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><span class="tag ${t.tier === "read" ? "pass" : t.tier === "prepare" ? "warn" : "fail"}">${esc(t.tier)}</span></td><td class="muted">${esc(t.description)}</td></tr>`).join("")}</tbody></table></div>`));
}

// ---------------- tickets ----------------

function ticketCard(t) {
  const el = document.createElement("div");
  el.className = "ticket";
  const render = (status = "") => {
    const s = t.gate?.swap;
    const expired = t.expiresAt && Date.parse(t.expiresAt) < Date.now();
    el.innerHTML = `
      <div class="ticket-head"><span>Ticket <span class="id">${t.ok ? "#" + esc(t.ref || "") : "blocked"}</span></span><span>${s ? esc(s.chainName) : ""}</span></div>
      <div class="ticket-body">
        ${s ? quoteHead(s) : ""}
        ${checkpointHtml(t.gate)}
        ${t.ok ? `<div class="ticket-foot">
          <span class="meta">${expired ? "Expired" : `Valid until ${new Date(t.expiresAt).toLocaleTimeString()}`} · slippage ${s.slippagePct}%</span>
          ${status ? `<span>${status}</span>` : `<button class="btn primary" data-sign ${expired ? "disabled" : ""}>Re-check &amp; sign</button>`}
        </div>` : ""}
      </div>`;
    el.querySelector("[data-sign]")?.addEventListener("click", () => signTicket(t, render));
  };
  render();
  return el;
}

async function signTicket(t, render) {
  try {
    if (!state.address) { await connectWallet(); renderWallet(); }
    render('<span class="spinner"></span>&nbsp; Re-checking on the live pool…');
    const b = await api(`/tickets/${t.id}/build`, { method: "POST", body: {} });
    if (!b.ok) { t.gate = b.gate; t.ok = false; render(); toast(b.reason); return; }
    t.gate = b.gate;
    await ensureChain(b.chainId);
    let last;
    for (const [i, tx] of b.txs.entries()) {
      render(`<span class="spinner"></span>&nbsp; ${esc(tx.label)}: confirm in your wallet (${i + 1}/${b.txs.length})`);
      const hash = await sendTx(tx);
      render(`<span class="spinner"></span>&nbsp; ${esc(tx.label)}: waiting for the chain…`);
      await waitReceipt(hash);
      last = hash;
    }
    await api(`/tickets/${t.id}/sent`, { method: "POST", body: { hash: last } });
    render(`<span class="up">✓ Done</span> · <a href="${esc(b.explorer)}/tx/${esc(last)}" target="_blank" rel="noopener" style="text-decoration:underline">view transaction ↗</a>`);
    toast("Swap confirmed");
  } catch (e) {
    render(`<span class="down">${esc(e.message || String(e))}</span>`);
  }
}

// ---------------- agent drawer ----------------

let sessionId = null;

function openDrawer(prefill) {
  if (!state.address) { document.querySelectorAll(".nav a").forEach((x) => x.classList.remove("on")); gate("ask"); window.scrollTo(0, 0); return; }
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#scrim").hidden = false;
  const log = $("#chatLog");
  if (!log.children.length) addMsg("bot", state.health?.llm
    ? "Ask me for prices, trending coins, a token check or a swap. I prepare tickets; you sign them."
    : "AI chat is off on this server, so I take commands:\n• buy TSLA with 0.01 ETH\n• swap 0.01 ETH to USDG\n• check 0x…\n• trending · new pairs · stocks · limits");
  if (prefill != null) { $("#chatInput").value = prefill; if (prefill) sendChat(); }
  $("#chatInput").focus();
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").hidden = !document.body.classList.contains("nav-open"); }

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
