import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIncidentsLink } from "./incidents.ts";
import { MINUTE, startApp } from "./test-app.ts";

const TOKEN = "oa_incidents_editor";

/** Incidents as uptime sees it: one incident per external id, notes on its timeline. */
function fakeIncidents() {
  const incidents: Array<{ id: string; key: string; body: Record<string, any>; evidence: unknown[]; notes: string[] }> = [];
  let down = false;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (down) return send(503, { detail: "Starting." });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, {});
    if (req.method === "POST" && req.url === "/api/v1/incidents") {
      const same = incidents.find((i) => i.body.external.reference === body.external.reference);
      if (same) return send(200, { id: same.id, key: same.key });
      const i = { id: `id-${incidents.length + 1}`, key: `INC-${incidents.length + 1}`, body, evidence: [], notes: [] };
      incidents.push(i);
      return send(201, { id: i.id, key: i.key });
    }
    const m = /^\/api\/v1\/incidents\/([^/]+)\/(evidence|timeline)$/.exec(req.url!);
    const i = m && incidents.find((x) => x.id === m[1]);
    if (req.method === "POST" && i) {
      if (m![2] === "evidence") i.evidence.push(body);
      else i.notes.push(body.text);
      return send(201, {});
    }
    send(404, {});
  });
  return { server, incidents, setDown: (v: boolean) => (down = v) };
}

const fake = fakeIncidents();
let app: Awaited<ReturnType<typeof startApp>>;
const outages = async () => (await app.json(await app.admin("/api/v1/outages"))).outages as Array<Record<string, any>>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  app = await startApp({
    version: "0.1.0",
    uptimeOptions: {
      incidents: {
        link: createIncidentsLink({
          url: `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`,
          token: TOKEN,
          publicUrl: "https://incidents.example.com",
          product: "uptime",
        }),
        severity: "high",
        checkUrl: (id) => `https://uptime.example.com/checks/${id}`,
      },
    },
  });
});
afterAll(async () => {
  await app.close();
  await new Promise((r) => fake.server.close(r));
});

describe("incidents from outages (ADR 0041)", () => {
  it("opens one incident when a check goes down, and notes on it when the check is up again", async () => {
    const check = await app.addCheck("Shop");
    const t0 = app.clock.now;
    // One failure is degraded, not an outage: nothing is opened.
    await app.report(check.id, false, t0, { detail: "HTTP 503" });
    await app.uptime.deliverIncidents();
    expect(fake.incidents).toHaveLength(0);
    app.clock.now = t0 + MINUTE;
    await app.report(check.id, false, t0 + MINUTE, { detail: "HTTP 503" });
    await app.uptime.deliverIncidents();
    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0]!.body).toEqual({
      title: "Shop is down",
      severity: "high",
      summary: `Uptime: Shop has been down since ${new Date(t0).toISOString()}. The last check said: HTTP 503`,
      products: ["uptime"],
      external: { source: "uptime", reference: expect.stringMatching(/^outage:\d+$/) },
    });
    expect(fake.incidents[0]!.evidence).toEqual([{ title: "Uptime check: Shop", url: `https://uptime.example.com/checks/${check.id}`, source: "uptime" }]);
    expect((await outages())[0]!.incident).toEqual({ state: "opened", key: "INC-1", url: "https://incidents.example.com/incidents/INC-1", error: null });

    // Still down: the same outage, no second incident.
    app.clock.now = t0 + 12 * MINUTE;
    await app.report(check.id, false, t0 + 2 * MINUTE);
    await app.report(check.id, true, t0 + 12 * MINUTE);
    await app.uptime.deliverIncidents();
    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0]!.notes).toEqual([`Uptime: Shop is up again since ${new Date(t0 + 12 * MINUTE).toISOString()}, after 12 minutes down.`]);
    // Sent once.
    await app.uptime.deliverIncidents();
    expect(fake.incidents[0]!.notes).toHaveLength(1);
  });

  it("keeps an outage's incident and end waiting while Incidents is unreachable, and sends both when it is back", async () => {
    const check = await app.addCheck("Api");
    const t0 = app.clock.now;
    fake.setDown(true);
    app.clock.now = t0 + 25 * MINUTE;
    await app.report(check.id, false, t0 + 20 * MINUTE);
    await app.report(check.id, false, t0 + 21 * MINUTE);
    await app.report(check.id, true, t0 + 25 * MINUTE);
    await app.uptime.deliverIncidents();
    const waiting = (await outages()).find((o) => o.check.name === "Api")!;
    expect(waiting.incident).toEqual({ state: "pending", key: null, url: null, error: "Incidents answered 503: Starting." });

    fake.setDown(false);
    await app.uptime.deliverIncidents();
    const opened = fake.incidents.find((i) => i.body.title === "Api is down")!;
    expect(opened.notes).toEqual([expect.stringContaining("Api is up again")]);
    expect((await outages()).find((o) => o.check.name === "Api")!.incident).toMatchObject({ state: "opened", error: null });
  });
});
