// Homepage: the 3D quill, menu, scroll chapters and live Robinhood Chain data in the chapter panes.
import { api, avatar, checkpointHtml, esc, fmtPrice, signed, usd } from "./lib.js";

const $ = (s) => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// 3D quill, loaded after first paint so text shows at once
requestAnimationFrame(() => import("./hero3d.js").then((m) => m.mountQuill($("#quill3d"), { reduced })).catch(() => {}));

// header + theme + menu
const hd = $("#hd");
const onScroll = () => hd.classList.toggle("scrolled", scrollY > 30);
addEventListener("scroll", onScroll, { passive: true }); onScroll();
$("#themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("quill.theme", next); } catch {}
};
const menu = $("#menu"), menuBtn = $("#menuBtn");
const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute("aria-expanded", String(open)); document.body.style.overflow = open ? "hidden" : ""; };
menuBtn.onclick = () => setMenu(menu.hidden);
menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

// works-with marquee (names only)
const works = ["Robinhood Chain", "Uniswap", "Pons", "KyberSwap", "Long", "Bankr", "Virtuals", "GeckoTerminal", "DexScreener", "MetaMask", "Rabby", "Coinbase Wallet", "Claude", "Claude Code", "Cursor", "Blockscout"];
$("#worksTrack").innerHTML = [...works, ...works].map((w) => `<span>${esc(w)}</span>`).join("");

// reveal
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.2 });
document.querySelectorAll(".rv").forEach((el) => io.observe(el));

// chapters: the pane follows whichever chapter is in view; tabs jump
const panes = [...document.querySelectorAll(".pane")], tabs = [...document.querySelectorAll(".ch-tabs button")], chs = [...document.querySelectorAll(".ch")];
let current = 0;
function show(i) {
  current = i;
  panes.forEach((p, k) => p.classList.toggle("on", k === i));
  tabs.forEach((t, k) => t.classList.toggle("on", k === i));
  chs.forEach((c, k) => c.classList.toggle("active", k === i));
}
const chIo = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) show(Number(e.target.dataset.ch)); }), { rootMargin: "-45% 0px -45% 0px" });
chs.forEach((c) => chIo.observe(c));
tabs.forEach((t) => (t.onclick = () => {
  const i = Number(t.dataset.go);
  show(i);
  if (matchMedia("(min-width: 1001px)").matches) chs[i].scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
}));
show(0);

// ---- live data ----
async function block() {
  const el = $("#navLive");
  try {
    const s = await api("/tools/chain_status");
    el.title = `Live on Robinhood Chain. Latest block #${s.block.toLocaleString("en-US")}, ${s.ageSec}s ago. Click to open it in the explorer.`;
    el.href = `https://robinhoodchain.blockscout.com/block/${s.block}`;
    el.classList.remove("offline");
  } catch { el.title = "Robinhood Chain is not answering right now"; el.classList.add("offline"); }
}

let trending = [];
async function live() {
  try {
    const r = await api("/tools/onchain_pools?kind=trending&limit=8");
    trending = r.pools;
    $("#paneLive").innerHTML = r.pools.map((p) => `<a class="mini" href="/app/#/token?address=${esc(p.token.address || "")}"><span class="token-cell">${avatar(p.token.symbol, p.token.address, p.token.image)}<span><b>${esc(p.token.symbol)}</b><small>${esc(p.dex)}</small></span></span><span class="num">${fmtPrice(p.priceUsd)}<br><small class="muted">${usd(p.volume24hUsd)}</small></span><span class="num">${signed(p.change.h24)}</span></a>`).join("");
    $("#paneLiveUpd").textContent = new Date(r.updatedAt).toLocaleTimeString();
    const names = r.pools.slice(0, 3).map((p) => `${p.token.symbol} (${p.change.h24 != null ? (p.change.h24 > 0 ? "+" : "") + p.change.h24.toFixed(1) + "%" : "–"})`);
    $("#paneChatTrending").textContent = `Top trending right now: ${names.join(", ")}. Want me to run the Checkpoint on one?`;
    return true;
  } catch { setTimeout(live, 12000); return false; }
}

async function liveCheck() {
  const pick = trending.find((p) => p.token.address && !p.token.stock && !["USDG", "WETH"].includes(p.token.symbol));
  if (!pick) return;
  $("#paneCheckSym").textContent = pick.token.symbol;
  try {
    const r = await api(`/tools/check_token?${new URLSearchParams({ chain: "robinhood", address: pick.token.address })}`);
    r.checks = r.checks.filter((c) => !["per_trade", "daily", "slippage"].includes(c.id));
    $("#paneCheckBody").innerHTML = checkpointHtml(r);
  } catch { $("#paneCheckBody").innerHTML = `<div class="empty">The Checkpoint is busy. Open the app to run it.</div>`; }
}

async function stocks() {
  try {
    const r = await api("/tools/stock_prices");
    $("#nStocks").textContent = r.stocks.length;
    const pick = r.stocks.filter((s) => s.priceUsd != null).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).slice(0, 12);
    if (!pick.length) throw new Error();
    $("#paneStocks").innerHTML = pick.map((s) => `<a href="/app/#/swap?in=ETH&out=${esc(s.symbol)}">${avatar(s.symbol, s.address)}<b>${esc(s.symbol)}</b><span class="p">${fmtPrice(s.priceUsd)}</span> ${signed(s.change24hPct)}</a>`).join("");
  } catch { setTimeout(stocks, 15000); }
}

api("/tools").then((t) => ($("#nTools").textContent = t.length)).catch(() => {});
block(); setInterval(() => !document.hidden && block(), 6000);
live().then((ok) => ok && liveCheck());
stocks();
setInterval(() => !document.hidden && live(), 45000);
