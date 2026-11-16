// Sign-in with a wallet signature (personal_sign of a one-time nonce message). The session is an HttpOnly cookie.
// Without a session the API treats the visitor as anonymous: read tools work, tickets and limits do not.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "node:crypto";

const NONCE_MS = 5 * 60_000, SESSION_MS = 7 * 24 * 3600_000;
const nonces = new Map(), sessions = new Map();
const COOKIE = "aos_session";
const SECURE = process.env.COOKIE_SECURE === "1";

export function loginMessage(address, nonce, host) {
  return `${host || "AgentOS"} wants you to sign in with your wallet.\n\nAddress: ${address}\nNonce: ${nonce}\n\nSigning this proves you own the address. It costs nothing and cannot move funds.`;
}

export function newNonce(address, host) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) throw Object.assign(new Error("Invalid address"), { status: 400 });
  const now = Date.now();
  for (const [k, v] of nonces) if (now - v.t > NONCE_MS) nonces.delete(k);
  const nonce = randomBytes(12).toString("hex");
  nonces.set(nonce, { address: address.toLowerCase(), t: now, message: loginMessage(address, nonce, host) });
  return { nonce, message: nonces.get(nonce).message };
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
  const n = nonces.get(nonce);
  if (!n || Date.now() - n.t > NONCE_MS) throw Object.assign(new Error("Sign-in expired, try again"), { status: 400 });
  nonces.delete(nonce);
  let addr;
  try { addr = recoverAddress(n.message, signature); } catch { throw Object.assign(new Error("Invalid signature"), { status: 401 }); }
  if (addr !== n.address) throw Object.assign(new Error("Signature does not match the address"), { status: 401 });
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, { address: addr, t: Date.now() });
  return { token, address: addr };
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${SECURE ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function sessionAddress(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || Date.now() - s.t > SESSION_MS) { sessions.delete(m[1]); return null; }
  return s.address;
}

export function logout(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  if (m) sessions.delete(m[1]);
}
