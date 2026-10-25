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
  /** file: from the endpoints file (OPENASY_ENDPOINTS); changed there, not here. */
  source: "ui" | "file";
  /** The server it runs on, by its name in the hosts file. */
  server: string | null;
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
  /** The incident it opened in OpenAsy Incidents, when uptime is linked to it. */
  incident: { state: "pending" | "opened" | "failed"; key: string | null; url: string | null; error: string | null } | null;
}

/** What the overview draws (GET /api/v1/overview). Uptimes are percents, null without history. */
export interface Overview {
  uptime: { h24: number | null; d30: number | null };
  /** The last 90 days, oldest first: the mean over checks, the worst check and the outages that started. */
  days: Array<{ date: string; uptime: number | null; worst: number | null; outages: number }>;
  latency: { hours: string[]; ms: Array<number | null> };
  downtime: Array<{ id: string; name: string; seconds: number }>;
  outages: Outage[];
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
  endpointsFile: EndpointsFile | null;
}

/** The endpoints file (ADR 0052): a file that cannot be applied leaves the checks from its last good version. */
export interface EndpointsFile {
  path: string;
  appliedAt: string | null;
  entries: number;
  error: string | null;
  warnings: string[];
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
