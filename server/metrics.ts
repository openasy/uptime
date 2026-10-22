// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface CheckGauge {
  name: string;
  state: "up" | "degraded" | "down" | "unknown";
  stale: boolean;
}

const label = (v: string) => v.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`));

export function renderMetrics(version: string, checks: CheckGauge[]): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="uptime",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_uptime_checks Checks defined.",
    "# TYPE openasy_uptime_checks gauge",
    `openasy_uptime_checks ${checks.length}`,
    "# HELP openasy_uptime_check_up 1 while a check is up or degraded, 0 while it is down. Absent while its state is unknown.",
    "# TYPE openasy_uptime_check_up gauge",
    ...checks.filter((c) => c.state !== "unknown").map((c) => `openasy_uptime_check_up{check="${label(c.name)}"} ${c.state === "down" ? 0 : 1}`),
    "# HELP openasy_uptime_check_stale 1 when no runner has reported for three intervals.",
    "# TYPE openasy_uptime_check_stale gauge",
    ...checks.map((c) => `openasy_uptime_check_stale{check="${label(c.name)}"} ${c.stale ? 1 : 0}`),
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
