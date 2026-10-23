import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileId, parseEndpoints, watchEndpoints } from "./endpoints.ts";
import { startApp } from "./test-app.ts";
import { criticalDays, parseWarnDays } from "./uptime.ts";

const FIXTURE = readFileSync(new URL("./testdata/endpoints.yaml", import.meta.url), "utf8");

describe("the endpoints file", () => {
  it("reads every kind of address, with the server each runs on", () => {
    const list = parseEndpoints(FIXTURE);
    expect(list.map((e) => `${e.name}: ${e.kind} ${e.host}:${e.port}`)).toEqual([
      "Website: http www.example.com:443",
      "API: http api.example.com:8443",
      "Mail: tls mail.example.com:465",
      "Database: tcp db.example.com:5432",
      "Resolver: dns example.com:null",
      "Old site: http old.example.com:80",
    ]);
    expect(list[0]).toMatchObject({ url: "https://www.example.com/", group: "Public", server: "web-1", public: true, everySeconds: 60, expect: { status: 200, text: "Welcome" } });
    expect(list[2]).toMatchObject({ url: "tls://mail.example.com:465", server: null, public: false, everySeconds: null, tags: ["mail"] });
    expect(parseEndpoints("")).toEqual([]);
    expect(parseEndpoints("endpoints: []")).toEqual([]);
  });

  it("says which entry and field to fix", () => {
    const one = (entry: string) => () => parseEndpoints(`endpoints:\n  - ${entry}`);
    expect(() => parseEndpoints("endpoints: [")).toThrow(/Not valid YAML/);
    expect(() => parseEndpoints("hosts: []")).toThrow(/one list, endpoints:/);
    expect(one("{ url: https://x.example.com }")).toThrow(/endpoints\[0\]\.name is required/);
    expect(one("{ name: A, url: ftp://x.example.com }")).toThrow(/endpoints\[0\] \(A\)\.url must start with https:\/\//);
    expect(one("{ name: A, url: 'https://u:p@x.example.com' }")).toThrow(/user name or password/);
    expect(one("{ name: A, url: 'tcp://db.example.com' }")).toThrow(/needs a port/);
    expect(one("{ name: A, url: 'dns://example.com/x' }")).toThrow(/a name only/);
    expect(one("{ name: A, url: https://x.example.com, every: 5s }")).toThrow(/30s to 24h/);
    expect(one("{ name: A, url: https://x.example.com, server: 'web 1' }")).toThrow(/server is a name from the hosts file/);
    expect(one("{ name: A, url: https://x.example.com, public: yes }")).toThrow(/true or false/);
    expect(one("{ name: A, url: https://x.example.com, port: 1 }")).toThrow(/unknown port/);
    expect(() => parseEndpoints("endpoints:\n  - { name: A, url: https://a.example.com }\n  - { name: a, url: https://b.example.com }")).toThrow(/A is in the file twice|a is in the file twice/);
  });

  it("is read again when it changes, and a bad version leaves the last good one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "endpoints-")), "endpoints.yaml");
    writeFileSync(path, FIXTURE);
    const applied: number[] = [];
    const w = watchEndpoints(path, (list) => (applied.push(list.length), []), { everyMs: 60_000 });
    try {
      expect(w.state).toMatchObject({ path, entries: 6, error: null });
      w.read();
      expect(applied).toEqual([6]); // unchanged: not applied again
      writeFileSync(path, "endpoints: [");
      utimesSync(path, new Date(), new Date(Date.now() + 1000));
      w.read();
      expect(w.state).toMatchObject({ entries: 6, error: expect.stringMatching(/Not valid YAML/) });
      writeFileSync(path, "endpoints:\n  - { name: A, url: https://a.example.com }\n");
      w.read();
      expect(w.state).toMatchObject({ entries: 1, error: null });
      expect(applied).toEqual([6, 1]);
    } finally {
      w.stop();
    }
    const missing = watchEndpoints(join(tmpdir(), "no-such-endpoints.yaml"), () => []);
    missing.stop();
    expect(missing.state.error).toMatch(/Cannot read .*ENOENT/);
  });

  it("gives each name the same id, safe in a URL", () => {
    expect(fileId("Website")).toBe(fileId("website"));
    expect(fileId("Website")).toMatch(/^file-[0-9a-f]{16}$/);
  });
});

describe("checks from the file", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp({ version: "0.1.0" });
  });
  afterAll(() => app.close());

  const checks = async () => (await app.json(await app.admin("/api/v1/checks?limit=100"))).checks as Array<Record<string, any>>;

  it("become checks, managed by the file, beside the ones added here", async () => {
    await app.addCheck("Added here");
    expect(app.uptime.syncFile(parseEndpoints(FIXTURE))).toEqual([]);
    const list = await checks();
    expect(list.map((c) => `${c.name}:${c.type}:${c.target}:${c.source}`).sort()).toEqual([
      "API:http:https://api.example.com:8443/health:file",
      "Added here:http:https://shop.example.com/health:ui",
      "Database:tcp:db.example.com:5432:file",
      "Mail:tls:mail.example.com:465:file",
      "Old site:http:http://old.example.com/:file",
      "Resolver:dns:example.com:file",
      "Website:http:https://www.example.com/:file",
    ]);
    expect(list.find((c) => c.name === "Website")).toMatchObject({ id: fileId("Website"), group: "Public", server: "web-1", public: true, intervalSeconds: 60, expect: { status: 200, text: "Welcome" } });
  });

  it("are changed in the file only, but can be paused", async () => {
    const id = fileId("Website");
    const refused = await app.admin(`/api/v1/checks/${id}`, { method: "PATCH", body: JSON.stringify({ public: false }) });
    expect(refused.status).toBe(409);
    expect((await app.json(refused)).detail).toMatch(/endpoints file/);
    expect((await app.admin(`/api/v1/checks/${id}`, { method: "DELETE" })).status).toBe(409);
    expect((await app.admin(`/api/v1/checks/${id}/pause`, { method: "POST" })).status).toBe(200);
    expect((await app.admin(`/api/v1/checks/${id}/resume`, { method: "POST" })).status).toBe(200);
  });

  it("follow the file: changed, removed, and a new kind starts again", async () => {
    const id = fileId("Website");
    await app.report(id, true);
    expect((await app.json(await app.admin(`/api/v1/checks/${id}/results`))).results).toHaveLength(1);
    app.uptime.syncFile(parseEndpoints("endpoints:\n  - { name: Website, url: https://www.example.com, group: Shop }\n  - { name: Mail, url: 'tcp://mail.example.com:25' }\n"));
    const list = await checks();
    expect(list.filter((c) => c.source === "file").map((c) => c.name).sort()).toEqual(["Mail", "Website"]);
    expect(list.find((c) => c.name === "Website")).toMatchObject({ group: "Shop", public: false, server: null, intervalSeconds: 300 });
    expect((await app.json(await app.admin(`/api/v1/checks/${id}/results`))).results).toHaveLength(1);
    expect(list.find((c) => c.name === "Mail")).toMatchObject({ type: "tcp", target: "mail.example.com:25" });
    expect(list.some((c) => c.name === "Added here" && c.source === "ui")).toBe(true);
  });

  it("refuse a whole file with a bad entry, and warn about a name taken here", async () => {
    const before = await checks();
    expect(() => app.uptime.syncFile(parseEndpoints("endpoints:\n  - { name: Website, url: https://www.example.com, expect: { minDays: 3 } }\n"))).toThrow(/Website: expect.minDays does not apply to a http check/);
    expect(await checks()).toEqual(before);
    expect(app.uptime.syncFile(parseEndpoints("endpoints:\n  - { name: Added here, url: https://x.example.com }\n"))).toEqual(["Added here: a check with this name was added in Uptime; rename one of them."]);
    expect((await checks()).filter((c) => c.source === "file")).toEqual([]);
  });
});

describe("certificate thresholds shared with Certificates", () => {
  it("fail a TLS check once the certificate is critical, unless the check says otherwise", async () => {
    expect(parseWarnDays(undefined)).toEqual([30, 14, 7, 1]);
    expect(parseWarnDays("1, 60,14")).toEqual([60, 14, 1]);
    expect(() => parseWarnDays("30,0")).toThrow(/OPENASY_CERT_WARN_DAYS/);
    expect(criticalDays([30, 14, 7, 1])).toBe(7);
    expect(criticalDays([5, 1])).toBe(5);

    const app = await startApp({ version: "0.1.0" });
    try {
      await app.post("/api/v1/checks", { name: "Shop TLS", type: "tls", target: "shop.example.com" });
      await app.post("/api/v1/checks", { name: "Bank TLS", type: "tls", target: "bank.example.com", expect: { minDays: 30 } });
      const runnable = (await app.json(await app.ingest("/api/v1/checks/runnable"))).checks as Array<{ name: string; expect: { minDays?: number } }>;
      expect(Object.fromEntries(runnable.map((c) => [c.name, c.expect.minDays]))).toEqual({ "Bank TLS": 30, "Shop TLS": 7 });
    } finally {
      await app.close();
    }
  });
});

describe("the summary", () => {
  it("says where the file stands, or null without one", async () => {
    const without = await startApp({ version: "0.1.0" });
    const state = { path: "/config/endpoints.yaml", appliedAt: null, entries: 0, error: "Not valid YAML: x", warnings: [] };
    const withFile = await startApp({ version: "0.1.0", endpointsFile: () => state });
    try {
      expect((await without.json(await without.admin("/api/v1/summary"))).endpointsFile).toBeNull();
      expect((await withFile.json(await withFile.admin("/api/v1/summary"))).endpointsFile).toEqual(state);
    } finally {
      await without.close();
      await withFile.close();
    }
  });
});
