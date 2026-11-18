// Base58 (Bitcoin alphabet), used for Solana addresses and signatures.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function decode58(s) {
  s = String(s || "");
  let n = 0n;
  for (const c of s) { if (!(c in MAP)) throw new Error("Invalid base58"); n = n * 58n + MAP[c]; }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export function encode58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/** isSolAddress(s) — a base58 string that decodes to 32 bytes. */
export function isSolAddress(s) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ""))) return false;
  try { return decode58(s).length === 32; } catch { return false; }
}
