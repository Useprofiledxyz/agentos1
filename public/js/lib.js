// Shared helpers: API calls, wallet (EIP-1193), rendering primitives.

export const state = { address: null, chain: localStorageGet("aos.chain") || "base", chains: [], health: null };

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
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const usd = (n) => (n == null || !isFinite(n) ? "–" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Number(n).toFixed(2)}`);
export const price = (n) => (n == null ? "–" : n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toPrecision(4));
export const signed = (n) => (n == null ? "–" : `<span class="${n >= 0 ? "up" : "down"}">${n > 0 ? "+" : ""}${n.toFixed(2)}%</span>`);

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms);
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
