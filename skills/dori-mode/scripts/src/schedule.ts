import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { SourceError, type SourceEnqueue, type SourceStatus, sourceText } from "./event-sources.ts";
import { type Operation, type OperationStore, OPEN_STATES, perform, plan, type ReadBack, settleOperation } from "./operations.ts";
import type { Runner } from "./run.ts";

/*
 * Scheduled jobs (design 1.9): a `schedule` source in sources.json fires on a cron
 * expression or every N seconds, in a time zone (Asia/Seoul unless the job names another). A job either emits
 * `<kind> <text>` or runs a command and emits its result: `<kind> <name>: <output>` on exit 0, else
 * `SCHEDULE_FAILED <name> exited <code>: <output>`. A heavy command waits for a free heavy slot (heavy-slot.ts).
 *
 * Every run is one operation row (operations.ts) keyed by the job and its slot: `schedule:<name>/schedule-run/<slot ISO>`,
 * so the store holds each job's last run and its next run follows from it. A slot is planned (durable) before it runs and
 * is never planned twice, so a restart never repeats a run. A row left `attempted` by a crash is read back through the
 * journal: the result event is there -> verified; an emit job without it is emitted again (the event id dedupes it); a
 * command job without it is `ambiguous` and the lead gets one OPERATION_AMBIGUOUS, the command never runs again by itself.
 *
 * Slots missed while the supervisor was down (more than one slot passed, or the due slot is older than
 * SCHEDULE_GRACE_MS) follow the job's `catchUp`: `once` runs the latest missed slot once, `skip` records it as skipped.
 * `dori schedule run-now` spools a request that runs as its own row (`now@<ISO>`) and leaves the schedule as it was.
 */

export const SCHEDULE_TZ = "Asia/Seoul";
export const SCHEDULE_MIN_EVERY_SEC = 60;
/** A due slot older than this when first seen was missed (the supervisor was down or stalled): catchUp decides. */
export const SCHEDULE_GRACE_MS = 5 * 60_000;
export const SCHEDULE_TIMEOUT_SEC = 600;
export const SCHEDULE_MAX_TIMEOUT_SEC = 3_600;
export const SCHEDULE_ACTION = "schedule-run";
export const SCHEDULE_FAILED = "SCHEDULE_FAILED";
export const RUN_NOW_DIR = "schedule-now";
const MANUAL = "now@";

export type CatchUp = "once" | "skip";
export type ScheduleSpec = {
  readonly name: string; readonly type: "schedule"; readonly kind: string;
  /** Exactly one of cron (5 fields or @hourly/@daily/@weekly/@monthly) and everySec. */
  readonly cron?: string; readonly everySec?: number;
  readonly tz: string;
  /** Exactly one of text (emit `<kind> <text>`) and command (an argv; its result is the event). */
  readonly text?: string; readonly command?: readonly string[]; readonly cwd?: string;
  readonly heavy?: true; readonly timeoutSec?: number;
  readonly catchUp: CatchUp;
  /** When the job was added: no earlier slot ever runs, and every-N slots count from here. */
  readonly since: number;
};

type Cron = {
  readonly min: ReadonlySet<number>; readonly hour: ReadonlySet<number>; readonly dom: ReadonlySet<number>;
  readonly mon: ReadonlySet<number>; readonly dow: ReadonlySet<number>; readonly domAny: boolean; readonly dowAny: boolean;
};

const ALIASES: Readonly<Record<string, string>> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };

const field = (text: string, lo: number, hi: number, name: string): Set<number> => {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new SourceError(`cron ${name} "${part}" must be *, N, N-M, a list of those, or one with /STEP`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new SourceError(`cron ${name} "${part}" is outside ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
};

export const parseCron = (expr: string): Cron => {
  const text = ALIASES[expr.trim()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new SourceError(`cron "${expr}" must have 5 fields: minute hour day-of-month month day-of-week`);
  const [mi, h, dm, mo, dw] = parts as [string, string, string, string, string];
  const dow = field(dw, 0, 7, "day of week");
  if (dow.delete(7)) dow.add(0);
  return {
    min: field(mi, 0, 59, "minute"), hour: field(h, 0, 23, "hour"), dom: field(dm, 1, 31, "day of month"), mon: field(mo, 1, 12, "month"), dow,
    domAny: dm.startsWith("*"), dowAny: dw.startsWith("*"),
  };
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formats = new Map<string, Intl.DateTimeFormat>();
type Wall = { readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly dow: number };

/** The wall clock of `ms` in time zone `tz`. */
const wall = (ms: number, tz: string): Wall => {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formats.set(tz, format);
  }
  const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), dow: WEEKDAYS.indexOf(p.weekday ?? "") };
};

const validZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

/** Standard cron: with both day fields restricted, either one matching is enough. */
const dayMatches = (c: Cron, w: Wall): boolean =>
  c.domAny && c.dowAny ? true : c.domAny ? c.dow.has(w.dow) : c.dowAny ? c.dom.has(w.day) : c.dom.has(w.day) || c.dow.has(w.dow);

const CRON_SEARCH_STEPS = 50_000;

/** The first minute after `after` that `cron` matches in `tz`; undefined when none does (e.g. 31 February). */
export const nextCron = (cron: Cron, tz: string, after: number): number | undefined => {
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < CRON_SEARCH_STEPS; i++) {
    const w = wall(t, tz);
    if (!cron.mon.has(w.month) || !dayMatches(cron, w)) t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60_000;
    else if (!cron.hour.has(w.hour)) t += (60 - w.minute) * 60_000;
    else if (!cron.min.has(w.minute)) t += 60_000;
    else return t;
  }
  return undefined;
};

const cronOf = new Map<string, Cron>();
const cached = (expr: string): Cron => {
  let cron = cronOf.get(expr);
  if (!cron) cronOf.set(expr, cron = parseCron(expr));
  return cron;
};

/** The job's first slot after `after` (never before `since`). */
export const nextSlot = (spec: ScheduleSpec, after: number): number | undefined => {
  const base = Math.max(after, spec.since);
  if (spec.everySec !== undefined) {
    const every = spec.everySec * 1_000;
    return spec.since + (Math.floor((base - spec.since) / every) + 1) * every;
  }
  return nextCron(cached(spec.cron ?? ""), spec.tz, base);
};

/** A year of every-minute slots: a longer gap counts from its newest year. */
const MAX_COUNTED = 600_000;

/** The newest slot in (after, now] and how many slots that range holds; undefined when none is due. */
export const dueSlot = (spec: ScheduleSpec, after: number, now: number): { readonly slot: number; readonly count: number } | undefined => {
  const first = nextSlot(spec, after);
  if (first === undefined || first > now) return undefined;
  if (spec.everySec !== undefined) {
    const every = spec.everySec * 1_000;
    const slot = spec.since + Math.floor((now - spec.since) / every) * every;
    return { slot, count: (slot - first) / every + 1 };
  }
  let slot = first;
  let count = 1;
  for (let next = nextSlot(spec, slot); next !== undefined && next <= now; next = nextSlot(spec, slot)) {
    slot = next;
    if (++count >= MAX_COUNTED) return dueSlot(spec, now - 366 * 86_400_000, now);
  }
  return { slot, count };
};

/** A schedule spec from sources.json or `dori schedule add` (name and kind already checked); throws SourceError. */
export const validateSchedule = (r: Record<string, unknown>, name: string, kind: string): ScheduleSpec => {
  const hasCron = r.cron !== undefined;
  const hasEvery = r.everySec !== undefined;
  if (hasCron === hasEvery) throw new SourceError(`schedule ${name}: give exactly one of cron and everySec`);
  if (hasCron && (typeof r.cron !== "string" || !r.cron.trim())) throw new SourceError(`schedule ${name}: cron must be a cron expression`);
  if (hasEvery && (typeof r.everySec !== "number" || !Number.isInteger(r.everySec) || r.everySec < SCHEDULE_MIN_EVERY_SEC)) {
    throw new SourceError(`schedule ${name}: everySec must be a whole number of seconds, at least ${SCHEDULE_MIN_EVERY_SEC}`);
  }
  const tz = r.tz === undefined ? SCHEDULE_TZ : r.tz;
  if (typeof tz !== "string" || !validZone(tz)) throw new SourceError(`schedule ${name}: tz "${String(tz)}" is not a known time zone`);
  if ((r.text === undefined) === (r.command === undefined)) throw new SourceError(`schedule ${name}: give exactly one of text and command`);
  if (r.text !== undefined && (typeof r.text !== "string" || !sourceText(r.text))) throw new SourceError(`schedule ${name}: text must not be empty`);
  const command = r.command;
  if (command !== undefined && (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string") || !(command[0] as string).trim())) {
    throw new SourceError(`schedule ${name}: command must be a non-empty argv array of strings`);
  }
  if (command === undefined && (r.cwd !== undefined || r.heavy !== undefined || r.timeoutSec !== undefined)) {
    throw new SourceError(`schedule ${name}: cwd, heavy and timeoutSec are for command jobs`);
  }
  if (r.cwd !== undefined && (typeof r.cwd !== "string" || !isAbsolute(r.cwd))) throw new SourceError(`schedule ${name}: cwd must be an absolute path`);
  if (r.heavy !== undefined && r.heavy !== true) throw new SourceError(`schedule ${name}: heavy must be true or absent`);
  const timeout = r.timeoutSec;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > SCHEDULE_MAX_TIMEOUT_SEC)) {
    throw new SourceError(`schedule ${name}: timeoutSec must be 1-${SCHEDULE_MAX_TIMEOUT_SEC}`);
  }
  const catchUp = r.catchUp === undefined ? "once" : r.catchUp;
  if (catchUp !== "once" && catchUp !== "skip") throw new SourceError(`schedule ${name}: catchUp must be once or skip`);
  if (typeof r.since !== "number" || !Number.isFinite(r.since)) throw new SourceError(`schedule ${name}: since must be a time in ms`);
  const spec: ScheduleSpec = {
    name, type: "schedule", kind,
    ...(hasCron ? { cron: (r.cron as string).trim() } : { everySec: r.everySec as number }),
    tz,
    ...(command !== undefined ? { command: command as string[] } : { text: r.text as string }),
    ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}),
    ...(r.heavy === true ? { heavy: true as const } : {}),
    ...(typeof timeout === "number" ? { timeoutSec: timeout } : {}),
    catchUp, since: r.since,
  };
  if (hasCron) parseCron(spec.cron ?? "");
  if (nextSlot(spec, spec.since) === undefined) throw new SourceError(`schedule ${name}: cron "${spec.cron}" never fires`);
  return spec;
};

/** "cron 0 9 * * * Asia/Seoul" or "every 3600s". */
export const scheduleWhen = (spec: ScheduleSpec): string => spec.cron !== undefined ? `cron ${spec.cron} ${spec.tz}` : `every ${spec.everySec}s`;

/** `dori schedule run-now`: a request the supervisor runs as its own row on its next pass. */
export const queueRunNow = (stateDir: string, name: string, now: number): void => {
  const dir = join(stateDir, RUN_NOW_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${now}-${randomUUID()}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify({ name, at: now }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

/** One job as `dori schedule list` and `dori status` show it. */
export type ScheduleRow = {
  readonly name: string; readonly kind: string; readonly when: string; readonly catchUp: CatchUp; readonly heavy?: true;
  readonly nextRunAt?: number; readonly lastRunAt?: number; readonly lastResult?: string; readonly waiting?: string;
};

export const scheduleRow = (spec: ScheduleSpec, status: Partial<SourceStatus> | undefined, now: number): ScheduleRow => {
  const next = nextSlot(spec, Math.max(status?.lastSlot ?? 0, now));
  return {
    name: spec.name, kind: spec.kind, when: scheduleWhen(spec), catchUp: spec.catchUp, ...(spec.heavy ? { heavy: true as const } : {}),
    ...(next !== undefined ? { nextRunAt: next } : {}),
    ...(status?.lastRunAt !== undefined ? { lastRunAt: status.lastRunAt } : {}),
    ...(status?.lastResult !== undefined ? { lastResult: status.lastResult } : {}),
    ...(status?.waiting !== undefined ? { waiting: status.waiting } : {}),
  };
};

export type SchedulePatch = Partial<Pick<SourceStatus, "lastSlot" | "lastRunAt" | "lastResult" | "waiting">>;

export type HeavySlots = { readonly take: (label: string) => Promise<string | undefined>; readonly release: (slot: string) => void };

export type ScheduleDeps = {
  /** Where run rows live: the store's operation table. */
  readonly operations: OperationStore;
  /** True when the journal has (or had) event `id`: the read-back of a run. */
  readonly journaled: (id: string) => boolean;
  readonly heavy?: HeavySlots;
};

/** What the source registry gives the runner: per-job journaling and status. */
export type ScheduleHost = {
  readonly stateDir: string;
  readonly now: () => number;
  readonly run: Runner;
  readonly enqueueFor: (name: string) => SourceEnqueue;
  /** Sets the given schedule fields of the job's status (an undefined value clears one). */
  readonly update: (name: string, patch: SchedulePatch) => void;
  readonly fail: (name: string, error: unknown) => void;
  readonly ok: (name: string) => void;
  readonly log?: (line: string) => void;
};

const laneOf = (name: string): string => `schedule:${name}`;
const iso = (ms: number): string => new Date(ms).toISOString();
const isManual = (op: Operation): boolean => op.target.startsWith(MANUAL);
/** A scheduled row's slot; NaN for a manual one. */
const slotOf = (op: Operation): number => (isManual(op) ? Number.NaN : Date.parse(op.target));

export class Scheduler {
  private readonly running = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();

  constructor(private readonly host: ScheduleHost, private readonly deps: ScheduleDeps) {}

  private rows(name: string): Operation[] {
    return this.deps.operations.list({ lane: laneOf(name) }).filter((op) => op.action === SCHEDULE_ACTION);
  }

  /** One pass: run-now requests, due slots planned, and each job's oldest open row started unless one is running. */
  tick(specs: readonly ScheduleSpec[]): void {
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    this.drainRunNow(byName);
    const now = this.host.now();
    for (const spec of specs) {
      try {
        const rows = this.rows(spec.name);
        const planned = this.planDue(spec, rows, now);
        const all = planned ? [...rows, planned] : rows;
        const lastSlot = Math.max(spec.since, ...all.map(slotOf).filter(Number.isFinite));
        const settled = all.filter((op) => !OPEN_STATES.includes(op.state)).sort((a, b) => a.updatedAt - b.updatedAt).at(-1);
        this.host.update(spec.name, { lastSlot, ...(settled ? { lastRunAt: settled.updatedAt } : {}) });
        if (!this.running.has(spec.name)) {
          const open = all.find((op) => OPEN_STATES.includes(op.state));
          if (open) this.start(spec, open);
        }
      } catch (e) { this.host.fail(spec.name, e); }
    }
  }

  /** Plans the due slot (durable) unless a row for a slot at least as new exists; a missed one follows catchUp. */
  private planDue(spec: ScheduleSpec, rows: readonly Operation[], now: number): Operation | undefined {
    const after = Math.max(spec.since, ...rows.map(slotOf).filter(Number.isFinite));
    const due = dueSlot(spec, after, now);
    if (!due) return undefined;
    const missed = due.count > 1 || now - due.slot > SCHEDULE_GRACE_MS;
    const spec_ = { lane: laneOf(spec.name), action: SCHEDULE_ACTION, target: iso(due.slot), ...(missed ? { data: JSON.stringify({ missed: due.count }) } : {}) };
    const op = plan(this.deps.operations, now, spec_);
    if (!missed || spec.catchUp === "once") {
      if (missed) this.host.log?.(`SCHEDULE_CATCH_UP ${spec.name} ${due.count} missed slot(s), running ${spec_.target} once`);
      return op;
    }
    this.host.update(spec.name, { lastResult: `skipped ${due.count} missed` });
    return settleOperation(this.deps.operations, now, op.id, "verified", `skipped: ${due.count} slot(s) missed while the supervisor was down (catchUp skip)`);
  }

  private drainRunNow(byName: ReadonlyMap<string, ScheduleSpec>): void {
    const dir = join(this.host.stateDir, RUN_NOW_DIR);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
      const path = join(dir, file);
      let request: { name?: unknown; at?: unknown };
      try { request = JSON.parse(readFileSync(path, "utf8")); } catch { request = {}; }
      const spec = typeof request.name === "string" ? byName.get(request.name) : undefined;
      if (!spec || typeof request.at !== "number") {
        renameSync(path, `${path}.bad`);
        this.host.log?.(`SCHEDULE_RUN_NOW_BAD ${file}: no such schedule or not a run-now request`);
        continue;
      }
      plan(this.deps.operations, this.host.now(), { lane: laneOf(spec.name), action: SCHEDULE_ACTION, target: `${MANUAL}${iso(request.at)}`, data: JSON.stringify({ manual: true }) });
      rmSync(path, { force: true });
    }
  }

  /** Runs one open row in the background: a command may take minutes, and the other sources keep ticking. */
  private start(spec: ScheduleSpec, row: Operation): void {
    this.running.add(spec.name);
    const job = this.execute(spec, row)
      .catch((e: unknown) => { this.host.fail(spec.name, e); })
      .finally(() => { this.running.delete(spec.name); this.jobs.delete(job); });
    this.jobs.add(job);
  }

  private async execute(spec: ScheduleSpec, row: Operation): Promise<void> {
    const { command } = spec;
    const put = this.host.enqueueFor(spec.name);
    const resultId = `schedule:${spec.name}:${row.target}`;
    let slot: string | undefined;
    // Only a row that may run its command takes a slot; an attempted one is reconciled by its read-back alone.
    if (command && spec.heavy && row.state === "planned") {
      if (!this.deps.heavy) throw new SourceError("heavy jobs need the heavy slot, which is not available here");
      slot = await this.deps.heavy.take(`schedule:${spec.name}`);
      if (slot === undefined) { this.host.update(spec.name, { waiting: "heavy slot" }); return; }
    }
    try {
      let result = "";
      const readBack: ReadBack = async () => (this.deps.journaled(resultId) ? "done" : command ? "unknown" : "not-done");
      const { op, ran } = await perform(this.deps.operations, this.host.now, { lane: row.lane, action: row.action, target: row.target, ...(row.data ? { data: row.data } : {}) }, async () => {
        if (!command) {
          put(resultId, `${spec.kind} ${sourceText(spec.text ?? "")}`);
          result = "emitted";
          return { ok: true, detail: result };
        }
        const done = await this.host.run(command, { timeoutMs: (spec.timeoutSec ?? SCHEDULE_TIMEOUT_SEC) * 1_000, ...(spec.cwd ? { cwd: spec.cwd } : {}) });
        const output = sourceText(done.code === 0 ? done.out : `${done.err} ${done.out}`) || "(no output)";
        // A failed command is a run that happened: it is reported, and the slot is not tried again.
        if (done.code === 0) put(resultId, `${spec.kind} ${spec.name}: ${output}`);
        else put(resultId, `${SCHEDULE_FAILED} ${spec.name} exited ${done.code}${done.timedOut ? " (timed out)" : ""}: ${output}`);
        result = done.code === 0 ? "ok" : `failed exit ${done.code}`;
        return { ok: true, detail: result };
      }, readBack);
      if (op.state === "ambiguous") {
        put(`schedule-ambiguous:${op.id}`, `OPERATION_AMBIGUOUS ${op.id} ${op.detail}; check whether ${spec.name} ran, then dori ops resolve ${op.id} --as verified|retry`);
        result = "ambiguous";
      } else if (op.state === "failed") {
        throw new SourceError(`${op.id} failed: ${op.detail}`);
      } else if (!ran && !result) {
        result = "ok (read back)";
      }
      this.host.update(spec.name, { lastRunAt: op.updatedAt, lastResult: result, waiting: undefined });
      this.host.ok(spec.name);
    } finally {
      if (slot !== undefined) this.deps.heavy?.release(slot);
    }
  }

  /** Resolves when every job started so far has finished (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }
}
