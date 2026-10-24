import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fileId, type Endpoint } from "./endpoints.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "not-found" | "conflict" | "not-configured" | "payload-too-large" | "internal-error";

export class UptimeError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export type CheckType = "http" | "tcp" | "dns" | "tls";
export type State = "up" | "degraded" | "down" | "unknown";

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT"];
const DAY = 86_400_000;
/** A result that is older than this, or further ahead than SKEW, is refused: a runner with a wrong clock would rewrite history. */
const MAX_AGE = DAY;
const SKEW = 5 * 60_000;
const MAX_BATCH = 500;
/** Outages are the history people ask about, so they outlive the results they were found in. */
const OUTAGE_RETENTION_DAYS = 400;

const bad = (detail: string) => new UptimeError(422, "invalid-body", detail);
const notFound = (what: string) => new UptimeError(404, "not-found", `${what} does not exist.`);

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Passwords inside addresses never reach the database or a page. */
const clean = (s: string) => s.replace(/\/\/[^/\s:@]+:[^@\s/]+@/g, "//***@");

interface Expect {
  status?: number;
  text?: string;
  recordType?: string;
  record?: string;
  minDays?: number;
}

function parseTarget(type: CheckType, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw bad("target is required.");
  const t = value.trim();
  if (type === "http") {
    const url = URL.parse(t);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw bad("An http check needs a web address starting with http:// or https://.");
    if (url.username || url.password) throw bad("The address must not hold a user name or password: they would be shown to the runner and in logs.");
    return url.href;
  }
  if (type === "tcp") {
    if (!/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):\d{1,5}$/.test(t) || Number(t.slice(t.lastIndexOf(":") + 1)) > 65535)
      throw bad("A tcp check needs host:port, such as db.example.com:5432.");
    return t;
  }
  if (type === "dns") {
    if (!/^[A-Za-z0-9._-]{1,253}$/.test(t)) throw bad("A dns check needs a host name, such as www.example.com.");
    return t;
  }
  if (!/^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/.test(t)) throw bad("A tls check needs a host name, with :port if it is not 443.");
  return t;
}

function parseExpect(type: CheckType, value: unknown): Expect {
  if (value === undefined) value = {};
  if (!isObj(value)) throw bad("expect must be an object.");
  const allowed: Record<CheckType, string[]> = { http: ["status", "text"], tcp: [], dns: ["recordType", "record"], tls: ["minDays"] };
  for (const k of Object.keys(value))
    if (!allowed[type].includes(k)) throw bad(`expect.${k} does not apply to a ${type} check; it takes ${allowed[type].join(", ") || "nothing"}.`);
  const e: Expect = {};
  if (value.status !== undefined) {
    if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599)
      throw bad("expect.status must be an HTTP status, 100 to 599.");
    e.status = value.status as number;
  }
  if (value.text !== undefined) {
    if (typeof value.text !== "string" || !value.text || value.text.length > 200) throw bad("expect.text must be a text of up to 200 characters.");
    e.text = value.text;
  }
  if (value.recordType !== undefined) {
    if (typeof value.recordType !== "string" || !RECORD_TYPES.includes(value.recordType))
      throw bad(`expect.recordType must be one of ${RECORD_TYPES.join(", ")}.`);
    e.recordType = value.recordType;
  }
  if (value.record !== undefined) {
    if (typeof value.record !== "string" || !value.record || value.record.length > 255) throw bad("expect.record must be a value of up to 255 characters.");
    e.record = value.record;
  }
  if (value.minDays !== undefined) {
    if (!Number.isInteger(value.minDays) || (value.minDays as number) < 0 || (value.minDays as number) > 365) throw bad("expect.minDays must be 0 to 365.");
    e.minDays = value.minDays as number;
  }
  if (type === "dns" && e.record && !e.recordType) e.recordType = "A";
  return e;
}

const int = (v: unknown, name: string, min: number, max: number) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`);
  return v as number;
};

interface CheckRow {
  id: string;
  name: string;
  grp: string | null;
  type: CheckType;
  target: string;
  expect: string;
  interval_s: number;
  failures_to_down: number;
  public: number;
  paused: number;
  tags: string;
  created_at: string;
  source: "ui" | "file";
  server: string | null;
}

interface StateRow {
  check_id: string;
  state: "up" | "degraded" | "down";
  failures: number;
  streak_at: string | null;
  since: string;
  first_result_at: string;
  last_result_at: string;
}

export interface UptimeOptions {
  /** Results older than this are deleted. Outages stay for 400 days (ADR 0015). */
  retentionDays?: number;
  /**
   * Days a TLS check wants left on a certificate when it does not say: the critical threshold shared with
   * Certificates (OPENASY_CERT_WARN_DAYS), so the two products do not alert on the same certificate at the same step.
   */
  tlsMinDays?: number;
  /** For tests. */
  clock?: () => number;
}

/** The critical threshold of a warn-days list, as Certificates computes it: 7, or the largest value when it is less. */
export const criticalDays = (warnDays: number[]) => Math.min(7, Math.max(...warnDays));

/** "30,14,7,1" as a list of days, largest first. The same variable and rule as Certificates. */
export function parseWarnDays(value: string | undefined): number[] {
  const days = (value ?? "30,14,7,1").split(",").map((d) => Number(d.trim()));
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 365))
    throw new Error("OPENASY_CERT_WARN_DAYS is a comma-separated list of days, 1 to 365, such as 30,14,7,1");
  return [...new Set(days)].sort((a, b) => b - a);
}

/** What a check runs against, from an endpoint in the file. */
function targetOf(e: Endpoint): string {
  if (e.kind === "http") return e.url;
  const rest = e.url.slice(e.url.indexOf("//") + 2);
  return e.kind === "tls" && e.port === 443 ? rest.replace(/:443$/, "") : rest;
}

const WINDOWS = { h24: DAY, d7: 7 * DAY, d30: 30 * DAY, d90: 90 * DAY } as const;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function createUptime(db: DatabaseSync, { retentionDays = 30, tlsMinDays = 7, clock = Date.now }: UptimeOptions = {}) {
  const iso = (t: number) => new Date(t).toISOString();

  const checkRow = (id: string) => {
    const r = db.prepare("SELECT * FROM checks WHERE id = ?").get(id) as unknown as CheckRow | undefined;
    if (!r) throw notFound("The check");
    return r;
  };
  const stateRow = (id: string) => db.prepare("SELECT * FROM state WHERE check_id = ?").get(id) as unknown as StateRow | undefined;
  const fromFile = (c: CheckRow) => {
    if (c.source === "file") throw new UptimeError(409, "conflict", "This check comes from the endpoints file (OPENASY_ENDPOINTS). Change or remove it there.");
    return c;
  };

  /** Downtime inside [start, end], from the outages that touch it. */
  function downtime(checkId: string, start: number, end: number): number {
    const rows = db
      .prepare("SELECT started_at, ended_at FROM outages WHERE check_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)")
      .all(checkId, iso(end), iso(start)) as Array<{ started_at: string; ended_at: string | null }>;
    let total = 0;
    for (const o of rows) total += Math.max(0, Math.min(end, o.ended_at ? Date.parse(o.ended_at) : end) - Math.max(start, Date.parse(o.started_at)));
    return total;
  }

  /** Percent of the time the check was not in an outage, from when it first reported. Null until it has a few seconds of history. */
  function uptime(checkId: string, windowMs: number, st: StateRow | undefined): number | null {
    if (!st) return null;
    const end = clock();
    const start = Math.max(end - windowMs, Date.parse(st.first_result_at));
    if (end - start < 1000) return null;
    return round3(100 * (1 - downtime(checkId, start, end) / (end - start)));
  }

  /** One value per day, oldest first, null for days before the check had results. */
  function days(checkId: string, count: number, st: StateRow | undefined): Array<{ date: string; uptime: number | null }> {
    const end = clock();
    const today = Math.floor(end / DAY) * DAY;
    const out: Array<{ date: string; uptime: number | null }> = [];
    for (let i = count - 1; i >= 0; i--) {
      const dayStart = today - i * DAY;
      const date = iso(dayStart).slice(0, 10);
      if (!st) {
        out.push({ date, uptime: null });
        continue;
      }
      const from = Math.max(dayStart, Date.parse(st.first_result_at));
      const to = Math.min(dayStart + DAY, end);
      out.push({ date, uptime: to - from < 1000 ? null : round3(100 * (1 - downtime(checkId, from, to) / (to - from))) });
    }
    return out;
  }

  function latency(checkId: string) {
    const rows = db
      .prepare("SELECT latency_ms AS l FROM results WHERE check_id = ? AND ok = 1 AND latency_ms IS NOT NULL AND time > ? ORDER BY latency_ms LIMIT 20000")
      .all(checkId, iso(clock() - DAY)) as Array<{ l: number }>;
    if (!rows.length) return null;
    const at = (p: number) => rows[Math.min(rows.length - 1, Math.ceil((p / 100) * rows.length) - 1)]!.l;
    return { p50: at(50), p95: at(95), p99: at(99), samples: rows.length };
  }

  /** What to show. A check nobody has heard from for three intervals is unknown, never green. */
  function status(c: CheckRow, st: StateRow | undefined) {
    const last = st?.last_result_at ?? c.created_at;
    const stale = c.paused === 0 && clock() - Date.parse(last) > 3 * c.interval_s * 1000;
    const state: State = !st || stale ? "unknown" : st.state;
    return { state, stale, since: st?.since ?? null, lastResultAt: st?.last_result_at ?? null, failures: st?.failures ?? 0 };
  }

  function presentCheck(c: CheckRow, detail = false) {
    const st = stateRow(c.id);
    const base = {
      id: c.id,
      name: c.name,
      group: c.grp,
      type: c.type,
      target: c.target,
      expect: JSON.parse(c.expect) as Expect,
      intervalSeconds: c.interval_s,
      failuresToDown: c.failures_to_down,
      public: c.public === 1,
      paused: c.paused === 1,
      tags: JSON.parse(c.tags) as string[],
      source: c.source,
      server: c.server,
      status: status(c, st),
      uptime: { h24: uptime(c.id, WINDOWS.h24, st), d7: uptime(c.id, WINDOWS.d7, st), d30: uptime(c.id, WINDOWS.d30, st), d90: uptime(c.id, WINDOWS.d90, st) },
      createdAt: c.created_at,
    };
    return detail ? { ...base, latency: latency(c.id) } : base;
  }

  const presentOutage = (o: Record<string, any>) => ({
    id: o.id as number,
    check: { id: o.check_id as string, name: o.name as string },
    startedAt: o.started_at as string,
    endedAt: (o.ended_at as string | null) ?? null,
    durationSeconds: Math.round(((o.ended_at ? Date.parse(o.ended_at) : clock()) - Date.parse(o.started_at)) / 1000),
    detail: (o.detail as string | null) ?? null,
  });

  /** One result moves the state machine one step. Results that arrive late are kept but do not move it back. */
  function step(c: CheckRow, r: { time: string; ok: boolean; detail: string | null }) {
    const st = stateRow(c.id);
    if (st && Date.parse(r.time) <= Date.parse(st.last_result_at)) return;
    if (r.ok) {
      const since = st && st.state === "up" ? st.since : r.time;
      db.prepare(
        "INSERT INTO state (check_id, state, failures, streak_at, since, first_result_at, last_result_at) VALUES (?, 'up', 0, NULL, ?, ?, ?) ON CONFLICT (check_id) DO UPDATE SET state = 'up', failures = 0, streak_at = NULL, since = excluded.since, last_result_at = excluded.last_result_at",
      ).run(c.id, since, st?.first_result_at ?? r.time, r.time);
      db.prepare("UPDATE outages SET ended_at = ? WHERE check_id = ? AND ended_at IS NULL").run(r.time, c.id);
      return;
    }
    const failures = (st?.failures ?? 0) + 1;
    const streak = st?.streak_at ?? r.time;
    const next = failures >= c.failures_to_down ? "down" : "degraded";
    const since = st && st.state === next ? st.since : r.time;
    db.prepare(
      "INSERT INTO state (check_id, state, failures, streak_at, since, first_result_at, last_result_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (check_id) DO UPDATE SET state = excluded.state, failures = excluded.failures, streak_at = excluded.streak_at, since = excluded.since, last_result_at = excluded.last_result_at",
    ).run(c.id, next, failures, streak, since, st?.first_result_at ?? r.time, r.time);
    if (next === "down" && !db.prepare("SELECT 1 FROM outages WHERE check_id = ? AND ended_at IS NULL").get(c.id)) {
      db.prepare("INSERT INTO outages (check_id, started_at, detail) VALUES (?, ?, ?)").run(c.id, streak, r.detail);
    }
  }

  return {
    setPaused(id: string, paused: boolean) {
      checkRow(id);
      db.prepare("UPDATE checks SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
      return presentCheck(checkRow(id), true);
    },

    deleteCheck(id: string) {
      fromFile(checkRow(id));
      db.prepare("DELETE FROM checks WHERE id = ?").run(id);
    },

    /**
     * Makes the checks match the endpoints file (ADR 0052): adds, changes and removes them. A check added here before,
     * with the name of an entry, becomes the file's and keeps its results and outages. Every entry is checked first, so a bad one refuses the whole file and changes nothing. A
     * check whose kind changes starts again, without the old one's history. Returns what to fix that did not stop it.
     */
    syncFile(endpoints: Endpoint[]): string[] {
      const wanted = endpoints.map((e) => {
        try {
          return { e, id: fileId(e.name), target: parseTarget(e.kind, targetOf(e)), expect: JSON.stringify(parseExpect(e.kind, e.expect)) };
        } catch (err) {
          throw new Error(`${e.name}: ${(err as Error).message}`);
        }
      });
      const warnings: string[] = [];
      const kept: string[] = [];
      db.exec("BEGIN IMMEDIATE");
      // A check taken over changes its id, and its results with it, before the keys are checked at the end.
      db.exec("PRAGMA defer_foreign_keys = ON");
      try {
        for (const w of wanted) {
          const same = db.prepare("SELECT id, source FROM checks WHERE name = ?").get(w.e.name) as { id: string; source: string } | undefined;
          if (same && same.id !== w.id) {
            if (same.source !== "ui") continue;
            for (const table of ["checks", "results", "state", "outages"])
              db.prepare(`UPDATE ${table} SET ${table === "checks" ? "id" : "check_id"} = ? WHERE ${table === "checks" ? "id" : "check_id"} = ?`).run(
                w.id,
                same.id,
              );
            db.prepare("UPDATE checks SET source = 'file' WHERE id = ?").run(w.id);
          }
          kept.push(w.id);
          const current = db.prepare("SELECT type FROM checks WHERE id = ?").get(w.id) as { type: CheckType } | undefined;
          if (current && current.type !== w.e.kind) db.prepare("DELETE FROM checks WHERE id = ?").run(w.id);
          db.prepare(
            `INSERT INTO checks (id, name, grp, type, target, expect, interval_s, failures_to_down, public, tags, created_at, source, server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file', ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, grp = excluded.grp, target = excluded.target, expect = excluded.expect, interval_s = excluded.interval_s, failures_to_down = excluded.failures_to_down, public = excluded.public, tags = excluded.tags, server = excluded.server`,
          ).run(
            w.id,
            w.e.name,
            w.e.group,
            w.e.kind,
            w.target,
            w.expect,
            w.e.everySeconds ?? 300,
            w.e.failures ?? 2,
            w.e.public ? 1 : 0,
            JSON.stringify(w.e.tags),
            iso(clock()),
            w.e.server,
          );
        }
        const gone = (db.prepare("SELECT id FROM checks WHERE source = 'file'").all() as Array<{ id: string }>).filter((r) => !kept.includes(r.id));
        for (const r of gone) db.prepare("DELETE FROM checks WHERE id = ?").run(r.id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return warnings;
    },

    check: (id: string) => presentCheck(checkRow(id), true),

    listChecks(filter: { group?: string; state?: string }, cursor: string | undefined, limit: number): Page<ReturnType<typeof presentCheck>> {
      if (filter.state && !["up", "degraded", "down", "unknown"].includes(filter.state)) throw bad("state must be up, degraded, down or unknown.");
      const rows = db
        .prepare(`SELECT * FROM checks ${filter.group ? "WHERE grp = ?" : ""} ORDER BY COALESCE(grp, ''), name`)
        .all(...(filter.group ? [filter.group] : [])) as unknown as CheckRow[];
      const all = rows.map((c) => presentCheck(c)).filter((c) => !filter.state || c.status.state === filter.state);
      const offset = decodeCursor(cursor);
      return { items: all.slice(offset, offset + limit), ...(all.length > offset + limit && { nextCursor: encodeCursor(offset + limit) }) };
    },

    /** What a runner needs: every check that is not paused. */
    runnable() {
      return (db.prepare("SELECT * FROM checks WHERE paused = 0 ORDER BY name").all() as unknown as CheckRow[]).map((c) => {
        const expect = JSON.parse(c.expect) as Expect;
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          target: c.target,
          expect: c.type === "tls" ? { minDays: tlsMinDays, ...expect } : expect,
          intervalSeconds: c.interval_s,
        };
      });
    },

    /** Takes what runners saw. Everything is checked first, so a bad result does not leave the rest half stored. */
    record(body: Record<string, unknown>) {
      const { results, ...rest } = body;
      if (Object.keys(rest).length || !Array.isArray(results) || !results.length || results.length > MAX_BATCH)
        throw bad(`Expected { results: [...] } with 1 to ${MAX_BATCH} results.`);
      const now = clock();
      const parsed = results.map((r, i) => {
        const at = `results[${i}]`;
        if (!isObj(r)) throw bad(`${at} must be an object.`);
        const extra = Object.keys(r).filter((k) => !["checkId", "time", "ok", "latencyMs", "detail", "location"].includes(k));
        if (extra.length) throw bad(`${at}: unknown fields ${extra.join(", ")}.`);
        if (typeof r.checkId !== "string") throw bad(`${at}.checkId is required.`);
        const c = db.prepare("SELECT * FROM checks WHERE id = ?").get(r.checkId) as unknown as CheckRow | undefined;
        if (!c) throw bad(`${at}.checkId does not name a check.`);
        if (typeof r.ok !== "boolean") throw bad(`${at}.ok must be true or false.`);
        let t = now;
        if (r.time !== undefined) {
          t = typeof r.time === "string" ? Date.parse(r.time) : NaN;
          if (Number.isNaN(t)) throw bad(`${at}.time must be a date and time.`);
          if (t < now - MAX_AGE || t > now + SKEW) throw bad(`${at}.time must be within the last day and not in the future; check the runner's clock.`);
        }
        const latencyMs = r.latencyMs === undefined || r.latencyMs === null ? null : int(r.latencyMs, `${at}.latencyMs`, 0, 600_000);
        if (r.detail !== undefined && (typeof r.detail !== "string" || r.detail.length > 500))
          throw bad(`${at}.detail must be a text of up to 500 characters.`);
        if (r.location !== undefined && (typeof r.location !== "string" || !/^[A-Za-z0-9 ._:-]{1,64}$/.test(r.location)))
          throw bad(`${at}.location is a short name of up to 64 characters.`);
        return {
          c,
          time: iso(t),
          ok: r.ok,
          latencyMs,
          detail: typeof r.detail === "string" ? clean(r.detail) : null,
          location: (r.location as string | undefined) ?? null,
        };
      });
      parsed.sort((a, b) => a.time.localeCompare(b.time));
      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare("INSERT INTO results (check_id, time, ok, latency_ms, detail, location) VALUES (?, ?, ?, ?, ?, ?)");
        for (const r of parsed) {
          insert.run(r.c.id, r.time, r.ok ? 1 : 0, r.latencyMs, r.detail, r.location);
          step(r.c, r);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { accepted: parsed.length };
    },

    results(checkId: string, cursor: string | undefined, limit: number) {
      checkRow(checkId);
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare("SELECT time, ok, latency_ms, detail, location FROM results WHERE check_id = ? ORDER BY time DESC, id DESC LIMIT ? OFFSET ?")
        .all(checkId, limit + 1, offset) as Array<Record<string, any>>;
      const items = rows.slice(0, limit).map((r) => ({
        time: r.time as string,
        ok: r.ok === 1,
        latencyMs: (r.latency_ms as number | null) ?? null,
        detail: (r.detail as string | null) ?? null,
        location: (r.location as string | null) ?? null,
      }));
      return { items, ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) } satisfies Page<unknown>;
    },

    outages(filter: { checkId?: string; open?: boolean }, cursor: string | undefined, limit: number) {
      if (filter.checkId) checkRow(filter.checkId);
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.checkId) (where.push("o.check_id = ?"), args.push(filter.checkId));
      if (filter.open !== undefined) where.push(filter.open ? "o.ended_at IS NULL" : "o.ended_at IS NOT NULL");
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare(
          `SELECT o.*, c.name FROM outages o JOIN checks c ON c.id = o.check_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.started_at DESC, o.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, limit + 1, offset) as Array<Record<string, any>>;
      return {
        items: rows.slice(0, limit).map(presentOutage),
        ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }),
      } satisfies Page<unknown>;
    },

    summary() {
      const rows = db.prepare("SELECT * FROM checks").all() as unknown as CheckRow[];
      const count = { up: 0, degraded: 0, down: 0, unknown: 0 };
      let stale = 0;
      let paused = 0;
      for (const c of rows) {
        const s = status(c, stateRow(c.id));
        count[s.state]++;
        if (s.stale) stale++;
        if (c.paused) paused++;
      }
      const openOutages = (db.prepare("SELECT COUNT(*) AS n FROM outages WHERE ended_at IS NULL").get() as { n: number }).n;
      return { checks: rows.length, ...count, stale, paused, openOutages };
    },

    /** For /metrics: one row per check. */
    gauges() {
      return (db.prepare("SELECT * FROM checks ORDER BY name").all() as unknown as CheckRow[]).map((c) => {
        const s = status(c, stateRow(c.id));
        return { name: c.name, state: s.state, stale: s.stale };
      });
    },

    /**
     * What anyone may see (ADR 0047): public checks by name, their state, 90 days of uptime and their outages. No
     * addresses, expectations, tags, details or ids, and nothing at all about checks that are not public.
     */
    publicStatus() {
      const rows = db.prepare("SELECT * FROM checks WHERE public = 1 ORDER BY COALESCE(grp, ''), name").all() as unknown as CheckRow[];
      const checks = rows.map((c) => {
        const st = stateRow(c.id);
        const s = status(c, st);
        const shown = c.paused
          ? "maintenance"
          : s.state === "up"
            ? "operational"
            : s.state === "degraded"
              ? "degraded"
              : s.state === "down"
                ? "outage"
                : "unknown";
        return {
          name: c.name,
          group: c.grp,
          state: shown as "operational" | "degraded" | "outage" | "unknown" | "maintenance",
          uptime90: uptime(c.id, WINDOWS.d90, st),
          days: days(c.id, 90, st),
        };
      });
      const overall = !checks.length
        ? "unknown"
        : checks.some((c) => c.state === "outage")
          ? "outage"
          : checks.some((c) => c.state === "degraded")
            ? "degraded"
            : checks.every((c) => c.state === "unknown")
              ? "unknown"
              : "operational";
      const out = db
        .prepare(
          "SELECT o.started_at, o.ended_at, c.name FROM outages o JOIN checks c ON c.id = o.check_id WHERE c.public = 1 AND (o.ended_at IS NULL OR o.ended_at > ?) ORDER BY o.started_at DESC LIMIT 50",
        )
        .all(iso(clock() - 7 * DAY)) as Array<{ started_at: string; ended_at: string | null; name: string }>;
      return {
        updatedAt: iso(clock()),
        overall,
        checks,
        incidents: out.map((o) => ({ check: o.name, startedAt: o.started_at, endedAt: o.ended_at, ongoing: o.ended_at === null })),
      };
    },

    purge() {
      db.prepare("DELETE FROM results WHERE time < ?").run(iso(clock() - retentionDays * DAY));
      db.prepare("DELETE FROM outages WHERE ended_at IS NOT NULL AND ended_at < ?").run(iso(clock() - OUTAGE_RETENTION_DAYS * DAY));
    },
  };
}

export type Uptime = ReturnType<typeof createUptime>;
export type PublicStatus = ReturnType<Uptime["publicStatus"]>;
