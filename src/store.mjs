// Tiny JSON file store under data/. Writes are serialised per file and atomic (write temp, rename).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.AGENTOS_DATA || path.resolve("data");
const locks = new Map();

export async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(path.join(DIR, name), "utf8")); }
  catch { return structuredClone(fallback); }
}

export async function writeJson(name, value) {
  await mkdir(DIR, { recursive: true });
  const file = path.join(DIR, name), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

/** update(name, fallback, fn) — read, mutate (fn may return a new value), write; serialised per file. */
export function update(name, fallback, fn) {
  const prev = locks.get(name) || Promise.resolve();
  const next = prev.then(async () => {
    const cur = await readJson(name, fallback);
    const out = (await fn(cur)) ?? cur;
    await writeJson(name, out);
    return out;
  });
  locks.set(name, next.catch(() => {}));
  return next;
}
