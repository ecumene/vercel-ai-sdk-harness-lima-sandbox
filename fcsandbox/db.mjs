// Tiny persistence layer for the control plane. This is the "DB" that stores
// sandbox + session metadata (like Vercel's control plane tracks sandboxes,
// sessions, and snapshots). It prefers node:sqlite and transparently falls back
// to a JSON file if sqlite isn't available in this Node build.
//
// Exposes a minimal key/value table API: get / set / del / list(prefix).

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export async function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(path);
    sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const getStmt = sql.prepare('SELECT v FROM kv WHERE k = ?');
    const setStmt = sql.prepare(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    );
    const delStmt = sql.prepare('DELETE FROM kv WHERE k = ?');
    const listStmt = sql.prepare('SELECT k, v FROM kv WHERE k LIKE ? ORDER BY k');
    return {
      backend: 'sqlite',
      get: (k) => {
        const row = getStmt.get(k);
        return row ? JSON.parse(row.v) : undefined;
      },
      set: (k, v) => void setStmt.run(k, JSON.stringify(v)),
      del: (k) => void delStmt.run(k),
      list: (prefix) =>
        listStmt.all(`${prefix}%`).map((r) => [r.k, JSON.parse(r.v)]),
    };
  } catch {
    // JSON-file fallback (no native sqlite in this runtime).
    const file = `${path}.json`;
    const store = existsSync(file)
      ? new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))))
      : new Map();
    const flush = () =>
      writeFileSync(file, JSON.stringify(Object.fromEntries(store), null, 2));
    return {
      backend: 'json',
      get: (k) => store.get(k),
      set: (k, v) => {
        store.set(k, v);
        flush();
      },
      del: (k) => {
        store.delete(k);
        flush();
      },
      list: (prefix) =>
        [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort(),
    };
  }
}
