import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderStatusPage } from "./status.ts";
import { fileId, parseEndpoints } from "./endpoints.ts";
import { HOUR, MINUTE, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const T0 = () => app.clock.now;
const fromFile = (entries: Array<Record<string, unknown>>) => app.uptime.syncFile(parseEndpoints(JSON.stringify({ endpoints: entries })));

describe("checks", () => {
  it("come from the endpoints file, with defaults; no route adds or changes one", async () => {
    expect(await app.addCheck("Shop")).toMatchObject({
      name: "Shop",
      type: "http",
      source: "file",
      intervalSeconds: 300,
      failuresToDown: 2,
      public: false,
      paused: false,
      tags: [],
      status: { state: "unknown", stale: false },
      uptime: { h24: null, d90: null },
    });
    expect((await app.post("/api/v1/checks", { name: "Other", type: "tcp", target: "db:5432" })).status).toBe(404);
    const id = fileId("Shop");
    expect((await app.admin(`/api/v1/checks/${id}`, { method: "PATCH", body: JSON.stringify({ public: true }) })).status).toBe(404);
    expect((await app.admin(`/api/v1/checks/${id}`, { method: "DELETE" })).status).toBe(409);
  });

  it("refuses a file with a bad target or expectation, and changes nothing", async () => {
    const before = await app.json(await app.admin("/api/v1/checks?limit=100"));
    const bad = [
      { url: "tcp://db.example.com" },
      { url: "tcp://db.example.com:99999" },
      { url: "dns://www.example.com", expect: { recordType: "SRV" } },
      { url: "tls://shop.example.com", expect: { minDays: 999 } },
      { url: "https://u:p@shop.example.com" },
      { url: "ftp://shop.example.com" },
      { url: "https://shop.example.com", expect: { status: 700 } },
      { url: "https://shop.example.com", expect: { minDays: 3 } },
      { url: "https://shop.example.com", every: 5 },
      { url: "https://shop.example.com", failures: 0 },
      { url: "https://shop.example.com", tags: ["a b"] },
      { url: "https://shop.example.com", surprise: 1 },
      { name: "<b>", url: "tcp://x:1" },
    ];
    for (const entry of bad) expect(() => fromFile([{ name: "Bad", ...entry }]), JSON.stringify(entry)).toThrow();
    expect(await app.json(await app.admin("/api/v1/checks?limit=100"))).toEqual(before);
    for (const url of ["tcp://db.example.com:5432", "tls://shop.example.com:8443"])
      expect(() => parseEndpoints(JSON.stringify({ endpoints: [{ name: "Good", url }] }))).not.toThrow();
  });

  it("takes over a check added here before, with its history, when the file names it", async () => {
    const legacy = app.addLegacy("Legacy", "https://legacy.example.com/");
    await app.report(legacy, true);
    expect(await app.json(await app.admin(`/api/v1/checks/${legacy}`))).toMatchObject({ source: "ui", status: { state: "up" } });
    const c = await app.addCheck("Legacy", { target: "https://legacy.example.com/" });
    expect(c).toMatchObject({ id: fileId("Legacy"), source: "file", status: { state: "up" } });
    expect((await app.admin(`/api/v1/checks/${legacy}`)).status).toBe(404);
  });

  it("pauses and resumes a check, and follows the file when it changes", async () => {
    const c = await app.addCheck("Changeable", { intervalSeconds: 60, failuresToDown: 3, tags: ["web"], group: "Shop" });
    expect(c).toMatchObject({ public: false, intervalSeconds: 60, failuresToDown: 3, tags: ["web"], group: "Shop" });
    expect(await app.json(await app.admin(`/api/v1/checks/${c.id}/pause`, { method: "POST" }))).toMatchObject({ paused: true });
    expect(
      (await app.json(await app.admin("/api/v1/checks/runnable", { headers: { authorization: `Bearer test-ingest-token` } }))).checks.map(
        (x: { id: string }) => x.id,
      ),
    ).not.toContain(c.id);
    expect(await app.json(await app.admin(`/api/v1/checks/${c.id}/resume`, { method: "POST" }))).toMatchObject({ paused: false });
    expect((await app.admin("/api/v1/checks/missing/pause", { method: "POST" })).status).toBe(404);
  });

  it("lists checks by group and state, with paging", async () => {
    const all = await app.json(await app.admin("/api/v1/checks?limit=2"));
    expect(all.checks).toHaveLength(2);
    expect(all.nextCursor).toBeDefined();
    expect((await app.json(await app.admin(`/api/v1/checks?limit=2&cursor=${all.nextCursor}`))).checks.length).toBeGreaterThan(0);
    expect((await app.json(await app.admin("/api/v1/checks?state=down"))).checks).toEqual([]);
    expect((await app.admin("/api/v1/checks?state=sleeping")).status).toBe(422);
    expect((await app.admin("/api/v1/checks?limit=0")).status).toBe(422);
  });
});

describe("state, outages and uptime", () => {
  it("is degraded after one failure, down after two, and up after one success", async () => {
    const c = await app.addCheck("Flow");
    const state = async () => (await app.json(await app.admin(`/api/v1/checks/${c.id}`))).status.state;
    expect(await state()).toBe("unknown");
    const t0 = T0();
    await app.report(c.id, true);
    expect(await state()).toBe("up");
    app.clock.now = t0 + 5 * MINUTE;
    await app.report(c.id, false, app.clock.now, { detail: "Answered 500" });
    expect(await state()).toBe("degraded");
    expect((await app.json(await app.admin("/api/v1/outages"))).outages).toEqual([]);
    app.clock.now = t0 + 10 * MINUTE;
    await app.report(c.id, false, app.clock.now, { detail: "Answered 502" });
    expect(await state()).toBe("down");
    // The outage began with the first failure of the streak; its detail is the failure that made the check go down.
    const open = (await app.json(await app.admin("/api/v1/outages?open=true"))).outages;
    expect(open).toMatchObject([{ check: { name: "Flow" }, startedAt: new Date(t0 + 5 * MINUTE).toISOString(), endedAt: null, detail: "Answered 502" }]);
    app.clock.now = t0 + 15 * MINUTE;
    await app.report(c.id, true);
    expect(await state()).toBe("up");
    expect((await app.json(await app.admin("/api/v1/outages?open=false"))).outages).toMatchObject([
      { endedAt: new Date(t0 + 15 * MINUTE).toISOString(), durationSeconds: 600 },
    ]);
  });

  it("goes down at once when failuresToDown is 1, and ignores results that arrive late", async () => {
    const c = await app.addCheck("Strict", { failuresToDown: 1 });
    const t0 = (app.clock.now += 20 * MINUTE);
    await app.report(c.id, true);
    app.clock.now = t0 + 4 * MINUTE;
    await app.report(c.id, false);
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}`))).status.state).toBe("down");
    // An older success cannot undo what a newer failure said.
    await app.report(c.id, true, t0 + 2 * MINUTE);
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}`))).status.state).toBe("down");
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}/results`))).results).toHaveLength(3);
  });

  it("works uptime out from the outages, from the first result", async () => {
    app.clock.now = Date.parse("2026-10-10T00:00:00Z");
    const start = app.clock.now;
    const c = await app.addCheck("Math", { failuresToDown: 1 });
    await app.report(c.id, true);
    app.clock.now = start + HOUR;
    await app.report(c.id, false);
    app.clock.now = start + 2 * HOUR;
    await app.report(c.id, true);
    app.clock.now = start + 4 * HOUR;
    const got = await app.json(await app.admin(`/api/v1/checks/${c.id}`));
    // One hour down in four hours of history, whatever the window.
    expect(got.uptime).toEqual({ h24: 75, d7: 75, d30: 75, d90: 75 });
    // An outage still going counts up to now.
    app.clock.now = start + 3 * HOUR;
    await app.report(c.id, false);
    app.clock.now = start + 4 * HOUR;
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}`))).uptime.h24).toBe(50);
  });

  it("gives latency percentiles of the last day", async () => {
    const c = await app.addCheck("Latency");
    const results = Array.from({ length: 100 }, (_, i) => ({
      checkId: c.id,
      ok: true,
      latencyMs: i + 1,
      time: new Date(app.clock.now - i * 1000).toISOString(),
    }));
    expect((await app.ingest("/api/v1/results", { method: "POST", body: JSON.stringify({ results }) })).status).toBe(201);
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}`))).latency).toEqual({ p50: 50, p95: 95, p99: 99, samples: 100 });
  });

  it("calls a check nobody has heard from unknown and stale, never up", async () => {
    const c = await app.addCheck("Silent", { intervalSeconds: 60 });
    await app.report(c.id, true, app.clock.now);
    const status = async () => (await app.json(await app.admin(`/api/v1/checks/${c.id}`))).status;
    expect(await status()).toMatchObject({ state: "up", stale: false });
    app.clock.now += 2 * MINUTE;
    expect(await status()).toMatchObject({ state: "up", stale: false });
    app.clock.now += 2 * MINUTE;
    expect(await status()).toMatchObject({ state: "unknown", stale: true });
    expect((await app.json(await app.admin("/api/v1/summary"))).stale).toBeGreaterThan(0);
    // A paused check is not expected to report.
    await app.admin(`/api/v1/checks/${c.id}/pause`, { method: "POST" });
    expect(await status()).toMatchObject({ stale: false });
    await app.admin(`/api/v1/checks/${c.id}/resume`, { method: "POST" });
    await app.report(c.id, true, app.clock.now);
    expect(await status()).toMatchObject({ state: "up", stale: false });
  });

  it("never reported at all becomes stale too", async () => {
    const c = await app.addCheck("Never", { intervalSeconds: 60 });
    app.clock.now += 4 * MINUTE;
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}`))).status).toMatchObject({ state: "unknown", stale: true });
  });
});

describe("results from runners", () => {
  it("refuses a bad batch as a whole", async () => {
    const c = await app.addCheck("Batch");
    const before = (await app.json(await app.admin(`/api/v1/checks/${c.id}/results`))).results.length;
    const send = (results: unknown) => app.ingest("/api/v1/results", { method: "POST", body: JSON.stringify({ results }) });
    const time = new Date(app.clock.now).toISOString();
    expect(
      (
        await send([
          { checkId: c.id, ok: true, time },
          { checkId: "missing", ok: true },
        ])
      ).status,
    ).toBe(422);
    expect((await app.json(await app.admin(`/api/v1/checks/${c.id}/results`))).results).toHaveLength(before);
    expect((await send([])).status).toBe(422);
    expect((await send([{ checkId: c.id }])).status).toBe(422);
    expect((await send([{ checkId: c.id, ok: true, time: new Date(app.clock.now - 2 * 86_400_000).toISOString() }])).status).toBe(422);
    expect((await send([{ checkId: c.id, ok: true, time: new Date(app.clock.now + HOUR).toISOString() }])).status).toBe(422);
    expect((await send([{ checkId: c.id, ok: true, latencyMs: -1 }])).status).toBe(422);
    expect((await send([{ checkId: c.id, ok: true, location: "<script>" }])).status).toBe(422);
    expect((await send([{ checkId: c.id, ok: true, extra: 1 }])).status).toBe(422);
    expect((await app.ingest("/api/v1/results", { method: "POST", body: JSON.stringify({ results: [], x: 1 }) })).status).toBe(422);
    expect((await app.ingest("/api/v1/results", { method: "POST", body: "{nope" })).status).toBe(400);
  });

  it("removes passwords from addresses in details", async () => {
    const c = await app.addCheck("Detail");
    await app.report(c.id, false, app.clock.now, { detail: "connect to https://admin:hunter2@shop.example.com failed" });
    const got = (await app.json(await app.admin(`/api/v1/checks/${c.id}/results`))).results[0];
    expect(got.detail).toBe("connect to https://***@shop.example.com failed");
  });

  it("offers the runner the checks that are not paused, with their targets", async () => {
    const list = (await app.json(await app.ingest("/api/v1/checks/runnable"))).checks;
    expect(list.length).toBeGreaterThan(3);
    expect(list[0]).toMatchObject({ id: expect.any(String), type: expect.any(String), target: expect.any(String), intervalSeconds: expect.any(Number) });
  });

  it("serves the runner script to anyone", async () => {
    const res = await fetch(`${app.base}/uptime-runner.mjs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OpenAsy Uptime runner");
  });
});

describe("the public status page", () => {
  it("shows only what an admin made public, and nothing that identifies the rest", async () => {
    app.clock.now = Date.parse("2026-11-01T00:00:00Z");
    const pub = await app.addCheck("Website", {
      public: true,
      group: "Customers",
      tags: ["internal-tag"],
      target: "https://www.example.com/",
      expect: { text: "secret-marker" },
    });
    const priv = await app.addCheck("Payroll database", { type: "tcp", target: "payroll.corp.example:5432", tags: ["finance"] });
    await app.report(pub.id, true, app.clock.now);
    await app.report(priv.id, true, app.clock.now);
    const data = await app.json(await fetch(`${app.base}/api/v1/status/public`));
    expect(data.checks.map((c: { name: string }) => c.name)).toEqual(["Website"]);
    expect(data).toMatchObject({ overall: "operational", checks: [{ name: "Website", group: "Customers", state: "operational" }] });
    expect(data.checks[0].days).toHaveLength(90);
    const html = await (await fetch(`${app.base}/status`)).text();
    for (const text of [JSON.stringify(data), html]) {
      for (const leak of ["Payroll", "payroll.corp", "finance", "internal-tag", "secret-marker", "www.example.com", pub.id, priv.id, "5432"])
        expect(text, leak).not.toContain(leak);
    }
    expect(html).toContain("Website");
    expect(html).toContain("All systems operational");
    expect((await fetch(`${app.base}/status`)).headers.get("x-frame-options")).toBe("DENY");
  });

  it("shows an outage, a stale check as no recent data, and maintenance", async () => {
    const [site] = (await app.json(await app.admin("/api/v1/checks?group=Customers"))).checks;
    await app.addCheck("Website", {
      public: true,
      group: "Customers",
      tags: ["internal-tag"],
      target: "https://www.example.com/",
      expect: { text: "secret-marker" },
      failuresToDown: 1,
    });
    await app.report(site.id, false, app.clock.now + MINUTE);
    app.clock.now += 2 * MINUTE;
    let data = await app.json(await fetch(`${app.base}/api/v1/status/public`));
    expect(data).toMatchObject({ overall: "outage", checks: [{ state: "outage" }], incidents: [{ check: "Website", ongoing: true }] });
    expect(Object.keys(data.incidents[0]).sort()).toEqual(["check", "endedAt", "ongoing", "startedAt"]);
    await app.admin(`/api/v1/checks/${site.id}/pause`, { method: "POST" });
    expect((await app.json(await fetch(`${app.base}/api/v1/status/public`))).checks[0].state).toBe("maintenance");
    await app.admin(`/api/v1/checks/${site.id}/resume`, { method: "POST" });
    app.clock.now += 20 * MINUTE;
    data = await app.json(await fetch(`${app.base}/api/v1/status/public`));
    expect(data.checks[0].state).toBe("unknown");
    expect(data.overall).toBe("unknown");
  });

  it("escapes what it prints", () => {
    const html = renderStatusPage(
      {
        updatedAt: "2026-01-01T00:00:00.000Z",
        overall: "operational",
        checks: [
          {
            name: "<img src=x onerror=alert(1)>",
            group: '"><script>x</script>',
            state: "operational",
            uptime90: 100,
            days: [{ date: "2026-01-01", uptime: 100 }],
          },
        ],
        incidents: [],
      },
      "<b>Title</b>",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Title");
    expect(html).toContain("&lt;img");
  });
});

describe("access and metrics", () => {
  it("keeps checks to admins, pausing to editors, and the runner token to the runner", async () => {
    const anon = (path: string, init: RequestInit = {}) => fetch(app.base + path, init);
    expect((await anon("/api/v1/checks")).status).toBe(401);
    expect((await anon("/api/v1/checks/runnable")).status).toBe(401);
    expect((await anon("/api/v1/results", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await anon("/api/v1/outages")).status).toBe(401);
    expect((await app.ingest("/api/v1/checks")).status).toBe(401);
    expect((await app.ingest("/api/v1/summary")).status).toBe(401);
    const closed = await startApp({ version: "0.1.0", ingestToken: undefined, adminToken: undefined });
    expect((await fetch(`${closed.base}/api/v1/checks/runnable`)).status).toBe(503);
    await closed.close();
  });

  it("answers version, health and metrics, one line per check", async () => {
    expect(await app.json(await fetch(`${app.base}/api/v1/version`))).toEqual({ product: "uptime", version: "0.1.0" });
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(200);
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="uptime",version="0.1.0"} 1');
    const fresh = await app.addCheck('Fresh "quoted"'.replace(/"/g, ""), { intervalSeconds: 3600 });
    await app.report(fresh.id, true);
    const failing = await app.addCheck("Failing", { failuresToDown: 1, intervalSeconds: 3600 });
    await app.report(failing.id, false);
    const text = await (await fetch(`${app.base}/metrics`)).text();
    expect(text).toContain('openasy_uptime_check_up{check="Fresh quoted"} 1');
    expect(text).toContain('openasy_uptime_check_up{check="Failing"} 0');
    expect(text).toContain('openasy_uptime_check_stale{check="Fresh quoted"} 0');
    // A check nobody has heard from has no up/down sample, only the stale flag.
    expect(text).toMatch(/openasy_uptime_check_stale\{check="Never"\} 1/);
    expect(text).not.toContain('openasy_uptime_check_up{check="Never"}');
  });
});

describe("the overview", () => {
  let own: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    own = await startApp({ version: "0.1.0" });
  });
  afterAll(() => own.close());

  it("sums uptime over the checks, marks each day at its worst and ranks downtime", async () => {
    own.clock.now = Date.parse("2026-10-10T00:00:00Z");
    const start = own.clock.now;
    const shop = await own.addCheck("Shop", { failuresToDown: 1 });
    const api = await own.addCheck("API", { failuresToDown: 1 });
    await own.report(shop.id, true);
    await own.report(api.id, true, own.clock.now, { latencyMs: 120 });
    own.clock.now = start + HOUR;
    await own.report(shop.id, false);
    own.clock.now = start + 2 * HOUR;
    await own.report(shop.id, true, own.clock.now, { latencyMs: 80 });
    own.clock.now = start + 4 * HOUR;
    const o = await own.json(await own.admin("/api/v1/overview"));
    // Shop was down one hour in four, API never: 75% and 100%.
    expect(o.uptime).toEqual({ h24: 87.5, d30: 87.5 });
    expect(o.days).toHaveLength(90);
    expect(o.days.at(-1)).toEqual({ date: "2026-10-10", uptime: 87.5, worst: 75, outages: 1 });
    expect(o.days[0]).toMatchObject({ uptime: null, worst: null, outages: 0 });
    expect(o.downtime).toEqual([{ id: shop.id, name: "Shop", seconds: 3600 }]);
    expect(o.outages).toHaveLength(1);
    expect(o.outages[0]).toMatchObject({ check: { name: "Shop" }, endedAt: expect.any(String) });
    expect(o.latency.hours).toHaveLength(24);
    expect(o.latency.ms.filter((x: number | null) => x !== null)).toEqual([120, 80]);
  });

  it("leaves paused checks out", async () => {
    const first = await own.json(await own.admin("/api/v1/overview"));
    const quiet = await own.addCheck("Quiet");
    await own.admin(`/api/v1/checks/${quiet.id}/pause`, { method: "POST" });
    expect((await own.json(await own.admin("/api/v1/overview"))).uptime).toEqual(first.uptime);
  });
});
