// Shared helpers: API calls, wallet (EIP-1193), formatting and Checkpoint rendering.

export const state = { address: null, chain: "solana", tokens: null, health: null };

export function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

/** Escape text for innerHTML. Token names and symbols come from the internet: always escape them. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const isMint = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ""));
export const short = (a) => (a && (isMint(a) || /^[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(a)) ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");

/** Compact USD: $1.24M, $18.4K, $932.10 */
export const usd = (n) => {
  if (n == null || !isFinite(n)) return "–";
  const a = Math.abs(n);
  return a >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
};

/** Token price with subscript zeros for tiny values: $0.0₄308 */
export function fmtPrice(n, { dollar = true } = {}) {
  if (n == null || !isFinite(n)) return "–";
  const d = dollar ? "$" : "";
  if (n >= 1000) return d + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return d + n.toFixed(n >= 100 ? 2 : 3);
  if (n >= 0.01) return d + n.toFixed(4);
  if (n === 0) return d + "0";
  const s = n.toFixed(20).slice(2);
  const zeros = s.match(/^0*/)[0].length;
  const sub = String(zeros).split("").map((c) => "₀₁₂₃₄₅₆₇₈₉"[c]).join("");
  return `${d}0.0${sub}${s.slice(zeros, zeros + 4).replace(/0+$/, "")}`;
}
export const price = (n) => fmtPrice(n, { dollar: false });
export const signed = (n, digits = 2) => (n == null || !isFinite(n) ? '<span class="faint">–</span>' : `<span class="${n >= 0 ? "up" : "down"}">${n > 0 ? "+" : ""}${n.toFixed(digits)}%</span>`);

export function ago(iso) {
  if (!iso) return "–";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Token or stock logo from /api/logo (cached by the CDN; a generated avatar when no logo exists). Letters show while it loads. */
export function avatar(sym, address, image, opts = {}) {
  const letters = esc(String(sym || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?");
  const ok = isMint(address);
  const a = ok ? String(address) : "";
  // SOL ships with the site, so it never waits on a lookup
  const src = a === SOL_MINT || (!ok && /^w?sol$/i.test(String(sym || ""))) ? "/img/sol.svg" : ok ? `/api/logo/${esc(a)}?s=${encodeURIComponent(String(sym || "").slice(0, 12))}${image && /^https:\/\//.test(image) ? `&u=${encodeURIComponent(image)}` : ""}` : "";
  // Company logos are not round artwork: fit them whole on a matching backdrop instead of cropping them.
  const stock = opts.stock ?? stockSet().has(a);
  return `<span class="avatar${stock ? " is-stock" : ""}">${letters}${src ? `<img src="${src}" alt="" loading="lazy" decoding="async"${stock ? ' onload="qFitLogo(this)"' : ""} onerror="this.remove()">` : ""}</span>`;
}

let stocks;
function stockSet() {
  if (!stocks && state.tokens) stocks = new Set(state.tokens.stocks.map((s) => s.address));
  return stocks || new Set();
}

/** Pick a backdrop for a logo: its own background if it has one, else light or dark depending on the ink. */
window.qFitLogo = (img) => {
  try {
    const c = document.createElement("canvas"); c.width = c.height = 24;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let clear = 0, lum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 24) { clear++; continue; }
      lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++;
    }
    let bg;
    if (clear / (d.length / 4) > 0.06) bg = n && lum / n > 0.72 ? "#161b1a" : "#ffffff";
    else { const k = (24 * 0 + 0) * 4; bg = `rgb(${d[k]},${d[k + 1]},${d[k + 2]})`; } // opaque: extend its own corner colour
    img.style.background = bg;
    img.classList.add("fit");
  } catch { img.classList.add("fit"); img.style.background = "#ffffff"; }
};

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function initTheme(btn) {
  if (!btn) return;
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorageSet("quill.theme", next);
  };
}

// ---------- wallet (Phantom, Solflare, Backpack…) ----------

export function walletProvider() {
  return window.phantom?.solana || window.solflare || window.backpack || window.solana || null;
}
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function connectWallet() {
  const w = walletProvider();
  if (!w) throw new Error("No Solana wallet found. Install Phantom, Solflare or Backpack.");
  const r = await w.connect();
  const addr = String(r?.publicKey || w.publicKey);
  const { message, nonce } = await api("/auth/nonce", { method: "POST", body: { address: addr } });
  const signed = await w.signMessage(new TextEncoder().encode(message), "utf8");
  const sig = signed?.signature || signed;
  const r2 = await api("/auth/verify", { method: "POST", body: { nonce, signature: b64(new Uint8Array(sig)) } });
  state.address = r2.address;
  return r2.address;
}

export async function disconnectWallet() {
  await api("/auth/logout", { method: "POST", body: {} });
  try { await walletProvider()?.disconnect?.(); } catch {}
  state.address = null;
}

/** sendTx({ tx: base64 VersionedTransaction }) → signature. The wallet signs and broadcasts. */
export async function sendTx(t) {
  const w = walletProvider();
  if (!w) throw new Error("No Solana wallet found");
  if (!window.solanaWeb3) throw new Error("Solana library not loaded");
  const tx = window.solanaWeb3.VersionedTransaction.deserialize(unb64(t.tx));
  const r = await w.signAndSendTransaction(tx);
  return String(r?.signature || r);
}

export async function waitReceipt(signature, { timeoutMs = 90_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await api(`/tools/tx_status?signature=${encodeURIComponent(signature)}`).catch(() => null);
    if (s?.err) throw new Error("Transaction failed on chain");
    if (s && (s.status === "confirmed" || s.status === "finalized")) return s;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("Timed out waiting for confirmation. Check the transaction on Solscan.");
}

// ---------- checkpoint rendering ----------

const VERDICT = { pass: ["CLEAR", "Every check passed."], warn: ["CAUTION", "Passed with warnings. Read them before you sign."], fail: ["BLOCKED", "A check failed, so nothing can be built."] };

export function checkpointHtml(gate) {
  if (!gate) return "";
  const [stamp, text] = VERDICT[gate.status] || VERDICT.warn;
  return `
    <div class="verdict ${gate.status}"><span class="stamp">${stamp}</span><span>${text}</span></div>
    <ul class="checks">${gate.checks.map((c) => `
      <li><span class="tag ${esc(c.status)}">${esc(c.status)}</span><span class="lbl">${esc(c.label)}</span><span class="det">${esc(c.detail)}</span></li>`).join("")}
    </ul>`;
}

// Click-to-copy for anything with data-copy.
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-copy]");
  if (!el) return;
  try { await navigator.clipboard.writeText(el.dataset.copy); } catch {
    const t = document.createElement("textarea"); t.value = el.dataset.copy; document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }
  el.classList.add("copied"); setTimeout(() => el.classList.remove("copied"), 1400);
  if (document.getElementById("toast")) toast("Contract address copied");
});
