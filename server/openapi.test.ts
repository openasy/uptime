import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, HOUR, INGEST_TOKEN, MINUTE, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "uptime-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir, start: Date.now() });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // uptime's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let check = "";
  const results = (...rs: Array<Record<string, unknown>>) => auth(INGEST_TOKEN, JSON.stringify({ results: rs }));

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
    await call("GET", "/uptime-runner.mjs");
    await call("GET", "/status");
  });

  it("checks: read, pause and every refusal", async () => {
    // Checks come from the endpoints file only (ADR 0052).
    check = (await app.addCheck("Shop", { public: true, group: "Customers", failuresToDown: 1 })).id;
    await call("GET", "/api/v1/checks", admin());
    await call("GET", "/api/v1/checks", admin(), "/api/v1/checks?group=Customers&state=unknown&limit=1");
    await call("GET", "/api/v1/checks", admin(), "/api/v1/checks?state=sleeping");
    await call("GET", "/api/v1/checks", {});
    await call("GET", "/api/v1/checks/{id}", admin(), `/api/v1/checks/${check}`);
    await call("GET", "/api/v1/checks/{id}", admin(), "/api/v1/checks/missing");
    await call("GET", "/api/v1/checks/{id}", {}, `/api/v1/checks/${check}`);
    await call("POST", "/api/v1/checks/{id}/pause", admin(), `/api/v1/checks/${check}/pause`);
    await call("POST", "/api/v1/checks/{id}/pause", admin(), "/api/v1/checks/missing/pause");
    await call("POST", "/api/v1/checks/{id}/pause", { method: "POST" }, `/api/v1/checks/${check}/pause`);
    await call("POST", "/api/v1/checks/{id}/resume", admin(), `/api/v1/checks/${check}/resume`);
    await call("POST", "/api/v1/checks/{id}/resume", admin(), "/api/v1/checks/missing/resume");
    await call("POST", "/api/v1/checks/{id}/resume", { method: "POST" }, `/api/v1/checks/${check}/resume`);
  });

  it("runner: fetch the checks, send results, and every refusal", async () => {
    const runnable = (await call("GET", "/api/v1/checks/runnable", auth(INGEST_TOKEN))).body as { checks: unknown[] };
    expect(runnable.checks).toHaveLength(1);
    await call("GET", "/api/v1/checks/runnable", auth("wrong"));
    await call("GET", "/api/v1/checks/runnable", {});
    const sent = await call(
      "POST",
      "/api/v1/results",
      results({ checkId: check, ok: true, latencyMs: 80, location: "test", time: new Date(Date.now() - 2 * MINUTE).toISOString() }),
    );
    expect(sent.body).toEqual({ accepted: 1 });
    await call("POST", "/api/v1/results", results({ checkId: check, ok: false, detail: "Answered 500", time: new Date(Date.now() - MINUTE).toISOString() }));
    await call("POST", "/api/v1/results", results({ checkId: "missing", ok: true }));
    await call("POST", "/api/v1/results", results({ checkId: check, ok: true, time: new Date(Date.now() + HOUR).toISOString() }));
    await call("POST", "/api/v1/results", auth(INGEST_TOKEN, "{nope"));
    await call("POST", "/api/v1/results", auth("wrong", "{}"));
    await call("POST", "/api/v1/results", { method: "POST" });
  });

  it("results, outages, summary and the public status", async () => {
    await call("GET", "/api/v1/checks/{id}/results", admin(), `/api/v1/checks/${check}/results`);
    await call("GET", "/api/v1/checks/{id}/results", admin(), `/api/v1/checks/${check}/results?limit=1`);
    await call("GET", "/api/v1/checks/{id}/results", admin(), `/api/v1/checks/${check}/results?cursor=junk`);
    await call("GET", "/api/v1/checks/{id}/results", admin(), "/api/v1/checks/missing/results");
    await call("GET", "/api/v1/checks/{id}/results", {}, `/api/v1/checks/${check}/results`);
    await call("GET", "/api/v1/outages", admin());
    await call("GET", "/api/v1/outages", admin(), `/api/v1/outages?check=${check}&open=false&limit=1`);
    await call("GET", "/api/v1/outages", admin(), "/api/v1/outages?open=maybe");
    await call("GET", "/api/v1/outages", admin(), "/api/v1/outages?check=missing");
    await call("GET", "/api/v1/outages", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    const { body } = await call("GET", "/api/v1/status/public");
    expect(body).toMatchObject({ overall: "outage", checks: [{ name: "Shop", state: "outage" }], incidents: [{ check: "Shop", ongoing: true }] });
  });

  it("deletes a check", async () => {
    await call("DELETE", "/api/v1/checks/{id}", admin(), `/api/v1/checks/${check}`);
    const legacy = app.addLegacy("Legacy");
    await call("DELETE", "/api/v1/checks/{id}", admin(), `/api/v1/checks/${legacy}`);
    await call("DELETE", "/api/v1/checks/{id}", admin(), `/api/v1/checks/${legacy}`);
    await call("DELETE", "/api/v1/checks/{id}", { method: "DELETE" }, "/api/v1/checks/x");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
