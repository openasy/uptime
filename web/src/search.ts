// What the search window (Cmd+K) finds in Uptime: checks by name, target, group or tag. They are read whole and
// filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Activity } from "lucide-react";
import type { Check } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const found = await call<{ checks: Check[] }>("/api/v1/checks?limit=500", { signal });
    return found.checks
      .filter((c) => [c.name, c.target, c.group ?? "", ...c.tags].some((x) => x.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((c): SearchResult => ({
        id: `check:${c.id}`,
        label: c.name,
        detail: `${c.target} · ${c.status.state}`,
        kind: t("search.check"),
        icon: Activity,
        severity: c.status.state === "down" ? "critical" : undefined,
        href: `/checks/${encodeURIComponent(c.id)}`,
      }));
  };
}
