// API tokens for REST and MCP. Stored as SHA-256 hashes; a new token starts in dry-run with prepare scope only.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readJson, update } from "./store.mjs";

const hash = (t) => createHash("sha256").update(t).digest("hex");

/** createToken({ label, owner, scopes }) → the plain token, shown once. */
export async function createToken({ label = "token", owner = null, scopes = ["prepare"] } = {}) {
  const token = "aos_" + randomBytes(24).toString("base64url");
  const id = "t_" + randomBytes(6).toString("hex");
  await update("apitokens.json", [], (rows) => {
    rows.push({ id, label, owner: owner ? owner.toLowerCase() : null, scopes, dryRun: true, hash: hash(token), createdAt: new Date().toISOString() });
  });
  return { id, token, scopes, dryRun: true };
}

export async function findToken(token) {
  if (!token || !String(token).startsWith("aos_")) return null;
  const h = Buffer.from(hash(String(token)), "hex");
  const rows = await readJson("apitokens.json", []);
  return rows.find((r) => { const b = Buffer.from(r.hash, "hex"); return b.length === h.length && timingSafeEqual(b, h); }) || null;
}

export async function setToken(id, patch) {
  return update("apitokens.json", [], (rows) => {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new Error(`No token ${id}`);
    if (typeof patch.dryRun === "boolean") r.dryRun = patch.dryRun;
    if (Array.isArray(patch.scopes)) r.scopes = patch.scopes.filter((s) => ["prepare", "execute"].includes(s));
    if (patch.revoke) rows.splice(rows.indexOf(r), 1);
  });
}

export async function listTokens() {
  return (await readJson("apitokens.json", [])).map(({ hash: _h, ...r }) => r);
}
