// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type CheckType = "http" | "tcp" | "dns" | "tls";
export type State = "up" | "degraded" | "down" | "unknown";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Expect {
  status?: number;
  text?: string;
  recordType?: "A" | "AAAA" | "CNAME" | "TXT";
  record?: string;
  minDays?: number;
}

export interface Check {
  id: string;
  name: string;
  group: string | null;
  type: CheckType;
  target: string;
  expect: Expect;
  intervalSeconds: number;
  failuresToDown: number;
  public: boolean;
  paused: boolean;
  tags: string[];
  status: { state: State; stale: boolean; since: string | null; lastResultAt: string | null; failures: number };
  uptime: { h24: number | null; d7: number | null; d30: number | null; d90: number | null };
  latency: { p50: number; p95: number; p99: number; samples: number } | null;
  createdAt: string;
}

export interface Result {
  time: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
  location: string | null;
}

export interface Outage {
  id: number;
  check: { id: string; name: string };
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  detail: string | null;
}

export interface Summary {
  checks: number;
  up: number;
  degraded: number;
  down: number;
  unknown: number;
  stale: number;
  paused: number;
  openOutages: number;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
