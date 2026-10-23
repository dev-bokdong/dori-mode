import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { gateVerdict, headroomNote, type QuotaState, readQuotaState, stateHoldsLanes } from "./claude-quota.ts";
import type { DoriConfig } from "./config.ts";
import { eventClass, eventKind, type EventClass } from "./event-policy.ts";
import { readSourceStatus, SourceSpecs, type SourceView, sourceViews } from "./event-sources.ts";
import { type ScheduleRow, scheduleRow, type ScheduleSpec } from "./schedule.ts";
import { githubSummary } from "./github-events.ts";
import { gatewayView, readGatewayStatus, type GatewayView } from "./gateway-status.ts";
import { type LaneReport, latestLaneReports } from "./lane-reports.ts";
import { pendingLeadRestart, type LeadRestartRequest } from "./lead-restart.ts";
import { listPanes } from "./panes.ts";
import type { RecoveryLane } from "./recover.ts";
import { type Lane, type Registry, statusOf } from "./registry.ts";
import { Repos } from "./repos.ts";
import type { Clock, Runner } from "./run.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { readStoreView, readWakes } from "./store.ts";

export const SERVICES = ["herdr-server.service", "dori-supervisor.service"] as const;
export const LEGACY_PRESENCE = "dori-presence.service";

export type UnitState = { readonly name: string; readonly enabled: string; readonly active: string };

/** Read-only: is-enabled / is-active never change a unit. */
export const unitState = async (run: Runner, name: string): Promise<UnitState> => {
  const [enabled, active] = await Promise.all([
    run(["systemctl", "--user", "is-enabled", name], { timeoutMs: 5_000 }),
    run(["systemctl", "--user", "is-active", name], { timeoutMs: 5_000 }),
  ]);
  return { name, enabled: enabled.out.split("\n")[0] || "unknown", active: active.out.split("\n")[0] || "unknown" };
};

export type LeadState = {
  readonly pane: string;
  readonly state: "warm" | "cold" | "missing" | "unknown";
  readonly idleMin?: number;
  readonly tokens?: number;
  readonly note?: string;
};

export type Status = {
  readonly at: string;
  readonly services: readonly UnitState[];
  readonly lead: LeadState & { readonly cacheTtlMin: number; readonly capTokens: number; readonly pendingRestart?: LeadRestartRequest };
  readonly lanes: readonly {
    readonly key: string; readonly model?: string; readonly ageMin: number; readonly progress?: string; readonly repo?: string; readonly pr?: number;
    /** recoveryPending: "exhausted" after every recovery attempt failed (LANE_RECOVERY_EXHAUSTED), else "pending". */
    readonly recovery?: "pending" | "exhausted";
    /** The lane's latest `dori report` row (highest seq), routed or not. */
    readonly report?: LaneReport;
  }[];
  readonly waits: readonly { readonly key: string; readonly until: string; readonly deadline?: string; readonly note?: string }[];
  readonly github: {
    readonly repos: readonly string[];
    readonly lastPollAt?: string;
    readonly failures: readonly { readonly repo: string; readonly at: string }[];
    /** Logins whose new issues wake the lead, and repos whose issues have a baseline. */
    readonly issueAuthors: readonly string[];
    readonly issueRepos: readonly string[];
  };
  readonly gateway: GatewayView;
  /** Owner messages the lead was handed and reminded about (ACK_MISSING) without acking them yet. */
  readonly unacked: number;
  /** The supervisor's last Claude usage read (dori quota and launches refresh it too). */
  readonly claude?: QuotaState;
  /** That read's headroom summed over every Claude account, e.g. "headroom 315% (hold-lanes < 50%, brief < 25%)". */
  readonly claudeHeadroom?: string;
  readonly events: EventStats;
  /** Every event source with its last event and error, and a sources.json that does not read. */
  readonly sources?: { readonly sources: readonly SourceView[]; readonly error?: string };
  /** Every scheduled job with its next run, its last run and how that ended. */
  readonly schedules?: readonly ScheduleRow[];
};

/** The scheduled jobs in sources.json with their next run; none when it does not read (dori status shows that error). */
export const scheduleRows = (stateDir: string, now: number): ScheduleRow[] => {
  let specs: ScheduleSpec[] = [];
  try { specs = new SourceSpecs(stateDir).list().filter((spec): spec is ScheduleSpec => spec.type === "schedule"); } catch { return []; }
  const status = readSourceStatus(stateDir)?.sources ?? {};
  return specs.map((spec) => scheduleRow(spec, status[spec.name], now));
};

/** Per event kind over the last `hours`: events journaled, lead wakes it triggered and the model calls of those wakes. */
export type KindStats = {
  readonly kind: string;
  /** Absent for a trigger with no event line, such as "(restart)". */
  readonly cls?: EventClass;
  readonly events: number;
  readonly wakes: number;
  /** Wakes closed with a readable call count, and their calls: calls per wake is calls / measured. */
  readonly measured: number;
  readonly calls: number;
};
export type EventStats = {
  readonly hours: number;
  readonly wakes: number;
  readonly measured: number;
  readonly calls: number;
  /** Most wakes first, then most events. A wake triggered by several kinds counts once for each. */
  readonly kinds: readonly KindStats[];
};

export const STATS_HOURS = 24;

const eventStats = (config: DoriConfig, now: number): EventStats => {
  const since = now - STATS_HOURS * 3_600_000;
  const policy = config.eventPolicy;
  const lines = readStoreView(config.stateDir, {
    json: (journal) => (Array.isArray(journal.events) ? journal.events : []).filter((event) => (event.at ?? 0) >= since).map((event) => event.line),
    sqlite: (db) => (db.query("SELECT line FROM events WHERE at >= ?").all(since) as { line: string }[]).map((row) => row.line),
  }) ?? [];
  const kinds = new Map<string, { cls?: EventClass; events: number; wakes: number; measured: number; calls: number }>();
  const of = (kind: string) => {
    let entry = kinds.get(kind);
    if (!entry) kinds.set(kind, entry = { events: 0, wakes: 0, measured: 0, calls: 0 });
    return entry;
  };
  for (const line of lines) {
    const entry = of(eventKind(line, policy));
    entry.cls ??= eventClass(line, policy);
    entry.events++;
  }
  const wakes = readWakes(config.stateDir, since);
  let measured = 0;
  let calls = 0;
  for (const wake of wakes) {
    if (wake.calls !== undefined) { measured++; calls += wake.calls; }
    for (const kind of wake.trigger) {
      const entry = of(kind);
      entry.wakes++;
      if (wake.calls !== undefined) { entry.measured++; entry.calls += wake.calls; }
    }
  }
  return {
    hours: STATS_HOURS, wakes: wakes.length, measured, calls,
    kinds: [...kinds].map(([kind, s]) => ({ kind, ...s })).sort((a, b) => b.wakes - a.wakes || b.events - a.events || a.kind.localeCompare(b.kind)),
  };
};

export type StatusDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly config: DoriConfig;
  readonly registry: Registry;
};

const lastTokens = (file: string): number => {
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n").reverse()) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = (entry as { message?: { usage?: { totalTokens?: unknown } } } | null)?.message?.usage;
    if (usage && typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) return usage.totalTokens;
  }
  return 0;
};

const leadState = async (d: StatusDeps): Promise<LeadState> => {
  const pane = d.config.leadPane;
  try {
    const found = (await listPanes(d.run)).find((p) => p.pane_id === pane);
    if (!found) return { pane, state: "missing", note: "pane not found in herdr" };
    if (!found.agent) return { pane, state: "cold", note: "no agent running in the lead pane" };
    const cwd = found.cwd ?? d.config.defaultCwd;
    const hit = await resolveSession(pane, cwd, await procTable(d.run), { run: d.run, sessionsDir: d.config.sessionsDir });
    if (!hit.id) return { pane, state: "unknown", note: "cannot resolve the lead session" };
    const dir = sessionDirFor(d.config.sessionsDir, cwd);
    const file = existsSync(hit.id) ? hit.id :
      (await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: dir, absolute: true, onlyFiles: true })))
        .find((path) => path.endsWith(`_${hit.id}.jsonl`) || path.endsWith(`/${hit.id}.jsonl`));
    if (!file) return { pane, state: "unknown", note: "lead session file not found" };
    const idleMs = d.clock.now() - statSync(file).mtimeMs;
    return { pane, state: idleMs < d.config.cacheTtlMin * 60_000 ? "warm" : "cold", idleMin: Math.floor(idleMs / 60_000), tokens: lastTokens(file) };
  } catch (e) {
    return { pane, state: "unknown", note: e instanceof Error ? e.message.slice(0, 80) : "lookup failed" };
  }
};

const readWaits = (stateDir: string): Status["waits"] => {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, "waits.json"), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((w: unknown) => {
      const r = w as { key?: unknown; until?: unknown; deadline?: unknown; note?: unknown };
      return typeof r.key === "string" && typeof r.until === "string"
        ? [{ key: r.key, until: r.until, ...(typeof r.deadline === "number" && Number.isFinite(r.deadline) ? { deadline: new Date(r.deadline).toISOString() } : {}), ...(typeof r.note === "string" && r.note.trim() ? { note: r.note } : {}) }]
        : [];
    });
  } catch {
    return [];
  }
};

const readUnacked = (stateDir: string): number => readStoreView(stateDir, {
  json: (journal) => Array.isArray(journal.awaitingAck) ? journal.awaitingAck.filter((entry: { reminded?: unknown }) => entry?.reminded === true).length : 0,
  sqlite: (db) => (db.query("SELECT count(*) AS n FROM owner_messages WHERE reminded = 1").get() as { n: number }).n,
}) ?? 0;

/** Cheap, offline guess at a lane's repo (owner/name from a gh -R in its Done signal, else the worktree directory) and PR number. */
const laneRepoPr = (l: Lane): { repo?: string; pr?: number } => {
  const text = `${l.done} ${l.title}`;
  const repo = /"-R"\s*,\s*"([\w.-]+\/[\w.-]+)"/.exec(text)?.[1] ?? /(?:^|\s)-R\s+([\w.-]+\/[\w.-]+)/.exec(text)?.[1]
    ?? /\/worktrees\/([^/]+)\//.exec(l.worktrees?.[0] ?? l.cwd ?? "")?.[1];
  // Only explicit PR references: a "(#N)" in a title may be a task or issue id, not a PR.
  const m = /\/pull\/(\d+)|\bpr\s+(?:view|checks|merge)\s+"?(\d+)/i.exec(l.done);
  const pr = m ? Number(m[1] ?? m[2]) : undefined;
  return { ...(repo ? { repo } : {}), ...(pr !== undefined ? { pr } : {}) };
};

/** Read-only and no LLM: unit states, files under stateDir, one herdr pane list. */
export const collectStatus = async (d: StatusDeps): Promise<Status> => {
  const now = d.clock.now();
  const [services, lead, open] = await Promise.all([
    Promise.all([...SERVICES, LEGACY_PRESENCE].map((name) => unitState(d.run, name))),
    leadState(d),
    existsSync(d.registry.dir) ? d.registry.open() : Promise.resolve([]),
  ]);
  const gh = githubSummary(d.config.stateDir);
  const pendingRestart = pendingLeadRestart(d.config.stateDir);
  const claude = readQuotaState(d.config.stateDir);
  let repos: string[] = [];
  try { repos = new Repos(d.config.stateDir).list(); } catch { /* unreadable list: show none */ }
  const reports = latestLaneReports(d.config);
  return {
    at: new Date(now).toISOString(),
    services,
    lead: { ...lead, cacheTtlMin: d.config.cacheTtlMin, capTokens: d.config.leadContextCapTokens, ...(pendingRestart ? { pendingRestart } : {}) },
    lanes: open.filter((l) => statusOf(l) === "working").map((l) => ({
      key: l.key, ...(l.model ? { model: l.model } : {}), ...laneRepoPr(l),
      ageMin: Math.max(0, Math.floor((now - Date.parse(l.openedAt)) / 60_000)),
      ...(l.lastProgressPost ?? l.lastPostedReport ? { progress: l.lastProgressPost ?? l.lastPostedReport } : {}),
      ...(l.recoveryPending ? { recovery: (l as RecoveryLane).recoveryExhausted ? "exhausted" as const : "pending" as const } : {}),
      ...(reports.has(l.key) ? { report: reports.get(l.key) } : {}),
    })),
    waits: readWaits(d.config.stateDir),
    github: {
      repos,
      ...(gh.polledAt !== undefined ? { lastPollAt: new Date(gh.polledAt).toISOString() } : {}),
      failures: Object.entries(gh.failures).map(([repo, at]) => ({ repo, at: new Date(at).toISOString() })),
      issueAuthors: d.config.githubIssueAuthors,
      issueRepos: gh.issueRepos,
    },
    gateway: gatewayView(readGatewayStatus(d.config.stateDir), now),
    unacked: readUnacked(d.config.stateDir),
    ...(claude ? { claude, claudeHeadroom: headroomNote(gateVerdict(claude.usage, d.config.quotaGate)) } : {}),
    events: eventStats(d.config, now),
    sources: sourceViews(d.config.stateDir),
    schedules: scheduleRows(d.config.stateDir, now),
  };
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}~` : s);
const kilo = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const dur = (min: number): string => (min < 120 ? `${min}m` : min < 2880 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`);
const ago = (iso: string | undefined, now: number): string => {
  if (!iso) return "never";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return min < 1 ? "just now" : `${dur(min)} ago`;
};

const KST_MS = 9 * 3_600_000;
const two = (n: number): string => String(n).padStart(2, "0");
/** Fixed +09:00 (Asia/Seoul has no DST): "10-21 09:53". */
export const kst = (ms: number): string => {
  const d = new Date(ms + KST_MS);
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

/** "anthropic-subscription/claude-opus-5-5" -> "opus-5-5"; other ids keep their readable tail. */
export const shortModel = (model: string): string =>
  model.replace(/^.*\//, "").replace(/\[.*\]$/, "").replace(/^claude-/, "").replace(/-\d{8}$/, "") || model;

const EPOCH_SIGNAL = /\[\s*\$\(\s*date\s+\+%s\s*\)\s*-ge\s+(\d{9,11})\s*\]/;
/** When the wait fires, from a `[ $(date +%s) -ge N ]` signal; else null. The `deadline` field is the timeout, not this. */
export const waitFireMs = (w: Status["waits"][number]): number | null => {
  const m = EPOCH_SIGNAL.exec(w.until);
  return m ? Number(m[1]) * 1000 : null;
};
const waitTimeoutMs = (w: Status["waits"][number]): number | null => {
  const ms = w.deadline ? Date.parse(w.deadline) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const left = (ms: number, now: number): string => {
  const min = Math.round(Math.abs(ms - now) / 60_000);
  return ms >= now ? `${dur(min)} left` : `${dur(min)} overdue`;
};

type Problem = { readonly label: string; readonly line: string };
const problems = (s: Status, now: number): Problem[] => {
  const out: Problem[] = [];
  const bad = s.services.filter((u) => (u.name === LEGACY_PRESENCE ? u.active === "active" : u.active !== "active" || u.enabled !== "enabled"));
  for (const u of bad) {
    const name = u.name.replace(/\.service$/, "");
    out.push({ label: `${name} ${u.active}`, line: `services: ${name}${u.name === LEGACY_PRESENCE ? " (legacy, should be off)" : ""} ${u.active}/${u.enabled}` });
  }
  if (s.gateway.state !== "live") out.push({ label: `gateway ${s.gateway.state}`, line: `gateway: ${s.gateway.text}` });
  const g = s.github;
  if (g.failures.length) out.push({ label: "github poll failing", line: `github: failures: ${g.failures.slice(0, 4).map((f) => `${f.repo} ${ago(f.at, now)}`).join(", ")}` });
  if (!g.issueAuthors.length) out.push({ label: "no trusted issue authors", line: "issues: no trusted authors (githubIssueAuthors), new issues never wake the lead" });
  if (s.lead.state === "missing" || s.lead.state === "unknown") out.push({ label: `lead ${s.lead.state}`, line: "" });
  if (s.unacked > 0) out.push({ label: `unacked ${s.unacked}`, line: `acks: ${s.unacked} owner message${s.unacked === 1 ? "" : "s"} handed to the lead without its read receipt (dori ack) after ACK_MISSING` });
  const recovering = (kind: "pending" | "exhausted") => s.lanes.filter((lane) => lane.recovery === kind).map((lane) => lane.key);
  const exhausted = recovering("exhausted");
  const pending = recovering("pending");
  if (exhausted.length) out.push({ label: `recovery exhausted ${exhausted.length}`, line: `lanes: recovery exhausted (not relaunched or nudged): ${exhausted.join(", ")}` });
  if (pending.length) out.push({ label: `recovery pending ${pending.length}`, line: `lanes: recovery pending (not nudged): ${pending.join(", ")}` });
  if (s.claude && s.claude.mode !== "ok") {
    out.push({ label: `claude ${s.claude.mode}`, line: `claude: ${claudeText(s.claude, s.claudeHeadroom, now)}, lanes ${stateHoldsLanes(s.claude) ? "held" : "allowed"}` });
  }
  if (s.sources?.error) out.push({ label: "sources.json invalid", line: `sources: ${clip(s.sources.error, 160)}` });
  for (const src of s.sources?.sources.filter((source) => source.failing) ?? []) {
    out.push({ label: `source ${src.name} failing`, line: `source ${src.name} failing since ${ago(iso(src.lastErrorAt), now)}: ${clip(src.lastError ?? "?", 160)}` });
  }
  return out;
};

const claudeWindow = (name: string, w: { readonly usedPct: number; readonly resetAt?: number } | undefined): string =>
  w ? ` ${name} ${w.usedPct}%${w.resetAt !== undefined ? ` (resets ${kst(w.resetAt)})` : ""}` : "";
/** "brief headroom 20% (...), default 5h 93% (resets ...) 7d 40%, read 3m ago". */
const claudeText = (c: QuotaState, headroom: string | undefined, now: number): string =>
  `${c.mode}${headroom ? ` ${headroom}` : ""}, ${c.usage.accounts.map((a) => `${a.name}${claudeWindow("5h", a.fiveHour)}${claudeWindow("7d", a.weekly)}`).join(", ")}, read ${ago(new Date(c.usage.at).toISOString(), now)}`;

type Limits = { readonly lanes: number; readonly waits: number; readonly progress: number; readonly kinds: number };
const LIMITS: readonly Limits[] = [
  { lanes: 8, waits: 6, progress: 200, kinds: 10 }, { lanes: 8, waits: 6, progress: 120, kinds: 8 }, { lanes: 5, waits: 4, progress: 80, kinds: 6 },
  { lanes: 3, waits: 3, progress: 50, kinds: 4 }, { lanes: 2, waits: 2, progress: 30, kinds: 3 }, { lanes: 1, waits: 1, progress: 20, kinds: 2 },
];

const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

/** "sources: discord INBOUND 2m, github -, deploys(poll) DEPLOY 1h !failing": each source's last event kind and age. */
const sourceLine = (s: Status, now: number): string[] => {
  if (!s.sources) return [];
  const parts = s.sources.sources.map((src) => {
    const last = src.lastEventAt === undefined ? "-" : `${src.lastKind ?? "?"} ${ago(iso(src.lastEventAt), now)}`;
    return `${src.name}${src.type === "builtin" ? "" : `(${src.type})`} ${last}${src.failing ? " !failing" : ""}`;
  });
  return [clip(`sources: ${parts.join(", ")}`, 400)];
};

/** "schedules: brief next 10-24 09:00 KST (20h left), backup next 10-23 15:00 KST (2h left) last failed exit 1". */
const scheduleLine = (s: Status, now: number): string[] => {
  if (!s.schedules?.length) return [];
  const parts = s.schedules.map((job) => {
    const next = job.waiting ? `waiting for a ${job.waiting}` : job.nextRunAt === undefined ? "never" : `next ${kst(job.nextRunAt)} KST (${left(job.nextRunAt, now)})`;
    return `${job.name} ${next}${job.lastResult && job.lastResult !== "ok" && job.lastResult !== "emitted" ? ` last ${job.lastResult}` : ""}`;
  });
  return [clip(`schedules: ${parts.join(", ")}`, 400)];
};

const perWake = (calls: number, measured: number): string => (measured ? (calls / measured).toFixed(1) : "?");

/** "wakes 24h 12, 8.3 calls/wake" and "kinds 24h: INBOUND 20ev 5w 9.2c/w, ..." (calls per wake only for kinds that woke the lead). */
const eventLines = (e: EventStats, max: number): string[] => {
  if (!e.kinds.length) return [];
  const head = `wakes ${e.hours}h ${e.wakes}${e.wakes ? `, ${perWake(e.calls, e.measured)} calls/wake` : ""}`;
  const shown = e.kinds.slice(0, max).map((k) => `${k.kind} ${k.events}ev${k.wakes ? ` ${k.wakes}w ${perWake(k.calls, k.measured)}c/w` : ""}`);
  return [head, `kinds ${e.hours}h: ${shown.join(", ")}${e.kinds.length > max ? `, +${e.kinds.length - max} more` : ""}`];
};
/** Discord's limit is 2000 including the code fence the command adds; stay well inside. */
export const STATUS_MAX_CHARS = 1900;

type Lanes = Status["lanes"];
const laneLine = (lane: Lanes[number], progress: number): string => {
  const where = [lane.repo, lane.pr !== undefined ? `#${lane.pr}` : ""].filter(Boolean).join(" ");
  return `  ${[lane.recovery ? `!RECOVERY-${lane.recovery.toUpperCase()}` : "", lane.key, lane.model ? shortModel(lane.model) : "", dur(lane.ageMin), where].filter(Boolean).join(" ")}${lane.progress ? ` | ${clip(lane.progress, progress)}` : ""}`;
};

/** The line under page 1's lanes naming how many more there are (and, paged, where). */
type More = (hidden: number) => string;
const plainMore: More = (hidden) => `+${hidden} more`;

const build = (s: Status, lim: Limits, more: More = plainMore): string => {
  const now = Date.parse(s.at);
  const probs = problems(s, now);
  const head = probs.length
    ? `DORI PROBLEM ${kst(now)} KST | ${probs.slice(0, 3).map((p) => p.label).join(", ")}${probs.length > 3 ? ` +${probs.length - 3}` : ""}`
    : `DORI OK ${kst(now)} KST`;
  const lines = [`${head} | lanes ${s.lanes.length} | waits ${s.waits.length}`];
  const l = s.lead;
  lines.push(`lead ${l.pane || "(no leadPane)"} ${l.state}${l.idleMin !== undefined ? ` idle ${dur(l.idleMin)}` : ""}${l.tokens !== undefined ? ` ctx ${kilo(l.tokens)}/${kilo(l.capTokens)}` : ""}${l.note ? ` - ${l.note}` : ""}`);
  if (l.pendingRestart) lines.push(`lead restart ${l.pendingRestart.id} pending: ${l.pendingRestart.models.map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> ")}; next idle boundary`);
  for (const p of probs) if (p.line) lines.push(`! ${p.line}`);
  const g = s.github;
  const healthy = [
    ...(probs.some((p) => p.line.startsWith("services:")) ? [] : ["services"]),
    ...(s.gateway.state === "live" ? ["gateway"] : []),
    ...(g.failures.length ? [] : [`github ${g.repos.length} repos, poll ${ago(g.lastPollAt, now)}`]),
    ...(g.issueAuthors.length ? [`issues ${g.issueRepos.length} repos`] : []),
    ...(s.claude?.mode === "ok" ? [`claude ${s.claudeHeadroom ?? "ok"}`] : []),
  ];
  if (healthy.length) lines.push(`ok: ${healthy.join(", ")}`);
  lines.push(...eventLines(s.events, lim.kinds));
  lines.push(...sourceLine(s, now));
  lines.push(...scheduleLine(s, now));
  if (s.lanes.length) {
    lines.push("lanes");
    for (const lane of s.lanes.slice(0, lim.lanes)) lines.push(laneLine(lane, lim.progress));
    if (s.lanes.length > lim.lanes) lines.push(`  ${more(s.lanes.length - lim.lanes)}`);
  }
  if (s.waits.length) {
    lines.push("waits");
    for (const w of s.waits.slice(0, lim.waits)) {
      const fire = waitFireMs(w);
      const timeout = waitTimeoutMs(w);
      const when = fire !== null ? `${kst(fire)} KST (${left(fire, now)})`
        : timeout !== null ? `on signal, timeout ${kst(timeout)} KST (${left(timeout, now)})`
        : `until ${clip(w.until, 50)}`;
      lines.push(`  ${w.key} ${when}${w.note ? ` | ${clip(w.note, lim.progress)}` : ""}`);
    }
    if (s.waits.length > lim.waits) lines.push(`  +${s.waits.length - lim.waits} more`);
  }
  return lines.join("\n");
};

const bounded = (text: string): string =>
  text.length <= STATUS_MAX_CHARS ? text : `${text.slice(0, STATUS_MAX_CHARS - 12).replace(/[\uD800-\uDBFF]$/, "")}\n[truncated]`;

/** The first LIMITS row whose page 1 fits, and that text. */
const fit = (s: Status, more: More): { readonly text: string; readonly lim: Limits } => {
  for (const lim of LIMITS) {
    const text = build(s, lim, more);
    if (text.length <= STATUS_MAX_CHARS) return { text, lim };
  }
  const lim = LIMITS[LIMITS.length - 1]!;
  return { text: bounded(build(s, lim, more)), lim };
};

/** Plain text (no fence; the Discord command adds it), at most STATUS_MAX_CHARS. Healthy parts collapse to one ok line. */
export const renderStatus = (s: Status): string => fit(s, plainMore).text;

/** Lane lines on pages 2+: progress clipped like the roomiest page 1, and a line never longer than this. */
const PAGE_PROGRESS = 120;
const PAGE_LINE_MAX = 300;
/** Room left on a page for its header and its "next" line. */
const PAGE_BODY_MAX = STATUS_MAX_CHARS - 120;

/**
 * `/status` as pages, each at most STATUS_MAX_CHARS: page 1 is renderStatus (the summary with its first lanes) naming the
 * pages that hold the rest, and pages 2.. list the remaining lanes in order, as many as fit, under a one-line header.
 */
export const statusPages = (s: Status): string[] => {
  // Choose page 1's limits with the longest "more" line it can get, so the real one never pushes it over.
  const { lim } = fit(s, (hidden) => `+${hidden} more on pages 2-99999`);
  const rest = s.lanes.slice(lim.lanes);
  if (!rest.length) return [renderStatus(s)];
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const lane of rest) {
    const line = clip(laneLine(lane, PAGE_PROGRESS), PAGE_LINE_MAX);
    if (chunk.length && size + line.length + 1 > PAGE_BODY_MAX) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(line);
    size += line.length + 1;
  }
  chunks.push(chunk);
  const total = chunks.length + 1;
  const now = kst(Date.parse(s.at));
  const first = bounded(build(s, lim, (hidden) => `+${hidden} more on page${total > 2 ? `s 2-${total}` : " 2"}`));
  return [first, ...chunks.map((lines, i) => [
    `DORI lanes ${now} KST | page ${i + 2}/${total} | lanes ${s.lanes.length}`,
    ...lines,
    ...(i + 2 < total ? [`next: page ${i + 3}`] : []),
  ].join("\n"))];
};

/** One page of `/status` (1-based); a page past the end says how many there are. */
export const statusPage = (s: Status, page: number): string => {
  const pages = statusPages(s);
  return pages[page - 1] ?? `DORI status has ${pages.length} page${pages.length === 1 ? "" : "s"}; there is no page ${page}.`;
};

/** The /status slash command text: page 1 unless the command named another. */
export const lookupStatus = (d: StatusDeps) => async (_signal?: AbortSignal, page = 1): Promise<string> => statusPage(await collectStatus(d), page);
