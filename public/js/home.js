// Homepage: live Robinhood Chain data (ticker, block, trending, new pairs, stocks), the ticket demo and scroll reveals.
import { ago, api, avatar, esc, fmtPrice, initTheme, signed, usd } from "./lib.js";

const $ = (s) => document.querySelector(s);
initTheme($("#themeBtn"));

// nav background on scroll
const nav = $("#navTop");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 10);
addEventListener("scroll", onScroll, { passive: true }); onScroll();

// reveal on scroll
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// ticket demo: checks land one by one, then the stamp
function playDemo() {
  const items = [...document.querySelectorAll("#demoChecks li")];
  const stamp = document.querySelector(".td-foot .stamp");
  items.forEach((li) => li.classList.remove("in")); stamp.classList.remove("in");
  items.forEach((li, i) => setTimeout(() => li.classList.add("in"), 500 + i * 380));
  setTimeout(() => stamp.classList.add("in"), 500 + items.length * 380 + 200);
}
playDemo(); setInterval(() => !document.hidden && playDemo(), 9000);

// typed prompt rotation
const prompts = ["buy TSLA with 0.01 ETH", "is 0x020b…18b4 safe?", "swap 20 USDG to ETH", "what's trending right now?"];
let pi = 0;
setInterval(() => {
  if (document.hidden) return;
  pi = (pi + 1) % prompts.length;
  const el = $("#typed"); const text = prompts[pi]; let i = 0;
  el.textContent = "";
  const t = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(t); }, 38);
}, 4500);

// live data
async function block() {
  try {
    const s = await api("/tools/chain_status");
    $("#navBlock").textContent = `Block #${s.block.toLocaleString("en-US")}`;
    $("#sBlock").textContent = `#${s.block.toLocaleString("en-US")}`;
    $("#sBlockAge").textContent = `${s.ageSec}s ago · ${s.txCount ?? "–"} txs`;
    $("#sFee").textContent = s.baseFeeGwei != null ? s.baseFeeGwei.toFixed(4) : "–";
  } catch { $("#navBlock").textContent = "Robinhood Chain"; }
}

const tickerItem = (p) => `<a class="tk" href="/app/#/token?address=${esc(p.token.address || "")}">${avatar(p.token.symbol, p.token.address)}<b>${esc(p.token.symbol)}</b><span class="p">${fmtPrice(p.priceUsd)}</span>${signed(p.change.h24)}</a>`;
const miniRow = (p, right) => `<a class="mini-row" href="/app/#/token?address=${esc(p.token.address || "")}"><span class="token-cell">${avatar(p.token.symbol, p.token.address)}<span><b>${esc(p.token.symbol)}</b><small>${esc(p.dex)}</small></span></span>${right}</a>`;

async function market() {
  try {
    const [tr, top] = await Promise.all([api("/tools/onchain_pools?kind=trending&limit=12"), api("/tools/onchain_pools?kind=top&limit=3")]);
    const items = tr.pools.map(tickerItem).join("");
    $("#ticker").innerHTML = items + items; // duplicated for a seamless loop
    $("#homeTrending").innerHTML = tr.pools.slice(0, 7).map((p) => miniRow(p, `<span class="num mono">${fmtPrice(p.priceUsd)}<br><small class="muted">${usd(p.volume24hUsd)} vol</small></span><span class="num">${signed(p.change.h24)}</span>`)).join("");
    $("#liveUpd").textContent = `updated ${new Date(tr.updatedAt).toLocaleTimeString()}`;
    const best = top.pools.find((p) => !["USDG", "WETH", "ETH"].includes(p.token.symbol)) || top.pools[0];
    if (best) { $("#sTopVol").textContent = usd(best.volume24hUsd); $("#sTopName").textContent = `${best.token.symbol} · ${best.dex}`; }
    const names = tr.pools.slice(0, 3).map((p) => `${p.token.symbol} (${p.change.h24 != null ? (p.change.h24 > 0 ? "+" : "") + p.change.h24.toFixed(1) + "%" : "–"})`);
    $("#chatTrending").innerHTML = `Top trending on Robinhood Chain right now: ${esc(names.join(", "))}. Want me to run the Checkpoint on one?`;
  } catch (e) {
    if (!$("#ticker .avatar")) $("#ticker").innerHTML = `<span class="tk muted">Reconnecting to the live market…</span>`;
    if (!$("#homeTrending .mini-row")) $("#homeTrending").innerHTML = `<div class="empty">Reconnecting to live data… <span class="spinner"></span></div>`;
    setTimeout(market, 12000);
    return;
  }
  try {
    const nw = await api("/tools/onchain_pools?kind=new&limit=6");
    $("#homeNew").innerHTML = nw.pools.map((p) => miniRow(p, `<span class="num mono muted">${usd(p.liquidityUsd)}</span><span class="num mono">${ago(p.createdAt)}</span>`)).join("");
    const n = nw.pools[0];
    if (n) { $("#sNew").textContent = n.token.symbol; $("#sNewAge").textContent = `${ago(n.createdAt)} ago · ${n.dex}`; }
  } catch (e) { $("#homeNew").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function stocks() {
  try {
    const r = await api("/tools/stock_prices");
    $("#stockCount").textContent = r.stocks.length;
    const pick = r.stocks.filter((s) => s.priceUsd != null).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).slice(0, 12);
    $("#homeStocks").innerHTML = pick.map((s) => `<a class="stock" href="/app/#/swap?in=ETH&out=${esc(s.symbol)}"><div class="token-cell">${avatar(s.symbol, s.address)}<div><b>${esc(s.symbol)}</b><small>${esc(s.name)}</small></div></div><div class="p">${fmtPrice(s.priceUsd)}</div>${signed(s.change24hPct)}</a>`).join("");
    if (!pick.length) throw new Error("no prices yet");
  } catch {
    if (!$("#homeStocks .stock")) $("#homeStocks").innerHTML = `<div class="empty" style="grid-column:1/-1">Reconnecting to live prices… <span class="spinner"></span></div>`;
    setTimeout(stocks, 15000);
  }
}

block(); market(); stocks();
setInterval(() => !document.hidden && block(), 6000);
setInterval(() => !document.hidden && market(), 45000);
