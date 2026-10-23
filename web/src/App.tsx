import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  FacetFilter,
  FilterBar,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Switch,
  TextField,
  TimeSeriesChart,
  usePath,
  type Column,
  type ProductId,
  useThemePreference,
  useAgo,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth, useInstallBrand } from "@openasy/auth/react";
import { Activity, ExternalLink, KeyRound, LogIn, LogOut, Plus, Settings2, Trash2, TriangleAlert, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Check,
  type CheckType,
  type Expect,
  type Outage,
  type ProductLink,
  type Result,
  type State,
  type Summary,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";

const PAGES = ["outages", "setup", "account", "members", "signin", "tokens"] as const;
type Route = { page: "checks" | (typeof PAGES)[number] } | { page: "check"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["checks", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "checks" && id) return { page: "check", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "checks" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}
const pct = (v: number | null) => (v === null ? "–" : `${v >= 99.995 ? "100" : v.toFixed(2)}%`);
const every = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** What a person sees: a check nobody has heard from for three intervals is stale, whatever it was before. */
type Shown = State | "stale" | "paused";
const shownOf = (c: Check): Shown => (c.paused ? "paused" : c.status.stale ? "stale" : c.status.state);
const SHOWN_ORDER: Shown[] = ["down", "degraded", "stale", "unknown", "paused", "up"];
const SHOWN_LABEL: Record<Shown, string> = { down: "Down", degraded: "Degraded", stale: "Stale", unknown: "Waiting", paused: "Paused", up: "Up" };
const SHOWN_TONE: Record<Shown, "danger" | "warning" | "neutral" | "info" | "success"> = {
  down: "danger",
  degraded: "warning",
  stale: "info",
  unknown: "neutral",
  paused: "neutral",
  up: "success",
};

function StateBadge({ check }: { check: Check }) {
  const s = shownOf(check);
  return <StatusBadge tone={SHOWN_TONE[s]}>{SHOWN_LABEL[s]}</StatusBadge>;
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

const TYPES = (t: T): Array<{ value: CheckType; label: string }> => [
  { value: "http", label: t("types.httpAWebAddressAnswers") },
  { value: "tcp", label: t("types.tcpAPortAcceptsConnections") },
  { value: "dns", label: t("types.dnsANameResolves") },
  { value: "tls", label: t("types.tlsACertificateIsValid") },
];
const TARGET_HINT = (t: T): Record<CheckType, string> => ({
  http: "A web address, such as https://shop.example.com/health.",
  tcp: "host:port, such as db.example.com:5432.",
  dns: t("targetHint.aHostNameSuchAs"),
  tls: t("targetHint.aHostNameWithPort"),
});

/** What the check expects, in words, for the list. */
function expectation(c: Pick<Check, "type" | "expect">): string {
  const e = c.expect;
  if (c.type === "http")
    return [e.status !== undefined ? `status ${e.status}` : "status below 400", e.text !== undefined && `text "${e.text}"`].filter(Boolean).join(", ");
  if (c.type === "dns") return e.recordType ? `${e.recordType}${e.record ? ` ${e.record}` : ""}` : "any answer";
  if (c.type === "tls") return e.minDays === undefined ? "certificate not yet critical" : `valid for ${e.minDays}+ days`;
  return "connects";
}

// ---------------------------------------------------------------- Checks

function CheckDialog({ call, check, onClose, onSaved }: { call: Call; check?: Check; onClose: () => void; onSaved: (c: Check) => void }) {
  const t = useT();
  const [name, setName] = useState(check?.name ?? "");
  const [group, setGroup] = useState(check?.group ?? "");
  const [type, setType] = useState<CheckType>(check?.type ?? "http");
  const [target, setTarget] = useState(check?.target ?? "");
  const [status, setStatus] = useState(check?.expect.status !== undefined ? String(check.expect.status) : "");
  const [text, setText] = useState(check?.expect.text ?? "");
  const [recordType, setRecordType] = useState<string>(check?.expect.recordType ?? "");
  const [record, setRecord] = useState(check?.expect.record ?? "");
  const [minDays, setMinDays] = useState(check?.expect.minDays !== undefined ? String(check.expect.minDays) : "");
  const [interval, setIntervalSeconds] = useState(String(check?.intervalSeconds ?? 300));
  const [failures, setFailures] = useState(String(check?.failuresToDown ?? 2));
  const [isPublic, setPublic] = useState(check?.public ?? false);
  const [error, setError] = useState<string>();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const expect: Expect = {};
    if (type === "http") {
      if (status) expect.status = Number(status);
      if (text) expect.text = text;
    }
    if (type === "dns" && recordType) {
      expect.recordType = recordType as Expect["recordType"];
      if (record) expect.record = record;
    }
    if (type === "tls" && minDays) expect.minDays = Number(minDays);
    const fields = {
      name,
      ...(group.trim() && { group: group.trim() }),
      target,
      expect,
      intervalSeconds: Number(interval),
      failuresToDown: Number(failures),
      public: isPublic,
    };
    try {
      const saved = check
        ? await call<Check>(`/api/v1/checks/${check.id}`, { method: "PATCH", body: JSON.stringify(fields) })
        : await call<Check>("/api/v1/checks", { method: "POST", body: JSON.stringify({ type, ...fields }) });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={check ? t("checkDialog.change", { name: check.name }) : t("checkDialog.addACheck")}
      description={t("checkDialog.aRunnerRunsItFrom")}
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("checkDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !target.trim()}>
            {check ? t("checkDialog.save") : t("checkDialog.addCheck")}
          </Button>
        </>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <TextField label={t("checkDialog.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label={t("checkDialog.group")} value={group} onChange={(e) => setGroup(e.target.value)} hint={t("checkDialog.optionalSuchAsShop")} />
      </div>
      {!check && <SelectField label={t("checkDialog.type")} value={type} onChange={(e) => setType(e.target.value as CheckType)} options={TYPES(t)} />}
      <TextField label={t("checkDialog.target")} value={target} onChange={(e) => setTarget(e.target.value)} hint={TARGET_HINT(t)[type]} mono />
      {type === "http" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <TextField
            label={t("checkDialog.status")}
            inputMode="numeric"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            hint={t("checkDialog.emptyAnythingBelow400")}
          />
          <TextField label={t("checkDialog.textInThePage")} value={text} onChange={(e) => setText(e.target.value)} hint={t("checkDialog.optional")} />
        </div>
      )}
      {type === "dns" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <SelectField
            label={t("checkDialog.record")}
            value={recordType}
            onChange={(e) => setRecordType(e.target.value)}
            options={[
              { value: "", label: t("checkDialog.anyAnswer") },
              { value: "A", label: "A" },
              { value: "AAAA", label: "AAAA" },
              { value: "CNAME", label: "CNAME" },
              { value: "TXT", label: "TXT" },
            ]}
          />
          {recordType && (
            <TextField
              label={t("checkDialog.amongTheAnswers")}
              value={record}
              onChange={(e) => setRecord(e.target.value)}
              hint={t("checkDialog.optionalSuchAs2030")}
            />
          )}
        </div>
      )}
      {type === "tls" && (
        <TextField
          label={t("checkDialog.daysTheCertificateMustHave")}
          inputMode="numeric"
          value={minDays}
          onChange={(e) => setMinDays(e.target.value)}
          hint={t("checkDialog.empty14")}
        />
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <TextField
          label={t("checkDialog.everySeconds")}
          inputMode="numeric"
          value={interval}
          onChange={(e) => setIntervalSeconds(e.target.value)}
          hint={t("checkDialog.staleAfterThreeOfThese")}
        />
        <TextField
          label={t("checkDialog.downAfterThisManyFailures")}
          inputMode="numeric"
          value={failures}
          onChange={(e) => setFailures(e.target.value)}
          hint={t("checkDialog.oneFailureIsDegraded")}
          error={error}
        />
      </div>
      <Switch
        checked={isPublic}
        onCheckedChange={setPublic}
        label={t("checkDialog.showOnThePublicStatus")}
        description={t("checkDialog.byNameGroupAndState")}
      />
    </Dialog>
  );
}

function ChecksPage({ call, summary, reload }: { call: Call; summary?: Summary; reload: () => void }) {
  const ago = useAgo();
  const msg = useT();
  const { can } = useAuth();
  const [rows, setRows] = useState<Check[]>();
  const [states, setStates] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(
    () =>
      void call<{ checks: Check[] }>("/api/v1/checks?limit=500").then(
        (r) => setRows(r.checks),
        () => setRows([]),
      ),
    [call],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const all = rows ?? [];
  const groupNames = [...new Set(all.map((c) => c.group ?? ""))].sort();
  const shown = all
    .filter((c) => (!states.length || states.includes(shownOf(c))) && (!groups.length || groups.includes(c.group ?? "")))
    .sort((a, b) => SHOWN_ORDER.indexOf(shownOf(a)) - SHOWN_ORDER.indexOf(shownOf(b)) || a.name.localeCompare(b.name));
  const columns: Column<Check>[] = [
    { id: "state", header: msg("checksPage.state"), width: "110px", sortValue: (c) => SHOWN_ORDER.indexOf(shownOf(c)), cell: (c) => <StateBadge check={c} /> },
    {
      id: "name",
      header: msg("checksPage.check"),
      width: "30%",
      sortValue: (c) => c.name,
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-1.5">
            <a href={`/checks/${c.id}`} className="font-medium">
              {c.name}
            </a>
            {c.source === "file" && <Badge tone="neutral">{msg("checksPage.fromFile")}</Badge>}
            {c.server && <Badge tone="neutral">{msg("checksPage.on", { server: c.server })}</Badge>}
          </span>
          <span className="uptime-clamp font-mono text-xs text-fg-muted" title={c.target}>
            {c.target}
          </span>
        </span>
      ),
    },
    { id: "type", header: msg("checksPage.type"), cell: (c) => <Badge>{c.type.toUpperCase()}</Badge> },
    { id: "group", header: msg("checksPage.group"), cell: (c) => <span className="text-xs">{c.group ?? ""}</span> },
    {
      id: "since",
      header: msg("checksPage.since"),
      sortValue: (c) => c.status.since ?? "",
      cell: (c) => <span className="whitespace-nowrap text-xs">{c.status.since ? ago(c.status.since) : "–"}</span>,
    },
    { id: "h24", header: msg("checksPage.n24H"), align: "right", sortValue: (c) => c.uptime.h24 ?? -1, cell: (c) => pct(c.uptime.h24) },
    { id: "d30", header: msg("checksPage.n30Days"), align: "right", sortValue: (c) => c.uptime.d30 ?? -1, cell: (c) => pct(c.uptime.d30) },
    {
      id: "last",
      header: msg("checksPage.lastResult"),
      sortValue: (c) => c.status.lastResultAt ?? "",
      cell: (c) => <span className="whitespace-nowrap text-xs">{ago(c.status.lastResultAt)}</span>,
    },
  ];
  const s = summary;
  return (
    <>
      <PageHeader
        title={msg("checksPage.checks")}
        description={s ? `${msg("plurals.check", { count: s.checks })}${s.paused ? `, ${s.paused} paused` : ""}` : undefined}
        actions={
          <span className="flex items-center gap-2">
            <Button icon={<ExternalLink />} onClick={() => window.open("/status", "_blank", "noopener")}>
              {msg("checksPage.statusPage")}
            </Button>
            {can("admin") && (
              <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                {msg("checksPage.addCheck")}
              </Button>
            )}
          </span>
        }
      />
      {s && (
        <KpiGrid minWidth={140}>
          <KpiCard label={msg("checksPage.down")} value={s.down} tone={s.down ? "danger" : "success"} />
          <KpiCard label={msg("checksPage.degraded")} value={s.degraded} tone={s.degraded ? "warning" : "success"} />
          <KpiCard label={msg("checksPage.stale")} value={s.stale} tone={s.stale ? "info" : "success"} />
          <KpiCard label={msg("checksPage.up")} value={s.up} tone="success" />
          <KpiCard label={msg("checksPage.openOutages")} value={s.openOutages} tone={s.openOutages ? "danger" : "success"} href="/outages" />
        </KpiGrid>
      )}
      {s?.endpointsFile?.error && (
        <Callout tone="danger" title={msg("checksPage.theEndpointsFileIsNot")}>
          {msg("checksPage.theChecksFromItsLast", { error: s.endpointsFile.error, path: s.endpointsFile.path })}
        </Callout>
      )}
      {!!s?.endpointsFile?.warnings.length && (
        <Callout tone="warning" title={msg("checksPage.theEndpointsFileHasSomething")}>
          {s.endpointsFile.warnings.join(" ")}
        </Callout>
      )}
      {s && s.stale > 0 && (
        <p className="m-0 text-sm text-fg-muted">
          {msg("checksPage.aStaleCheckHasHad")} <a href="/setup">{msg("checksPage.setup")}</a>.
        </p>
      )}
      <FilterBar onClear={() => (setStates([]), setGroups([]))}>
        <FacetFilter
          label={msg("checksPage.state")}
          selected={states}
          onChange={setStates}
          options={SHOWN_ORDER.map((k) => ({ value: k, label: SHOWN_LABEL[k], count: all.filter((c) => shownOf(c) === k).length }))}
        />
        {groupNames.length > 1 && (
          <FacetFilter
            label={msg("checksPage.group")}
            selected={groups}
            onChange={setGroups}
            options={groupNames.map((g) => ({ value: g, label: g || msg("checksPage.noGroup"), count: all.filter((c) => (c.group ?? "") === g).length }))}
          />
        )}
      </FilterBar>
      <Panel flush>
        <DataTable
          label={msg("checksPage.checks")}
          columns={columns}
          rows={shown}
          loading={!rows}
          getRowId={(c) => c.id}
          minWidth={960}
          empty={
            <EmptyState title={msg("checksPage.noChecksYet")}>
              {can("admin") ? msg("checksPage.addTheFirstCheckThen") : msg("checksPage.anAdminAddsTheChecks")}
            </EmptyState>
          }
        />
      </Panel>
      {adding && (
        <CheckDialog
          call={call}
          onClose={() => setAdding(false)}
          onSaved={(c) => {
            setAdding(false);
            reload();
            navigate(`/checks/${c.id}`);
          }}
        />
      )}
    </>
  );
}

function CheckPage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const ago = useAgo();
  const msg = useT();
  const { can } = useAuth();
  const [check, setCheck] = useState<Check | null>();
  const [results, setResults] = useState<Result[]>();
  const [outages, setOutages] = useState<Outage[]>();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    call<Check>(`/api/v1/checks/${id}`).then(setCheck, () => setCheck(null));
    call<{ results: Result[] }>(`/api/v1/checks/${id}/results?limit=200`).then(
      (r) => setResults(r.results),
      () => setResults([]),
    );
    call<{ outages: Outage[] }>(`/api/v1/outages?check=${id}&limit=50`).then(
      (r) => setOutages(r.outages),
      () => setOutages([]),
    );
  }, [call, id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = (path: string, init: RequestInit, then: () => void) => call(path, init).then(then, (err: Error) => setError(err.message));

  if (check === null)
    return (
      <EmptyState title={msg("checkPage.checkNotFound")}>
        {msg("checkPage.itMayHaveBeenDeleted")} <a href="/checks">{msg("checkPage.backToChecks")}</a>.
      </EmptyState>
    );

  const timed = (results ?? [])
    .filter((r) => r.ok && r.latencyMs !== null)
    .slice()
    .reverse();
  const resultColumns: Column<Result>[] = [
    { id: "time", header: msg("checkPage.when"), sortValue: (r) => r.time, cell: (r) => <span className="whitespace-nowrap text-xs">{ago(r.time)}</span> },
    {
      id: "ok",
      header: msg("checkPage.result"),
      cell: (r) => <StatusBadge tone={r.ok ? "success" : "danger"}>{r.ok ? msg("checkPage.passed") : msg("checkPage.failed")}</StatusBadge>,
    },
    { id: "latency", header: msg("checkPage.took"), align: "right", cell: (r) => (r.latencyMs === null ? "–" : `${r.latencyMs} ms`) },
    { id: "location", header: msg("checkPage.from"), cell: (r) => <span className="text-xs">{r.location ?? ""}</span> },
    {
      id: "detail",
      header: msg("checkPage.detail"),
      width: "40%",
      cell: (r) => (
        <span className="uptime-clamp text-xs text-fg-muted" title={r.detail ?? undefined}>
          {r.detail ?? ""}
        </span>
      ),
    },
  ];
  const outageColumns: Column<Outage>[] = [
    {
      id: "start",
      header: msg("checkPage.started"),
      sortValue: (o) => o.startedAt,
      cell: (o) => <span className="whitespace-nowrap text-xs">{new Date(o.startedAt).toLocaleString()}</span>,
    },
    {
      id: "length",
      header: msg("checkPage.lasted"),
      align: "right",
      cell: (o) =>
        o.endedAt ? (
          duration(o.durationSeconds)
        ) : (
          <StatusBadge tone="danger">{msg("checkPage.ongoing", { duration: duration(o.durationSeconds) })}</StatusBadge>
        ),
    },
    {
      id: "detail",
      header: msg("checkPage.why"),
      width: "50%",
      cell: (o) => (
        <span className="uptime-clamp text-xs text-fg-muted" title={o.detail ?? undefined}>
          {o.detail ?? ""}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={check?.name ?? msg("checkPage.check")}
        description={
          check
            ? msg("checkPage.everyDownAfter", {
                value: check.type.toUpperCase(),
                target: check.target,
                value2: check.server ? ` on ${check.server}` : "",
                expectation: expectation(check),
                every: every(check.intervalSeconds),
                plural: msg("plurals.failure", { count: check.failuresToDown }),
                value3: check.public ? " · on the status page" : "",
              })
            : undefined
        }
        actions={
          check && (
            <span className="flex items-center gap-2">
              <StateBadge check={check} />
              {can("editor") && (
                <Button onClick={() => void act(`/api/v1/checks/${id}/${check.paused ? "resume" : "pause"}`, { method: "POST" }, () => (load(), reload()))}>
                  {check.paused ? msg("checkPage.resume") : msg("checkPage.pause")}
                </Button>
              )}
              {can("admin") && check.source === "ui" && <Button onClick={() => setEditing(true)}>{msg("checkPage.change")}</Button>}
            </span>
          )
        }
      />
      {check && (
        <KpiGrid minWidth={130}>
          <KpiCard label={msg("checkPage.n24Hours")} value={pct(check.uptime.h24)} />
          <KpiCard label={msg("checkPage.n7Days")} value={pct(check.uptime.d7)} />
          <KpiCard label={msg("checkPage.n30Days")} value={pct(check.uptime.d30)} />
          <KpiCard label={msg("checkPage.n90Days")} value={pct(check.uptime.d90)} />
          <KpiCard
            label={msg("checkPage.p9524H")}
            value={check.latency ? `${check.latency.p95} ms` : "–"}
            footer={check.latency ? msg("checkPage.p50MsP99Ms", { p50: check.latency.p50, p99: check.latency.p99 }) : undefined}
          />
        </KpiGrid>
      )}
      {check?.source === "file" && <p className="m-0 text-sm text-fg-muted">{msg("checkPage.fromTheEndpointsFileChange")}</p>}
      {check?.paused && <p className="m-0 text-sm text-fg-muted">{msg("checkPage.pausedRunnersSkipItAnd")}</p>}
      {check?.status.stale && !check.paused && <p className="m-0 text-sm text-fg-muted">{msg("checkPage.noResultForThreeIntervals")}</p>}
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {timed.length > 1 && (
        <Panel title={msg("checkPage.responseTime")}>
          <TimeSeriesChart
            label={msg("checkPage.responseTimeOf", { value: check?.name ?? "the check" })}
            series={[{ id: "latency", name: "Response time", data: timed.map((r) => r.latencyMs ?? 0) }]}
            labels={timed.map((r) => new Date(r.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
            format={(v) => `${Math.round(v)} ms`}
            area
            height={160}
          />
        </Panel>
      )}
      <Panel title={msg("checkPage.outages")} flush>
        <DataTable
          label={msg("checkPage.outages")}
          columns={outageColumns}
          rows={outages ?? []}
          loading={!outages}
          getRowId={(o) => String(o.id)}
          minWidth={560}
          pageSize={10}
          empty={<EmptyState title={msg("checkPage.noOutages")}>{msg("checkPage.itHasNotBeenDown")}</EmptyState>}
        />
      </Panel>
      <Panel title={msg("checkPage.results")} flush>
        <DataTable
          label={msg("checkPage.results")}
          columns={resultColumns}
          rows={results ?? []}
          loading={!results}
          getRowId={(r) => `${r.time}-${r.location ?? ""}`}
          minWidth={760}
          pageSize={20}
          empty={
            <EmptyState title={msg("checkPage.noResultsYet")}>
              {msg("checkPage.noRunnerHasRunIt")} <a href="/setup">{msg("checkPage.setup")}</a>.
            </EmptyState>
          }
        />
      </Panel>
      {can("admin") && check?.source === "ui" && (
        <div>
          <Button icon={<Trash2 />} onClick={() => setRemoving(true)}>
            {msg("checkPage.deleteCheck")}
          </Button>
        </div>
      )}
      {editing && check && (
        <CheckDialog
          call={call}
          check={check}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
            reload();
          }}
        />
      )}
      {check && (
        <Dialog
          open={removing}
          onOpenChange={setRemoving}
          title={msg("checkPage.delete", { name: check.name })}
          description={msg("checkPage.itsResultsAndOutagesAre")}
          footer={
            <>
              <Button type="button" onClick={() => setRemoving(false)}>
                {msg("checkPage.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void act(`/api/v1/checks/${id}`, { method: "DELETE" }, () => (reload(), navigate("/checks")))}
              >
                {msg("checkPage.delete2")}
              </Button>
            </>
          }
        >
          <></>
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Outages

function OutagesPage({ call }: { call: Call }) {
  const t = useT();
  const [tab, setTab] = useState<"open" | "all">("open");
  const [rows, setRows] = useState<Outage[]>();
  useEffect(() => {
    setRows(undefined);
    void call<{ outages: Outage[] }>(`/api/v1/outages?limit=500${tab === "open" ? "&open=true" : ""}`).then(
      (r) => setRows(r.outages),
      () => setRows([]),
    );
  }, [call, tab]);
  const columns: Column<Outage>[] = [
    {
      id: "check",
      header: t("outagesPage.check"),
      width: "26%",
      cell: (o) => (
        <a href={`/checks/${o.check.id}`} className="font-medium">
          {o.check.name}
        </a>
      ),
    },
    {
      id: "start",
      header: t("outagesPage.started"),
      sortValue: (o) => o.startedAt,
      cell: (o) => <span className="whitespace-nowrap text-xs">{new Date(o.startedAt).toLocaleString()}</span>,
    },
    {
      id: "length",
      header: t("outagesPage.lasted"),
      align: "right",
      sortValue: (o) => o.durationSeconds,
      cell: (o) =>
        o.endedAt ? (
          duration(o.durationSeconds)
        ) : (
          <StatusBadge tone="danger">{t("outagesPage.ongoing", { duration: duration(o.durationSeconds) })}</StatusBadge>
        ),
    },
    {
      id: "detail",
      header: t("outagesPage.why"),
      width: "40%",
      cell: (o) => (
        <span className="uptime-clamp text-xs text-fg-muted" title={o.detail ?? undefined}>
          {o.detail ?? ""}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("outagesPage.outages")} description={t("outagesPage.anOutageStartsWhenA")} />
      <SegmentedControl
        label={t("outagesPage.outages")}
        value={tab}
        onChange={setTab}
        options={[
          { value: "open", label: t("outagesPage.ongoing2") },
          { value: "all", label: t("outagesPage.all") },
        ]}
      />
      <Panel flush>
        <DataTable
          label={t("outagesPage.outages")}
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(o) => String(o.id)}
          minWidth={760}
          pageSize={50}
          empty={
            <EmptyState title={tab === "open" ? t("outagesPage.nothingIsDown") : t("outagesPage.noOutages")}>
              {tab === "open" ? t("outagesPage.everyCheckThatHasReported") : t("outagesPage.noCheckHasBeenDown")}
            </EmptyState>
          }
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Setup

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.addChecksHereThenRun")} />
      <Panel title={t("setupPage.githubActionsEvery5Minutes")} description={t("setupPage.theRunnerIsOneScript")}>
        <Code>{`on:
  schedule: [{ cron: "*/5 * * * *" }]
jobs:
  uptime:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: curl -sf ${origin}/uptime-runner.mjs -o uptime-runner.mjs && node uptime-runner.mjs
        env:
          UPTIME_URL: ${origin}
          UPTIME_INGEST_TOKEN: \${{ secrets.UPTIME_INGEST_TOKEN }}
          UPTIME_LOCATION: github`}</Code>
      </Panel>
      <Panel title={t("setupPage.anyMachine")} description={t("setupPage.fromCronOrASystemd")}>
        <Code>{`curl -sf ${origin}/uptime-runner.mjs -o uptime-runner.mjs
*/5 * * * *  UPTIME_URL=${origin} UPTIME_INGEST_TOKEN=... UPTIME_LOCATION=office node uptime-runner.mjs`}</Code>
      </Panel>
      <Panel title={t("setupPage.whatToKnow")}>
        <ul className="uptime-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>{t("setupPage.oneFailureMakesACheck")}</li>
          <li>{t("setupPage.aCheckWithNoResult")}</li>
          <li>
            {t("setupPage.thePublicStatusPageIs")} <a href={`${origin}/status`}>{origin}/status</a>
            {t("setupPage.plainHtmlWithNoScript")}
          </li>
          <li>/metrics has each check's state and staleness, to alert on in your Prometheus.</li>
        </ul>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdminOfThis")}</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: [
      "Members",
      "Who can sign in to this uptime, and with which role. Viewers see everything; editors also pause and resume checks; admins also add, change and delete checks, and manage members and tokens.",
    ],
    signin: [
      "Sign-in",
      "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role.",
    ],
    tokens: ["API tokens", "For scripts and runners. Each token has one role and an expiry; the secret is shown once."],
  } as const;
  return (
    <>
      <PageHeader
        title={titles[page][0]}
        description={titles[page][1]}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const { me, can } = useAuth();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "uptime" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "checks", label: msg("product.checks"), icon: Activity, count: summary?.checks },
    { id: "outages", label: msg("product.outages"), icon: TriangleAlert, count: summary?.openOutages || undefined },
  ];
  const footerNav = [
    { id: "setup", label: msg("product.setup"), icon: Settings2 },
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const active = route.page === "check" ? "checks" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="uptime"
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {route.page === "checks" ? (
        <ChecksPage call={call} summary={summary} reload={reload} />
      ) : route.page === "check" ? (
        <CheckPage key={route.id} call={call} id={route.id} reload={reload} />
      ) : route.page === "outages" ? (
        <OutagesPage call={call} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Uptime">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
