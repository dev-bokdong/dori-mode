import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { eventClass, forLead } from "./event-policy.ts";
import type { Registry } from "./registry.ts";
import type { Event, Journal, JournalCore, LaneOutcome } from "./supervise-journal.ts";

/**
 * Lane outcome reports: "a lane finished, so the owner is told", enforced the way owner messages are (ack, handled,
 * UNHANDLED). A finished lane (LANE_CLOSED <key>, or CI_MERGED ... lane=<key>) opens one report obligation per lane key;
 * the lead tells the owner itself and then records `dori reported <key>`, an immutable receipt the supervisor consumes.
 * An obligation still open after reportTimeoutMin comes back as urgent `UNREPORTED <key> ...`, re-sent with backoff; in
 * push mode it also keeps the lead pushed and counts toward the push escalation. The supervisor never posts the report.
 */

export const REPORTED_DIR = "reported";
/** The open obligations as the supervisor last saw them, for readers without its store (`dori inbox take`). */
export const UNREPORTED_FILE = "unreported.json";
/** Reminders after the first wait reportTimeoutMin, then twice as long each time, up to this. */
export const REPORT_REPEAT_MAX_MS = 60 * 60_000;
/** A reported outcome is kept this long, so a later outcome event of the same lane stays deduplicated. */
export const REPORTED_KEEP_MS = 7 * 24 * 60 * 60_000;
export const OUTCOME_LINE_MAX = 300;

const LANE_KEY = /^[\w.-]+$/;
const RECEIPT_FILE = /^\d+-[\w-]+\.json$/;

export class ReportedError extends Error {}

/** The lane a finished-lane event names: `LANE_CLOSED <key> ...` or `CI_MERGED ... lane=<key> ...`. */
export const outcomeLane = (line: string): string | undefined => {
  const lane = line.startsWith("LANE_CLOSED ") ? line.split(" ")[1] : line.startsWith("CI_MERGED ") ? / lane=(\S+)/.exec(line)?.[1] : undefined;
  return lane && LANE_KEY.test(lane) ? lane : undefined;
};

const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** The lead's receipt that it told the owner about lane `lane`'s outcome: tmp, fsync, rename, then both directories. */
export const recordReported = (stateDir: string, lane: string, at: number, note?: string): string => {
  if (!LANE_KEY.test(lane)) throw new ReportedError("usage: dori reported <key> [--note TEXT] (a lane key)");
  const dir = join(stateDir, REPORTED_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${at}-${randomUUID()}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lane, at, ...(note ? { note } : {}) }), { mode: 0o600, flush: true });
  renameSync(tmp, path);
  fsyncDir(dir);
  fsyncDir(stateDir);
  return path;
};

export type ReportedReceipt = { readonly path: string; readonly lane: string; readonly at: number; readonly note?: string };

/** Receipts waiting for the supervisor; unreadable or malformed files are skipped (and never dropped). */
export const pendingReported = (stateDir: string): ReportedReceipt[] => {
  const dir = join(stateDir, REPORTED_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((name) => RECEIPT_FILE.test(name)).flatMap((name) => {
    const path = join(dir, name);
    try {
      const { lane, at, note } = JSON.parse(readFileSync(path, "utf8")) as { lane?: unknown; at?: unknown; note?: unknown };
      if (typeof lane !== "string" || !LANE_KEY.test(lane)) return [];
      return [{
        path, lane, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs,
        ...(typeof note === "string" && note ? { note } : {}),
      }];
    } catch { return []; }
  });
};

const dropReported = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};

export const unreported = (journal: Journal): LaneOutcome[] => (journal.outcomes ?? []).filter((outcome) => outcome.reportedAt === undefined);

export const reportRule = (lane: string): string => `report the outcome to the owner yourself, then run dori reported ${lane}`;

/** One line per open obligation for the cold-restart handoff, empty when there is none. */
export const handoffLines = (journal: Journal): string[] => {
  const owed = unreported(journal);
  if (!owed.length) return [];
  return [
    "Lane outcomes not yet reported to the owner follow: for each, report the outcome to the owner yourself, then run dori reported <key>.",
    ...owed.map((outcome) => `UNREPORTED ${outcome.lane} ${outcome.line ?? ""}`.trimEnd()),
  ];
};

type Published = { readonly lane: string; readonly since: number; readonly line?: string };

/** `dori inbox take`'s reminder lines (id<TAB>line, like the events) from the supervisor's published obligations. */
export const takeReminders = (stateDir: string): string[] => {
  let list: unknown;
  try { list = JSON.parse(readFileSync(join(stateDir, UNREPORTED_FILE), "utf8")); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: Partial<Published>) => typeof item?.lane === "string" && LANE_KEY.test(item.lane) && typeof item.since === "number"
    ? [`unreported:${item.lane}\tUNREPORTED ${item.lane} since ${new Date(item.since).toISOString()}: ${reportRule(item.lane)}`]
    : []);
};

export class OutcomeTracking {
  private published?: string;

  constructor(private readonly core: JournalCore, private readonly enqueue: (id: string, line: string) => void) {}

  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }
  private get windowMs(): number { return this.core.deps.config.reportTimeoutMin * 60_000; }

  /**
   * A live event that finishes a lane opens its obligation; another one for the same lane (CI_MERGED, then LANE_CLOSED)
   * joins it, so one closed lane is one report. Only an event that reaches the lead counts. The caller persists.
   */
  track(event: Event): void {
    const lane = outcomeLane(event.line);
    if (!lane || !forLead(eventClass(event.line, this.core.deps.config.eventPolicy))) return;
    const outcomes = this.journal.outcomes ?? [];
    const at = outcomes.findIndex((outcome) => outcome.lane === lane);
    const line = event.line.slice(0, OUTCOME_LINE_MAX);
    const found = at < 0 ? undefined : outcomes[at];
    if (found?.events?.includes(event.id)) return;
    const next: LaneOutcome = found
      ? { ...found, line: found.line ?? line, events: [...(found.events ?? []), event.id] }
      : { lane, since: event.at ?? this.core.deps.clock.now(), line, events: [event.id] };
    this.journal = { ...this.journal, outcomes: at < 0 ? [...outcomes, next] : outcomes.map((outcome, i) => (i === at ? next : outcome)) };
  }

  /**
   * `dori reported` receipts close their lane's obligation; one for a lane with none yet (reported before its outcome
   * event arrived) is kept, so that event opens nothing. Persisted before the receipts are dropped: a replay only takes
   * the earliest report time again.
   */
  consumeReceipts(): void {
    const receipts = pendingReported(this.core.deps.config.stateDir);
    if (!receipts.length) return;
    const outcomes = [...(this.journal.outcomes ?? [])];
    for (const receipt of receipts) {
      const at = outcomes.findIndex((outcome) => outcome.lane === receipt.lane);
      const found = at < 0 ? undefined : outcomes[at];
      const note = found?.note ?? receipt.note;
      const next: LaneOutcome = {
        ...(found ?? { lane: receipt.lane, since: receipt.at }),
        reportedAt: Math.min(found?.reportedAt ?? Infinity, receipt.at),
        ...(note ? { note } : {}),
      };
      if (at < 0) outcomes.push(next); else outcomes[at] = next;
      if (found?.reportedAt === undefined) console.log(`LANE_OUTCOME_REPORTED ${receipt.lane}`);
    }
    this.journal = { ...this.journal, outcomes };
    this.core.persist();
    for (const receipt of receipts) dropReported(receipt.path);
    this.publish();
  }

  /** Open obligations whose first window has passed: they keep a pushed lead pushed (supervise-push.ts). */
  due(now: number): LaneOutcome[] {
    return unreported(this.journal).filter((outcome) => now - outcome.since >= this.windowMs);
  }

  /** The first pointer that carried an obligation starts its escalation clock (no escalation before a pointer, N1). */
  markPushed(lanes: readonly string[], now: number): void {
    const want = new Set(lanes);
    if (!(this.journal.outcomes ?? []).some((outcome) => want.has(outcome.lane) && outcome.pushedAt === undefined)) return;
    this.journal = {
      ...this.journal,
      outcomes: this.journal.outcomes?.map((outcome) => (want.has(outcome.lane) && outcome.pushedAt === undefined ? { ...outcome, pushedAt: now } : outcome)),
    };
    this.core.persist();
  }

  /**
   * One pass: receipts first, then each open obligation past its window gets one urgent UNREPORTED (the first after
   * reportTimeoutMin, then after twice the previous wait, up to REPORT_REPEAT_MAX_MS). A lane whose brief declared
   * `autoClose: machine` closes with no lead wake and owes no report. Nothing is reminded while a lead restart runs: the
   * new lead's handoff lists every open obligation. Reported rows are dropped after REPORTED_KEEP_MS.
   */
  async tick(registry: Pick<Registry, "read">): Promise<void> {
    this.consumeReceipts();
    if (this.journal.restart) return;
    const now = this.core.deps.clock.now();
    const window = this.windowMs;
    let changed = false;
    const outcomes: LaneOutcome[] = [];
    for (const outcome of this.journal.outcomes ?? []) {
      if (outcome.reportedAt !== undefined) {
        if (now - outcome.reportedAt >= REPORTED_KEEP_MS) changed = true;
        else outcomes.push(outcome);
        continue;
      }
      const reminders = outcome.reminders ?? 0;
      const wait = reminders === 0 ? window : Math.min(window * 2 ** (reminders - 1), Math.max(REPORT_REPEAT_MAX_MS, window));
      if (now - (outcome.remindedAt ?? outcome.since) < wait) { outcomes.push(outcome); continue; }
      if (reminders === 0 && (await registry.read(outcome.lane))?.autoClose === "machine") {
        outcomes.push({ ...outcome, reportedAt: now, note: "autoClose: machine" });
        changed = true;
        continue;
      }
      const minutes = Math.round((now - outcome.since) / 60_000);
      this.enqueue(`unreported:${outcome.lane}:${outcome.since}:${reminders + 1}`,
        `UNREPORTED ${outcome.lane} finished ${minutes} min ago and the owner has not been told: ${reportRule(outcome.lane)}. ${outcome.line ?? ""}`.trimEnd());
      outcomes.push({ ...outcome, reminders: reminders + 1, remindedAt: now });
      changed = true;
    }
    if (changed) {
      this.journal = { ...this.journal, outcomes };
      this.core.persist("normal");
    }
    this.publish();
  }

  /** Writes UNREPORTED_FILE when the open obligations changed (tmp + rename; it is derived, the store is the record). */
  publish(): void {
    const list: Published[] = unreported(this.journal).map(({ lane, since, line }) => ({ lane, since, ...(line ? { line } : {}) }));
    const text = JSON.stringify(list);
    if (text === this.published) return;
    const path = join(this.core.deps.config.stateDir, UNREPORTED_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    this.published = text;
  }
}
