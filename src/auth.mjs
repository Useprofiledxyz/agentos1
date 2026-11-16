// Sign-in with a Solana wallet: the wallet signs a one-time message (signMessage, ed25519). The session is an HttpOnly cookie.
// Nonces and sessions are sealed tokens (see seal.mjs), so no server memory is needed between requests.
// Without a session the API treats the visitor as anonymous: read tools work, tickets and limits do not.
import { ed25519 } from "@noble/curves/ed25519.js";
import { decode58, isSolAddress } from "./sol/base58.mjs";
import { randomBytes } from "node:crypto";
import { seal, unseal } from "./seal.mjs";

const NONCE_MS = 5 * 60_000, SESSION_MS = 7 * 24 * 3600_000;
const COOKIE = "quill_session";
const SECURE = process.env.COOKIE_SECURE === "1";
const usedNonces = new Map(); // best-effort replay guard within one instance; the signature already binds the address

export function loginMessage(address, nonce, host) {
  return `${host || "Quill"} wants you to sign in with your Solana account:\n${address}\n\nSigning this proves you own the wallet. It costs nothing and cannot move funds.\n\nNonce: ${nonce}`;
}

/** newNonce(address, host) → { nonce (sealed), message } */
export function newNonce(address, host) {
  if (!isSolAddress(address)) throw Object.assign(new Error("Invalid Solana address"), { status: 400 });
  const n = randomBytes(12).toString("hex");
  const message = loginMessage(address, n, host);
  return { nonce: seal("nonce", { a: address, n, m: message }, NONCE_MS), message };
}

/** verifySignature(message, signature (base58 or base64), address) — ed25519 over the UTF-8 message bytes. */
export function verifySignature(message, signature, address) {
  const sig = /^[1-9A-HJ-NP-Za-km-z]+$/.test(signature) ? decode58(signature) : Uint8Array.from(Buffer.from(String(signature), "base64"));
  if (sig.length !== 64) return false;
  return ed25519.verify(sig, new TextEncoder().encode(message), decode58(address));
}

/** verifyLogin({ nonce, signature }) → { token, address } */
export function verifyLogin({ nonce, signature }) {
  let n;
  try { n = unseal("nonce", nonce); } catch { throw Object.assign(new Error("Sign-in expired, try again"), { status: 400 }); }
  const now = Date.now();
  for (const [k, exp] of usedNonces) if (exp < now) usedNonces.delete(k);
  if (usedNonces.has(n.n)) throw Object.assign(new Error("This sign-in was already used"), { status: 400 });
  let ok = false;
  try { ok = verifySignature(n.m, String(signature || ""), n.a); } catch {}
  if (!ok) throw Object.assign(new Error("Signature does not match the wallet"), { status: 401 });
  usedNonces.set(n.n, n.exp);
  return { token: seal("session", { a: n.a }, SESSION_MS), address: n.a };
}

export function sessionCookie(token, { secure = false } = {}) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${SECURE || secure ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_.-]+)`);

export function sessionAddress(req) {
  const m = String(req.headers.cookie || "").match(COOKIE_RE);
  if (!m) return null;
  try { return unseal("session", m[1]).a; } catch { return null; }
}

// Sessions are stateless: signing out clears the cookie in this browser.
export function logout() {}
