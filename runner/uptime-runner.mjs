#!/usr/bin/env node
// OpenAsy Uptime runner. Fetches the checks from your Uptime, runs them from wherever this runs (a CI cron, a
// server, your laptop) and posts what it saw. It needs Node 20 or later and nothing else.
//
//   UPTIME_URL=https://uptime.example.com UPTIME_INGEST_TOKEN=... UPTIME_LOCATION=github node uptime-runner.mjs
//
// Exit status is 0 when it ran and reported, even when checks failed: a failing site is a result, not a runner error.
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

const TIMEOUT_MS = 10_000;
const BODY_LIMIT = 1024 * 1024;
const CONCURRENCY = 10;

/** The most telling word for why something failed: the first error code in the chain, else the deepest message. */
const why = (err) => {
  let last = err;
  for (let e = err; e; e = e.cause) {
    if (e.code) return e.code;
    last = e;
  }
  return last?.message ?? String(err);
};

/** Run one check. Never throws: a failure to connect is the answer. */
const result = (ok, started, detail) => ({ ok, latencyMs: Math.round(performance.now() - started), detail: String(detail).slice(0, 500) });

export async function runHttp(check, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const started = performance.now();
  try {
    const res = await fetchImpl(check.target, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "OpenAsy-Uptime-Runner" },
    });
    const expect = check.expect ?? {};
    const statusOk = expect.status !== undefined ? res.status === expect.status : res.status < 400;
    let text = "";
    if (expect.text !== undefined) {
      const reader = res.body?.getReader();
      const chunks = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size >= BODY_LIMIT) {
          await reader.cancel();
          break;
        }
      }
      text = Buffer.concat(chunks).toString("utf8");
    } else await res.body?.cancel();
    const textOk = expect.text === undefined || text.includes(expect.text);
    if (!statusOk) return result(false, started, `Answered ${res.status}${expect.status !== undefined ? `, expected ${expect.status}` : ""}`);
    if (!textOk) return result(false, started, `Answered ${res.status} but the page does not contain the expected text`);
    return result(true, started, `Answered ${res.status}`);
  } catch (err) {
    return result(false, started, err?.name === "TimeoutError" ? `No answer within ${timeoutMs / 1000} s` : why(err));
  }
}

export function runTcp(check, { timeoutMs = TIMEOUT_MS } = {}) {
  const started = performance.now();
  const at = check.target.lastIndexOf(":");
  const host = check.target.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(check.target.slice(at + 1));
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, detail) => {
      socket.destroy();
      resolve(result(ok, started, detail));
    };
    socket.setTimeout(timeoutMs, () => done(false, `No connection within ${timeoutMs / 1000} s`));
    socket.once("connect", () => done(true, "Connected"));
    socket.once("error", (err) => done(false, err.code ?? err.message));
  });
}

export async function runDns(check, { resolver = dns, timeoutMs = TIMEOUT_MS } = {}) {
  const started = performance.now();
  const type = check.expect?.recordType ?? "A";
  try {
    const answer = await Promise.race([
      resolver.resolve(check.target, type),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`No answer within ${timeoutMs / 1000} s`)), timeoutMs).unref()),
    ]);
    const values = answer.map((a) => (Array.isArray(a) ? a.join("") : typeof a === "object" ? JSON.stringify(a) : String(a)));
    if (!values.length) return result(false, started, `No ${type} record`);
    if (check.expect?.record !== undefined && !values.includes(check.expect.record))
      return result(false, started, `${type} is ${values.join(", ").slice(0, 200)}, expected ${check.expect.record}`);
    return result(true, started, `${type} ${values.join(", ").slice(0, 200)}`);
  } catch (err) {
    return result(false, started, err?.code ?? err?.message ?? err);
  }
}

/** Whole days from now to a certificate's end, rounded down; negative once it has expired. */
export const daysUntil = (validTo, now = Date.now()) => Math.floor((Date.parse(validTo) - now) / 86_400_000);

export function runTls(check, { timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const started = performance.now();
  const [host, port = "443"] = check.target.split(":");
  // Uptime sends the days with every TLS check (OPENASY_CERT_WARN_DAYS); 7 is its default critical threshold.
  const minDays = check.expect?.minDays ?? 7;
  return new Promise((resolve) => {
    // The certificate is read even when it is not trusted, so the answer can say which problem it is. SNI names a
    // host, never an address: Node refuses an IP as the server name.
    const socket = tls.connect({ host, port: Number(port), servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs });
    const done = (ok, detail) => {
      socket.destroy();
      resolve(result(ok, started, detail));
    };
    socket.once("timeout", () => done(false, `No handshake within ${timeoutMs / 1000} s`));
    socket.once("error", (err) => done(false, err.code ?? err.message));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return done(false, "The server sent no certificate");
      const days = daysUntil(cert.valid_to, now());
      if (!socket.authorized) return done(false, `Certificate not trusted (${socket.authorizationError}), ${days} days left`);
      if (days < minDays) return done(false, `Certificate ends in ${days} days, less than the ${minDays} required`);
      done(true, `Certificate ends in ${days} days`);
    });
  });
}

const RUNNERS = { http: runHttp, tcp: runTcp, dns: runDns, tls: runTls };

export async function runCheck(check, options = {}) {
  const run = RUNNERS[check.type];
  if (!run) return result(false, performance.now(), `Unknown check type ${check.type}`);
  return run(check, options);
}

/** Runs checks with a few at a time, so a thousand slow ones do not open a thousand sockets. */
export async function runAll(checks, location, options = {}) {
  const results = Array.from({ length: checks.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, checks.length) }, async () => {
      while (next < checks.length) {
        const i = next++;
        const check = checks[i];
        results[i] = { checkId: check.id, time: new Date().toISOString(), ...(await runCheck(check, options)), ...(location && { location }) };
      }
    }),
  );
  return results;
}

export async function main(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const base = env.UPTIME_URL?.replace(/\/$/, "");
  const token = env.UPTIME_INGEST_TOKEN;
  if (!base || !token) throw new Error("Set UPTIME_URL and UPTIME_INGEST_TOKEN.");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const list = await fetchImpl(`${base}/api/v1/checks/runnable`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!list.ok) throw new Error(`Could not fetch the checks: ${list.status} ${(await list.text()).slice(0, 200)}`);
  const { checks } = await list.json();
  if (!checks.length) return log("No checks to run.");
  const results = await runAll(checks, env.UPTIME_LOCATION);
  // Batches of 500 are the most the server takes at once.
  for (let i = 0; i < results.length; i += 500) {
    const post = await fetchImpl(`${base}/api/v1/results`, {
      method: "POST",
      headers,
      body: JSON.stringify({ results: results.slice(i, i + 500) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!post.ok) throw new Error(`Could not send the results: ${post.status} ${(await post.text()).slice(0, 200)}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`Ran ${results.length} checks, ${failed} failed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
