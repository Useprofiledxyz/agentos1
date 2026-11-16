// Sign-in with a wallet signature (personal_sign of a one-time nonce message). The session is an HttpOnly cookie.
// Nonces and sessions are sealed tokens (see seal.mjs), so no server memory is needed between requests.
// Without a session the API treats the visitor as anonymous: read tools work, tickets and limits do not.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "node:crypto";
import { seal, unseal } from "./seal.mjs";

const NONCE_MS = 5 * 60_000, SESSION_MS = 7 * 24 * 3600_000;
const COOKIE = "quill_session";
const SECURE = process.env.COOKIE_SECURE === "1";
const usedNonces = new Map(); // best-effort replay guard within one instance; the signature already binds the address

export function loginMessage(address, nonce, host) {
  return `${host || "Quill"} wants you to sign in with your wallet.\n\nAddress: ${address}\nNonce: ${nonce}\n\nSigning this proves you own the address. It costs nothing and cannot move funds.`;
}

/** newNonce(address, host) → { nonce (sealed), message } */
export function newNonce(address, host) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) throw Object.assign(new Error("Invalid address"), { status: 400 });
  const n = randomBytes(12).toString("hex");
  const message = loginMessage(address, n, host);
  return { nonce: seal("nonce", { a: address.toLowerCase(), n, m: message }, NONCE_MS), message };
}

const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ""), "hex"));
const toAddress = (pubUncompressed) => "0x" + Buffer.from(keccak_256(pubUncompressed.slice(1))).toString("hex").slice(-40);

/** recoverAddress(message, signature) for an EIP-191 personal_sign signature. */
export function recoverAddress(message, signature) {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const hash = keccak_256(new Uint8Array([...prefix, ...msg]));
  const sig = hexToBytes(signature);
  if (sig.length !== 65) throw new Error("Signature must be 65 bytes");
  let v = sig[64];
  if (v >= 27) v -= 27;
  const point = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(hash);
  return toAddress(point.toBytes(false));
}

/** verifyLogin({ nonce, signature }) → { token, address } */
export function verifyLogin({ nonce, signature }) {
  let n;
  try { n = unseal("nonce", nonce); } catch { throw Object.assign(new Error("Sign-in expired, try again"), { status: 400 }); }
  const now = Date.now();
  for (const [k, exp] of usedNonces) if (exp < now) usedNonces.delete(k);
  if (usedNonces.has(n.n)) throw Object.assign(new Error("This sign-in was already used"), { status: 400 });
  let addr;
  try { addr = recoverAddress(n.m, signature); } catch { throw Object.assign(new Error("Invalid signature"), { status: 401 }); }
  if (addr !== n.a) throw Object.assign(new Error("Signature does not match the address"), { status: 401 });
  usedNonces.set(n.n, n.exp);
  return { token: seal("session", { a: addr }, SESSION_MS), address: addr };
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
