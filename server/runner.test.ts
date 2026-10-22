import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daysUntil, main, runAll, runCheck, runDns, runHttp, runTcp, runTls } from "../runner/uptime-runner.mjs";
import { INGEST_TOKEN, startApp } from "./test-app.ts";

const listen = <T extends { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }>(server: T) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

let web: ReturnType<typeof createHttp>;
let webPort = 0;
let tcp: ReturnType<typeof createTcp>;
let tcpPort = 0;

beforeAll(async () => {
  web = createHttp((req, res) => {
    if (req.url === "/slow") return void setTimeout(() => res.end("late"), 2000).unref();
    if (req.url === "/down") return void res.writeHead(503).end("maintenance");
    if (req.url === "/moved") return void res.writeHead(302, { location: "/ok" }).end();
    res.writeHead(200, { "content-type": "text/plain" }).end("hello from the shop, version 42");
  });
  webPort = await listen(web);
  tcp = createTcp((socket) => socket.end());
  tcpPort = await listen(tcp);
});
afterAll(() => {
  web.closeAllConnections();
  web.close();
  tcp.close();
});

const http = (path: string, expect_: Record<string, unknown> = {}) => ({ id: "c", type: "http" as const, target: `http://127.0.0.1:${webPort}${path}`, expect: expect_ });

describe("http", () => {
  it("is ok below 400, follows redirects, and times how long it took", async () => {
    expect(await runHttp(http("/ok"))).toMatchObject({ ok: true, detail: "Answered 200", latencyMs: expect.any(Number) });
    expect(await runHttp(http("/moved"))).toMatchObject({ ok: true });
  });
  it("fails on an error status, a wrong status and missing text", async () => {
    expect(await runHttp(http("/down"))).toMatchObject({ ok: false, detail: "Answered 503" });
    expect(await runHttp(http("/ok", { status: 204 }))).toMatchObject({ ok: false, detail: "Answered 200, expected 204" });
    expect(await runHttp(http("/down", { status: 503 }))).toMatchObject({ ok: true });
    expect(await runHttp(http("/ok", { text: "version 42" }))).toMatchObject({ ok: true });
    expect(await runHttp(http("/ok", { text: "version 43" }))).toMatchObject({ ok: false, detail: expect.stringContaining("expected text") });
  });
  it("gives up after its timeout, and reports a refused connection", async () => {
    expect(await runHttp(http("/slow"), { timeoutMs: 200 })).toMatchObject({ ok: false, detail: "No answer within 0.2 s" });
    const closed = createTcp();
    const port = await listen(closed);
    closed.close();
    expect(await runHttp({ id: "c", type: "http", target: `http://127.0.0.1:${port}/` })).toMatchObject({ ok: false, detail: "ECONNREFUSED" });
  });
});

describe("tcp", () => {
  it("connects, or says why not", async () => {
    expect(await runTcp({ id: "c", type: "tcp", target: `127.0.0.1:${tcpPort}` })).toMatchObject({ ok: true, detail: "Connected" });
    expect(await runTcp({ id: "c", type: "tcp", target: "127.0.0.1:1" })).toMatchObject({ ok: false, detail: "ECONNREFUSED" });
  });
});

describe("dns", () => {
  const resolver = (answers: Record<string, unknown[]>) => ({
    resolve: async (host: string, type: string) => {
      const a = answers[`${host}/${type}`];
      if (!a) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return a;
    },
  });
  it("needs an answer, and the expected record among them", async () => {
    const r = resolver({ "www.example.com/A": ["192.0.2.1", "192.0.2.2"], "t.example.com/TXT": [["v=spf1 ", "-all"]] });
    expect(await runDns({ id: "c", type: "dns", target: "www.example.com" }, { resolver: r })).toMatchObject({ ok: true, detail: "A 192.0.2.1, 192.0.2.2" });
    expect(await runDns({ id: "c", type: "dns", target: "www.example.com", expect: { record: "192.0.2.2" } }, { resolver: r })).toMatchObject({ ok: true });
    expect(await runDns({ id: "c", type: "dns", target: "www.example.com", expect: { record: "192.0.2.9" } }, { resolver: r })).toMatchObject({ ok: false, detail: expect.stringContaining("expected 192.0.2.9") });
    expect(await runDns({ id: "c", type: "dns", target: "t.example.com", expect: { recordType: "TXT", record: "v=spf1 -all" } }, { resolver: r })).toMatchObject({ ok: true });
    expect(await runDns({ id: "c", type: "dns", target: "gone.example.com" }, { resolver: r })).toMatchObject({ ok: false, detail: "ENOTFOUND" });
  });
});

describe("tls", () => {
  it("counts the days to a certificate's end", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(daysUntil("Jan 31 00:00:00 2026 GMT", now)).toBe(30);
    expect(daysUntil("Dec 31 12:00:00 2025 GMT", now)).toBe(-1);
  });

  it("reports a certificate nobody trusts, with the days that are left", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uptime-tls-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "90", "-subj", "/CN=localhost"], { stdio: "ignore" });
    } catch {
      return; // no openssl here; the days and the refusal are covered above
    }
    const server = tls.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (s) => s.end());
    const port = await listen(server);
    try {
      expect(await runTls({ id: "c", type: "tls", target: `localhost:${port}` })).toMatchObject({ ok: false, detail: expect.stringMatching(/not trusted.*8\d days left/) });
    } finally {
      server.close();
    }
    expect(await runTls({ id: "c", type: "tls", target: "127.0.0.1:1" })).toMatchObject({ ok: false, detail: "ECONNREFUSED" });
  });
});

describe("running them all", () => {
  it("runs every check, whatever its type, and never throws", async () => {
    const checks = [http("/ok"), { id: "t", type: "tcp" as const, target: `127.0.0.1:${tcpPort}` }, { id: "x", type: "ping" as never, target: "x" }];
    const results = await runAll(checks, "test");
    expect(results.map((r) => [r.checkId, r.ok])).toEqual([["c", true], ["t", true], ["x", false]]);
    expect(results[0]).toMatchObject({ location: "test", time: expect.any(String) });
    expect((await runCheck(checks[2]!)).detail).toContain("Unknown check type");
  });

  it("fetches the checks from Uptime and posts what it saw", async () => {
    const app = await startApp({ version: "0.1.0", start: Date.now() });
    try {
      const up = await app.addCheck("Local web", { target: `http://127.0.0.1:${webPort}/ok`, failuresToDown: 1 });
      const down = await app.addCheck("Local down", { target: `http://127.0.0.1:${webPort}/down`, failuresToDown: 1 });
      const lines: string[] = [];
      await main({ UPTIME_URL: `${app.base}/`, UPTIME_INGEST_TOKEN: INGEST_TOKEN, UPTIME_LOCATION: "ci" }, { log: (m) => lines.push(m) });
      expect(lines).toEqual(["Ran 2 checks, 1 failed."]);
      expect((await app.json(await app.admin(`/api/v1/checks/${up.id}`))).status.state).toBe("up");
      expect((await app.json(await app.admin(`/api/v1/checks/${down.id}`))).status.state).toBe("down");
      expect((await app.json(await app.admin(`/api/v1/checks/${up.id}/results`))).results[0]).toMatchObject({ ok: true, location: "ci", detail: "Answered 200" });
      await expect(main({ UPTIME_URL: app.base, UPTIME_INGEST_TOKEN: "wrong" })).rejects.toThrow(/Could not fetch the checks: 401/);
      await expect(main({})).rejects.toThrow(/Set UPTIME_URL/);
    } finally {
      await app.close();
    }
  });
});
