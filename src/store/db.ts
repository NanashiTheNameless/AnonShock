import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import { open as openSealed } from "./crypto.ts";

let db: DatabaseSync | null = null;

const here = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  return join(here, "schema");
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("store not opened");
  return db;
}

export function openStore(path: string = config.dbPath): DatabaseSync {
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  assertStoreReadable(db);
  return db;
}

/**
 * Fail at boot, not on the first guest request, if STORE_KEY does not match the
 * store. Running on means every link 500s one at a time with no clear cause.
 */
function assertStoreReadable(conn: DatabaseSync): void {
  const row = conn
    .prepare("SELECT id, sealed_share_id, sealed_token FROM links WHERE sealed_share_id IS NOT NULL OR sealed_token IS NOT NULL LIMIT 1")
    .get();
  if (!row) return;
  const sealed = (row["sealed_share_id"] ?? row["sealed_token"]) as Buffer;
  try {
    openSealed(sealed, String(row["id"]));
  } catch {
    throw new Error(
      "the store cannot be decrypted with this STORE_KEY: restore the right key, or run `anonshock nuke --yes-i-mean-it` to start over",
    );
  }
}

export function closeStore(): void {
  if (db) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // closing anyway
    }
    db.close();
    db = null;
  }
}

function migrate(conn: DatabaseSync): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    conn.prepare("SELECT name FROM schema_migrations").all().map((r) => String(r["name"])),
  );
  const files = readdirSync(migrationsDir())
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir(), file), "utf8");
    conn.exec("BEGIN");
    try {
      conn.exec(sql);
      conn.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        Date.now(),
      );
      conn.exec("COMMIT");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

export function getState(key: string): string | null {
  const row = getDb().prepare("SELECT v FROM instance_state WHERE k = ?").get(key);
  return row ? String(row["v"]) : null;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO instance_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    )
    .run(key, value);
}

export function isPaused(): boolean {
  return getState("paused") === "1";
}

export function setPaused(paused: boolean): void {
  setState("paused", paused ? "1" : "0");
}

export function instanceId(): string {
  let id = getState("instance_id");
  if (!id) {
    id = crypto.randomUUID();
    setState("instance_id", id);
  }
  return id;
}
