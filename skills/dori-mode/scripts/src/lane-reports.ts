import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { fill } from "./config.ts";
import { claimDone, type Emit, type FlowDeps, REMOTE_SEEN_MAX } from "./done-flow.ts";
import { scrubForThread } from "./freshness.ts";
import { readScreen } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile, SQLITE_FILE, StoreError, type StoreKind } from "./store.ts";

/**
 * Structured lane reports (design 3.3): `dori report <key> <kind> --text T [--evidence E]` writes one
 * row, and the supervisor routes each row once and marks it consumed. Nothing is typed into the lead's pane.
 */
export const REPORT_KINDS = ["progress", "question", "blocked", "milestone", "done"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Where a routed row went: the lead's journal, the lane's thread, a done claim, or nowhere (its lane was closed or gone). */
export type ReportRoute = "journal" | "thread" | "claim" | "dropped";

export type LaneReport = {
  /** `<lane>:<generation>:<seq>`. */
  readonly id: string;
  readonly lane: string;
  /** The lane's ownership generation (design 4.2); 0 until ownership fencing lands. */
  readonly generation: number;
  /** 1, 2, 3, ... per lane, in the order the rows were written. */
  readonly seq: number;
  readonly kind: ReportKind;
  readonly text: string;
  readonly evidence?: string;
  readonly at: number;
  readonly consumedAt?: number;
  readonly route?: ReportRoute;
};

export type NewReport = Pick<LaneReport, "lane" | "generation" | "kind" | "text" | "evidence" | "at">;

/** Ownership generations do not exist yet (Phase 3): every row is written at generation 0. */
export const UNFENCED_GENERATION = 0;

export interface LaneReportStore {
  /** Writes `report` with the lane's next seq, durably, and returns the stored row. */
  append(report: NewReport): LaneReport;
  /** Rows not yet routed, oldest first (by time, then lane and seq). */
  pending(): LaneReport[];
  list(filter?: { readonly lane?: string }): LaneReport[];
  consume(id: string, at: number, route: ReportRoute): void;
  close(): void;
}

export const LANE_REPORTS_FILE = "lane-reports.json";
const LANE_REPORTS_LOCK = "lane-reports.lock.sqlite";

export const isReportKind = (value: unknown): value is ReportKind => typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);

const order = (a: LaneReport, b: LaneReport): number => a.at - b.at || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0) || a.seq - b.seq;
const withId = (report: NewReport, seq: number): LaneReport => ({
  id: `${report.lane}:${report.generation}:${seq}`, lane: report.lane, generation: report.generation, seq, kind: report.kind,
  text: report.text, ...(report.evidence ? { evidence: report.evidence } : {}), at: report.at,
});

/** `lane-reports.json` beside supervisor.json, rewritten whole under a short state lock (lanes and the supervisor both write). */
export class JsonLaneReports implements LaneReportStore {
  private readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, LANE_REPORTS_FILE);
    this.lock = join(stateDir, LANE_REPORTS_LOCK);
  }
  private read(): LaneReport[] {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { reports: LaneReport[] }).reports : [];
  }
  append(report: NewReport): LaneReport {
    return withStateLockSync(this.lock, () => {
      const reports = this.read();
      const seq = reports.reduce((max, r) => (r.lane === report.lane ? Math.max(max, r.seq) : max), 0) + 1;
      const row = withId(report, seq);
      saveJsonFile(this.path, { reports: [...reports, row] });
      return row;
    });
  }
  pending(): LaneReport[] { return this.read().filter((r) => r.consumedAt === undefined).sort(order); }
  list(filter: { readonly lane?: string } = {}): LaneReport[] {
    return this.read().filter((r) => filter.lane === undefined || r.lane === filter.lane).sort(order);
  }
  consume(id: string, at: number, route: ReportRoute): void {
    withStateLockSync(this.lock, () => {
      saveJsonFile(this.path, { reports: this.read().map((r) => (r.id === id && r.consumedAt === undefined ? { ...r, consumedAt: at, route } : r)) });
    });
  }
  close(): void {}
}

/** Created on first use like the lane_messages table, not by a schema migration. */
const DDL = `CREATE TABLE IF NOT EXISTS lane_reports (
  id TEXT PRIMARY KEY, lane TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  evidence TEXT, at INTEGER NOT NULL, consumed_at INTEGER, route TEXT, UNIQUE (lane, seq));
CREATE INDEX IF NOT EXISTS lane_reports_pending ON lane_reports (consumed_at, at);`;

type Row = { id: string; lane: string; generation: number; seq: number; kind: string; text: string; evidence: string | null; at: number; consumed_at: number | null; route: string | null };
const reportOf = (row: Row): LaneReport => ({
  id: row.id, lane: row.lane, generation: row.generation, seq: row.seq, kind: row.kind as ReportKind, text: row.text,
  ...(row.evidence !== null ? { evidence: row.evidence } : {}), at: row.at,
  ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}), ...(row.route !== null ? { route: row.route as ReportRoute } : {}),
});

/** The `lane_reports` table of supervisor.sqlite, on its own connection (WAL: the supervisor's connection keeps writing). */
export class SqliteLaneReports implements LaneReportStore {
  private readonly db: Database;
  constructor(path: string) {
    if (!existsSync(path)) throw new StoreError(`STORE_MISSING ${path}; lane reports live in the sqlite store`);
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec(DDL);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  append(report: NewReport): LaneReport {
    // IMMEDIATE: two lanes (or two reports of one lane) never read the same max seq.
    return this.db.transaction(() => {
      const max = this.db.query("SELECT max(seq) AS seq FROM lane_reports WHERE lane = ?").get(report.lane) as { seq: number | null };
      const row = withId(report, (max.seq ?? 0) + 1);
      this.db.query("INSERT INTO lane_reports (id, lane, generation, seq, kind, text, evidence, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.lane, row.generation, row.seq, row.kind, row.text, row.evidence ?? null, row.at);
      return row;
    }).immediate();
  }
  pending(): LaneReport[] {
    return (this.db.query("SELECT * FROM lane_reports WHERE consumed_at IS NULL ORDER BY at, lane, seq").all() as Row[]).map(reportOf);
  }
  list(filter: { readonly lane?: string } = {}): LaneReport[] {
    const rows = filter.lane === undefined
      ? this.db.query("SELECT * FROM lane_reports ORDER BY at, lane, seq").all() as Row[]
      : this.db.query("SELECT * FROM lane_reports WHERE lane = ? ORDER BY at, seq").all(filter.lane) as Row[];
    return rows.map(reportOf);
  }
  consume(id: string, at: number, route: ReportRoute): void {
    this.db.query("UPDATE lane_reports SET consumed_at = ?, route = ? WHERE id = ? AND consumed_at IS NULL").run(at, route, id);
  }
  close(): void { this.db.close(); }
}

/**
 * Each lane's latest row (highest seq), read-only for `dori status`: lane-reports.json, or the lane_reports table opened
 * read-only (never the DDL a store connection runs). No file, no table or an unreadable one reads as no rows.
 */
export const latestLaneReports = (config: { readonly stateDir: string; readonly store: StoreKind }): Map<string, LaneReport> => {
  let rows: LaneReport[] = [];
  try {
    if (config.store === "json") rows = new JsonLaneReports(config.stateDir).list();
    else if (existsSync(join(config.stateDir, SQLITE_FILE))) {
      const db = new Database(join(config.stateDir, SQLITE_FILE), { readonly: true });
      try {
        rows = (db.query("SELECT r.* FROM lane_reports r JOIN (SELECT lane, max(seq) AS seq FROM lane_reports GROUP BY lane) m ON r.lane = m.lane AND r.seq = m.seq").all() as Row[]).map(reportOf);
      } finally { db.close(); }
    }
  } catch { /* no reports yet */ }
  const latest = new Map<string, LaneReport>();
  for (const row of rows) if ((latest.get(row.lane)?.seq ?? 0) < row.seq) latest.set(row.lane, row);
  return latest;
};

export const openLaneReports = (config: { readonly stateDir: string; readonly store: StoreKind }): LaneReportStore =>
  config.store === "sqlite" ? new SqliteLaneReports(join(config.stateDir, SQLITE_FILE)) : new JsonLaneReports(config.stateDir);

/** A report's text as one line (it lands in an event line and a thread message). */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The event a routed row becomes: `LANE_REPORT <key> <kind> <text>`, with ` (evidence: E)` when given. */
export const reportLine = (report: LaneReport): string =>
  `LANE_REPORT ${report.lane} ${report.kind} ${oneLine(report.text)}${report.evidence ? ` (evidence: ${oneLine(report.evidence)})` : ""}`;

/** Journals one line under a stable id; the supervisor dedupes a repeat of the same id. */
export type ReportEnqueue = (id: string, line: string) => unknown;

/**
 * Routes every pending row once, oldest first, and marks it consumed after its effect. question, blocked and milestone
 * become a `LANE_REPORT` event under the id `lane-report:<row id>` (its class comes from eventPolicy: question and
 * blocked wake the lead, milestone is digest by default); progress is posted to the lane's thread through
 * hooks.threadReply (without a hook or thread, or when the post fails, it is a digest LANE_REPORT instead); done is the
 * lane's done claim, as `dori claim-done`. A row whose lane is closed or unregistered is dropped. A crash between the
 * effect and the mark repeats the effect: the journal dedupes the event by id, and a thread post may show twice.
 * Returns one log line per routed row.
 */
export const routeReports = async (deps: FlowDeps, store: LaneReportStore, enqueue: ReportEnqueue, home = process.env.HOME ?? ""): Promise<string[]> => {
  const out: string[] = [];
  for (const report of store.pending()) {
    const lane = await deps.registry.read(report.lane);
    let route: ReportRoute;
    if (!lane || statusOf(lane) === "closed") {
      route = "dropped";
    } else if (report.kind === "done") {
      await claimDone(deps, lane, oneLine(report.evidence ?? report.text));
      route = "claim";
    } else if (report.kind === "progress" && deps.config.hooks.threadReply && lane.thread !== "none") {
      const posted = await deps.run(fill(deps.config.hooks.threadReply, { thread: lane.thread, text: scrubForThread(oneLine(report.text), home), key: lane.key }));
      if (posted.code === 0) route = "thread";
      else {
        const error = (posted.err || posted.out || `exit ${posted.code}`).replace(/\s+/g, " ").slice(0, 160);
        await enqueue(`lane-report:${report.id}`, `${reportLine(report)} (thread post failed: ${error})`);
        route = "journal";
      }
    } else {
      await enqueue(`lane-report:${report.id}`, reportLine(report));
      route = "journal";
    }
    // A routed report is the lane being heard, like a thread reply: freshness neither nudges it nor raises NO-REPORT.
    if (route !== "dropped") await deps.registry.patch(report.lane, { lastReplyAt: deps.clock.now() });
    store.consume(report.id, deps.clock.now(), route);
    out.push(`LANE_REPORT_ROUTED ${report.id} ${report.kind} ${route}`);
  }
  return out;
};

/** How many lead-pane lines the violation sweep reads: more than one screen, so a line is seen before it scrolls away. */
export const LEAD_PANE_LINES = 200;

/** Every `[REPORT] <key> | <kind> | <text>` line of `key` in the lead's pane, wherever it sits on the line (input box, quote). */
export const leadPaneReportLines = (screen: string, key: string): string[] => {
  const shape = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| \\w+ \\| (?!<)\\S.*$`);
  return screen.split("\n").flatMap((l) => { const m = shape.exec(l); return m ? [m[0].trimEnd()] : []; });
};

const lineHash = (line: string): string => createHash("sha256").update(line).digest("hex").slice(0, 16);

/**
 * The lead-pane ban is a brief rule, not a technical one (design 3.3): a lane can still type into the lead's pane. Each
 * distinct [REPORT] line of an open `reportVia: cli` lane found in the lead's pane is counted once on that lane
 * (`leadPaneViolations`) and announced as a digest `LANE_PANE_VIOLATION <key> <count> <line>`. Lanes on the old footer
 * report into the lead's pane by design and are never counted. No such lane open, or no leadPane: nothing is read.
 */
export const leadPaneViolationTick = async (deps: FlowDeps, emit: Emit): Promise<void> => {
  if (!deps.config.leadPane) return;
  const lanes = (await deps.registry.open()).filter((lane) => lane.reportVia === "cli" && statusOf(lane) !== "closed");
  if (!lanes.length) return;
  const screen = await readScreen(deps.run, deps.config.leadPane, LEAD_PANE_LINES);
  for (const lane of lanes) {
    let seen = lane.leadPaneSeen ?? [];
    let count = lane.leadPaneViolations ?? 0;
    const found: string[] = [];
    for (const line of leadPaneReportLines(screen, lane.key)) {
      const hash = lineHash(line);
      if (seen.some((s) => s.hash === hash)) continue;
      seen = [...seen, { hash, at: new Date(deps.clock.now()).toISOString() }].slice(-REMOTE_SEEN_MAX);
      count++;
      found.push(`${count} ${oneLine(line)}`);
    }
    if (!found.length) continue;
    // Saved before the events: a crash in between loses an announcement, never repeats a count.
    await deps.registry.patch(lane.key, { leadPaneSeen: seen, leadPaneViolations: count });
    for (const numbered of found) await emit(`LANE_PANE_VIOLATION ${lane.key} ${numbered}`);
  }
};
