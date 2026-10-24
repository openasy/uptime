// Starts the app on a random port for tests, with a clock the test moves.
import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { fileId, parseEndpoints } from "./endpoints.ts";
import { openDb } from "./db.ts";
import { createUptime } from "./uptime.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export async function startApp(opts: Partial<AppOptions> & { version: string; start?: number }) {
  const db = openDb(":memory:");
  const clock = { now: opts.start ?? Date.parse("2026-10-01T12:00:00Z") };
  const uptime = createUptime(db, { clock: () => clock.now });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "uptime", productName: "OpenAsy Uptime", origin: base });
  const runnerScript = readFileSync(new URL("../runner/uptime-runner.mjs", import.meta.url), "utf8");
  const { start: _start, ...rest } = opts;
  handler = createApp({ db, uptime, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, runnerScript, ...rest });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const ingest = as(INGEST_TOKEN);
  const json = async (res: Response) => (await res.json()) as any;
  const post = (path: string, body: unknown) => admin(path, { method: "POST", body: JSON.stringify(body) });
  /** Adds an http check and returns it. */
  // Checks come from the endpoints file only (ADR 0052): each one a test adds is another entry in it.
  const entries: Array<Record<string, unknown>> = [];
  const addCheck = async (name: string, extra: Record<string, unknown> = {}) => {
    const { type = "http", target = "https://shop.example.com/health", intervalSeconds, failuresToDown, ...rest } = extra;
    // The same name again is the same entry, changed.
    const at = entries.findIndex((e) => e.name === name);
    if (at >= 0) entries.splice(at, 1);
    entries.push({
      name,
      url: type === "http" ? target : `${type}://${target}`,
      ...(intervalSeconds === undefined ? {} : { every: intervalSeconds }),
      ...(failuresToDown === undefined ? {} : { failures: failuresToDown }),
      ...rest,
    });
    uptime.syncFile(parseEndpoints(JSON.stringify({ endpoints: entries })));
    return json(await admin(`/api/v1/checks/${fileId(name)}`));
  };
  /** A check added in the UI before the file was the way in, as an install upgraded from then still has. */
  const addLegacy = (name: string, target = "https://shop.example.com/health") => {
    const id = `ui-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    db.prepare(
      "INSERT INTO checks (id, name, type, target, expect, interval_s, failures_to_down, public, tags, created_at) VALUES (?, ?, 'http', ?, '{}', 300, 2, 0, '[]', ?)",
    ).run(id, name, target, new Date(clock.now).toISOString());
    return id;
  };
  /** Posts results the way a runner does. `at` is minutes from the test's start. */
  const report = (checkId: string, ok: boolean, atMs = clock.now, extra: Record<string, unknown> = {}) =>
    ingest("/api/v1/results", { method: "POST", body: JSON.stringify({ results: [{ checkId, ok, time: new Date(atMs).toISOString(), ...extra }] }) });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, uptime, auth, base, admin, ingest, json, post, addCheck, addLegacy, report, clock, close };
}
