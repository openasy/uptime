import type { PublicStatus } from "./uptime.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABEL: Record<string, string> = { operational: "Operational", degraded: "Degraded", outage: "Outage", unknown: "No recent data", maintenance: "Maintenance" };
const HEADLINE: Record<string, string> = { operational: "All systems operational", degraded: "Some systems are degraded", outage: "Some systems are down", unknown: "No recent data" };

const bar = (u: number | null) => (u === null ? "none" : u >= 99.9 ? "ok" : u >= 99 ? "warn" : "bad");

/**
 * The public status page: plain HTML from the public data and nothing else, no script, so it works behind any proxy
 * and cannot leak what the JSON does not hold (ADR 0047).
 */
export function renderStatusPage(data: PublicStatus, title = "Status"): string {
  const groups = new Map<string, PublicStatus["checks"]>();
  for (const c of data.checks) groups.set(c.group ?? "", [...(groups.get(c.group ?? "") ?? []), c]);
  const rows = [...groups]
    .map(
      ([group, checks]) => `<section>${group ? `<h2>${esc(group)}</h2>` : ""}${checks
        .map(
          (c) => `<div class="check"><div class="head"><span class="name">${esc(c.name)}</span><span class="state ${c.state}">${LABEL[c.state]}</span></div>
<div class="bars" role="img" aria-label="Uptime over the last 90 days">${c.days.map((d) => `<i class="${bar(d.uptime)}" title="${esc(d.date)}: ${d.uptime === null ? "no data" : `${d.uptime}%`}"></i>`).join("")}</div>
<div class="foot"><span>90 days ago</span><span>${c.uptime90 === null ? "no data yet" : `${c.uptime90}% uptime`}</span><span>Today</span></div></div>`,
        )
        .join("")}</section>`,
    )
    .join("");
  const incidents = data.incidents.length
    ? `<section><h2>Incidents</h2><ul>${data.incidents.map((i) => `<li><strong>${esc(i.check)}</strong> ${i.ongoing ? "is down since" : "was down from"} <time datetime="${esc(i.startedAt)}">${esc(i.startedAt.replace("T", " ").slice(0, 16))} UTC</time>${i.endedAt ? ` to <time datetime="${esc(i.endedAt)}">${esc(i.endedAt.replace("T", " ").slice(0, 16))} UTC</time>` : ""}</li>`).join("")}</ul></section>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--ok:#1a9d55;--warn:#d9a400;--bad:#d03a3a;--none:#c9c9c9}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#999;--line:#333;--none:#444}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1rem;margin:1.5rem 0 .5rem;color:var(--muted)}
.banner{padding:.75rem 1rem;border-radius:.5rem;border:1px solid var(--line);margin:1rem 0;font-weight:600}
.banner.operational{border-color:var(--ok)}.banner.degraded{border-color:var(--warn)}.banner.outage{border-color:var(--bad)}
.check{padding:.75rem 0;border-top:1px solid var(--line)}.head,.foot{display:flex;justify-content:space-between;gap:1rem}
.foot{font-size:.75rem;color:var(--muted)}.state.operational{color:var(--ok)}.state.degraded{color:var(--warn)}.state.outage{color:var(--bad)}.state.unknown,.state.maintenance{color:var(--muted)}
.bars{display:flex;gap:2px;height:1.75rem;margin:.5rem 0}.bars i{flex:1;border-radius:2px;background:var(--none)}.bars i.ok{background:var(--ok)}.bars i.warn{background:var(--warn)}.bars i.bad{background:var(--bad)}
ul{padding-left:1.25rem}.updated{color:var(--muted);font-size:.8rem}
</style></head><body><main><h1>${esc(title)}</h1>
<div class="banner ${data.overall}">${HEADLINE[data.overall]}</div>${rows}${incidents}
<p class="updated">Updated <time datetime="${esc(data.updatedAt)}">${esc(data.updatedAt.replace("T", " ").slice(0, 16))} UTC</time></p></main></body></html>`;
}
