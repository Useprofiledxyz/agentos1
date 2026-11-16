// Signed, expiring tokens (HMAC-SHA256). Sessions, sign-in nonces and tickets are sealed with this instead of being
// kept in memory, so Quill also works on serverless hosts (Vercel) where each request may hit a different instance.
//   QUILL_SECRET  required in production on serverless: a long random string shared by every instance.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.mjs";

function loadSecret() {
  if (process.env.QUILL_SECRET) return { secret: process.env.QUILL_SECRET, source: "env" };
  // Long-running servers keep a generated secret in the data dir so sessions survive restarts.
  const file = path.join(DATA_DIR, "secret.key");
  try {
    if (existsSync(file)) return { secret: readFileSync(file, "utf8").trim(), source: "file" };
    mkdirSync(DATA_DIR, { recursive: true });
    const s = randomBytes(32).toString("hex");
    writeFileSync(file, s, { mode: 0o600 });
    return { secret: s, source: "file" };
  } catch {
    return { secret: randomBytes(32).toString("hex"), source: "ephemeral" };
  }
}

const { secret: SECRET, source } = loadSecret();
export const secretSource = source;
if (process.env.VERCEL && source !== "env") console.warn("Quill: set QUILL_SECRET on Vercel, or sign-in and tickets break between instances.");

const mac = (purpose, data) => createHmac("sha256", SECRET).update(`${purpose}.${data}`).digest("base64url");

/** seal(purpose, payload, ttlMs) → opaque string. */
export function seal(purpose, payload, ttlMs) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
  return `${data}.${mac(purpose, data)}`;
}

/** unseal(purpose, token) → payload, or throws (bad signature / expired). */
export function unseal(purpose, token) {
  const [data, sig] = String(token || "").split(".");
  if (!data || !sig) throw Object.assign(new Error("Invalid token"), { status: 400 });
  const want = Buffer.from(mac(purpose, data)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw Object.assign(new Error("Invalid token"), { status: 400 });
  const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  if (!(p.exp > Date.now())) throw Object.assign(new Error("Expired. Start again."), { status: 410 });
  return p;
}
