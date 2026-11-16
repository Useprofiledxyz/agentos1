// Shared helpers: API calls, wallet (EIP-1193), formatting and Checkpoint rendering.

export const state = { address: null, chain: "robinhood", chains: [], health: null };

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
export const short = (a) => (a && /^0x[0-9a-fA-F]{20,}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");

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

const ETH_LIKE = new Set(["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0x0bd7d308f8e1639fab988df18a8011f41eacad73"]);

/** Token or stock logo from /api/logo (cached by the CDN; a generated avatar when no logo exists). Letters show while it loads. */
export function avatar(sym, address) {
  const letters = esc(String(sym || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?");
  const ok = /^0x[0-9a-fA-F]{40}$/.test(String(address || ""));
  const a = ok ? address.toLowerCase() : "";
  // ETH and WETH ship with the site, so they never wait on a lookup
  const src = ETH_LIKE.has(a) || (!ok && /^w?eth$/i.test(String(sym || ""))) ? "/img/eth.svg" : ok ? `/api/logo/${esc(a)}?s=${encodeURIComponent(String(sym || "").slice(0, 12))}` : "";
  return `<span class="avatar">${letters}${src ? `<img src="${src}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ""}</span>`;
}

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

// ---------- wallet ----------

const eth = () => window.ethereum;

export async function connectWallet() {
  if (!eth()) throw new Error("No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet.");
  const [addr] = await eth().request({ method: "eth_requestAccounts" });
  const { message, nonce } = await api("/auth/nonce", { method: "POST", body: { address: addr } });
  const hex = "0x" + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("");
  const signature = await eth().request({ method: "personal_sign", params: [hex, addr] });
  const r = await api("/auth/verify", { method: "POST", body: { nonce, signature } });
  state.address = r.address;
  return r.address;
}

export async function disconnectWallet() {
  await api("/auth/logout", { method: "POST", body: {} });
  state.address = null;
}

export async function ensureChain(chainId) {
  const cur = parseInt(await eth().request({ method: "eth_chainId" }), 16);
  if (cur === chainId) return;
  try {
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + chainId.toString(16) }] });
  } catch (e) {
    if (chainId === 4663 && (e.code === 4902 || /unrecognized|not added/i.test(e.message || ""))) {
      await eth().request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }] });
      return;
    }
    throw new Error(`Switch your wallet to chain ${chainId} and try again (${e.message || e})`);
  }
}

export async function sendTx(tx) {
  return eth().request({ method: "eth_sendTransaction", params: [{ from: state.address, to: tx.to, data: tx.data, value: tx.value }] });
}

export async function waitReceipt(hash, { timeoutMs = 180_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r) { if (r.status === "0x1") return r; throw new Error("Transaction reverted on chain"); }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("Timed out waiting for the transaction");
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
