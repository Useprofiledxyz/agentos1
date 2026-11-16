// Journal: an append-only audit log of every prepare, block, build, dry-run and sent transaction, with its reason.
import { readJson, update } from "./store.mjs";

const MAX = 5000;

export async function journal(entry) {
  const row = { at: new Date().toISOString(), ...entry, owner: entry.owner ? String(entry.owner).toLowerCase() : null };
  await update("journal.json", [], (rows) => { rows.push(row); if (rows.length > MAX) rows.splice(0, rows.length - MAX); });
  return row;
}

export async function readJournal({ owner, limit = 50 } = {}) {
  const rows = await readJson("journal.json", []);
  const mine = owner ? rows.filter((r) => r.owner === String(owner).toLowerCase()) : rows;
  return mine.slice(-Math.min(500, limit)).reverse();
}
