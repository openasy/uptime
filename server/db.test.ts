import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "uptime-")), "nested", "uptime.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
    second.close();
  });

  it("deletes a check's results, state and outages with it", () => {
    const db = openDb(":memory:");
    db.exec(`INSERT INTO checks (id, name, type, target, interval_s, failures_to_down, created_at) VALUES ('c', 'Shop', 'http', 'https://shop.example.com', 300, 2, 'now');
      INSERT INTO results (check_id, time, ok) VALUES ('c', 'now', 1);
      INSERT INTO state VALUES ('c', 'up', 0, NULL, 'now', 'now', 'now');
      INSERT INTO outages (check_id, started_at) VALUES ('c', 'now');
      DELETE FROM checks`);
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM results) + (SELECT COUNT(*) FROM state) + (SELECT COUNT(*) FROM outages) AS n").get()).toEqual({ n: 0 });
  });
});
