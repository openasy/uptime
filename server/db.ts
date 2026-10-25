import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- What to check. The server never probes anything: a runner fetches the checks, runs them and posts the results.
   CREATE TABLE checks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     grp TEXT,
     type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'dns', 'tls')),
     target TEXT NOT NULL,
     expect TEXT NOT NULL DEFAULT '{}',
     interval_s INTEGER NOT NULL,
     failures_to_down INTEGER NOT NULL,
     public INTEGER NOT NULL DEFAULT 0,
     paused INTEGER NOT NULL DEFAULT 0,
     tags TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL
   );
   -- What the runners saw. Kept for a retention period; outages are kept much longer.
   CREATE TABLE results (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     check_id TEXT NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
     time TEXT NOT NULL,
     ok INTEGER NOT NULL,
     latency_ms INTEGER,
     detail TEXT,
     location TEXT
   );
   CREATE INDEX results_check ON results (check_id, time DESC);
   -- Where each check stands. A streak of failures starts at streak_at, which is when an outage begins.
   CREATE TABLE state (
     check_id TEXT PRIMARY KEY REFERENCES checks (id) ON DELETE CASCADE,
     state TEXT NOT NULL CHECK (state IN ('up', 'degraded', 'down')),
     failures INTEGER NOT NULL,
     streak_at TEXT,
     since TEXT NOT NULL,
     first_result_at TEXT NOT NULL,
     last_result_at TEXT NOT NULL
   );
   CREATE TABLE outages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     check_id TEXT NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     detail TEXT
   );
   CREATE INDEX outages_check ON outages (check_id, started_at DESC);
   CREATE INDEX outages_open ON outages (check_id) WHERE ended_at IS NULL`,
  `-- Checks from the endpoints file (OPENASY_ENDPOINTS, ADR 0052) are changed there, not here; server names the
   -- one an endpoint runs on, from the hosts file.
   ALTER TABLE checks ADD COLUMN source TEXT NOT NULL DEFAULT 'ui' CHECK (source IN ('ui', 'file'));
   ALTER TABLE checks ADD COLUMN server TEXT`,
  // An outage opens an incident in OpenAsy Incidents, and its end is noted on it (ADR 0047, 0041). pending until
  // Incidents has it, tried again while it is unreachable; failed when it was given up. incident_note is the end's.
  `ALTER TABLE outages ADD COLUMN incident_state TEXT CHECK (incident_state IN ('pending', 'opened', 'failed'));
   ALTER TABLE outages ADD COLUMN incident_id TEXT;
   ALTER TABLE outages ADD COLUMN incident_key TEXT;
   ALTER TABLE outages ADD COLUMN incident_url TEXT;
   ALTER TABLE outages ADD COLUMN incident_error TEXT;
   ALTER TABLE outages ADD COLUMN incident_note TEXT CHECK (incident_note IN ('pending', 'sent'));
   CREATE INDEX outages_incident ON outages (incident_state, incident_note) WHERE incident_state = 'pending' OR incident_note = 'pending'`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
