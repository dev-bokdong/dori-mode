import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { LaneReportStore } from "./lane-reports.ts";
import { checkPausedLane } from "./pause.ts";
import { laneRunner, sendVerified } from "./panes.ts";
import { extractProgress, progressLine } from "./progress.ts";
import { type Lane, statusOf } from "./registry.ts";
import { passthroughView, type SweepView } from "./sweep-view.ts";

/** Every [REPORT] line of `key` on `screen`, top to bottom. */
export const reportLines = (screen: string, key: string): string[] => {
  // A payload starting with "<" is the footer's own placeholder ("<what, with links>", "<merge SHA, ...>"), never a report.
  // Anchored to the whole line: only indentation or the agent's own message bullet may precede it, so a [REPORT]
  // shape inside command output, a log line, a quote or a tool-output box ("│", "⎿") is never read as a report.
  const grammar = new RegExp(`^\\s*(?:[●⏺•]\\s+)?\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|done) \\| (?!<)\\S.*$`);
  const hits = screen.split("\n").flatMap((l) => (grammar.test(l) ? [l.slice(l.indexOf("[REPORT]"))] : []));
  return hits.map((hit) => hit.replace(/["'\])\s,]+$/, ""));
};

export const lastReportLine = (screen: string, key: string): string | null => reportLines(screen, key).at(-1) ?? null;

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

export type SweepAct = { readonly kind: "nudged" | "progress" | "progress-failed" | "no-progress" | "posted" | "no-report" | "pending-report" | "stale-report" | "working-while-paused"; readonly lane: string; readonly detail: string };

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

/** The time of each lane's newest report row (any kind), read once per tick. */
const lastRowAt = (reports: LaneReportStore): Map<string, number> => {
  const at = new Map<string, number>();
  for (const row of reports.list()) at.set(row.lane, Math.max(at.get(row.lane) ?? row.at, row.at));
  return at;
};

/**
 * With `reports`, a lane's report rows are its progress: the router already posts them, so a working
 * lane with a row newer than nudgeAfterMin costs no herdr call at all. Its pane is read (todo item, nudge, last
 * [REPORT] line) only once no row arrived within nudgeAfterMin, counted from its newest row or reply.
 */
export const freshnessTick = async (deps: FlowDeps, home: string, view: SweepView = passthroughView(deps.run), reports?: LaneReportStore): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  let rows: Map<string, number> | undefined;
  for (const lane of await deps.registry.open()) {
    const run = laneRunner(deps.run, lane);
    if (statusOf(lane) === "paused") {
      const checked = await checkPausedLane(deps, lane, view);
      if (checked && checked.lane.lastFreshnessNote !== "working-while-paused") {
        // Reported once per working stretch (the note clears when the lane goes idle), so the lead can ask; it stays paused.
        await deps.registry.patch(lane.key, (fresh) => (statusOf(fresh) === "paused" ? { lastFreshnessNote: "working-while-paused" } : undefined));
        const interrupt = checked.stopped ? "re-interrupted, its turn stopped" : "PAUSE_UNVERIFIED: Escape did not stop its turn";
        acts.push({ kind: "working-while-paused", lane: lane.key, detail: `paused lane was woken and is working; ${interrupt}; left paused (resume is dori resume only)` });
      }
      continue;
    }
    // A lane stalled on quota cannot answer a nudge; the quota sweep owns it until LANE_QUOTA_CLEARED.
    if (statusOf(lane) !== "working" || !lane.pane || lane.recoveryPending || lane.lastQuotaStall) continue;
    if (reports) rows ??= lastRowAt(reports);
    const rowAt = rows?.get(lane.key);
    if (rowAt !== undefined && now - rowAt < deps.config.nudgeAfterMin * 60_000) continue;
    const heard = Math.max(lastHeard(lane), rowAt ?? -Infinity);
    const silentMin = Math.round((now - heard) / 60_000);
    let current = lane;
    // Only this sweep's own fields are written, onto the fresh lane: a pause, objection or claim made meanwhile stands.
    const save = async (fields: Partial<Lane>): Promise<void> => {
      current = { ...current, ...fields };
      await deps.registry.patch(lane.key, fields);
    };
    const hook = deps.config.hooks.threadReply;
    if (silentMin >= deps.config.nudgeAfterMin) {
      // herdr's own status decides. A working lane is never interrupted: its pane is read (no LLM turn) and the todo item is posted for it.
      if ((await view.status(lane)).status === "working") {
        const progress = extractProgress(await view.screen(lane, 60));
        if (progress && hook && lane.thread !== "none") {
          const line = progressLine(progress, (s) => scrubForThread(s, home), deps.config.progressTemplate);
          // A new item posts at once; an unchanged one again every nudgeAfterMin, so a long step still shows life.
          if (line.key !== current.lastProgressPost || now - (current.lastProgressAt ?? 0) >= deps.config.nudgeAfterMin * 60_000) {
            const posted = await deps.run(fill(hook, { thread: lane.thread, text: line.text, key: lane.key }));
            if (posted.code === 0) {
              await save({ lastProgressPost: line.key, lastProgressAt: now, lastProgressError: undefined });
              acts.push({ kind: "progress", lane: lane.key, detail: line.text });
            } else {
              // Nothing is saved as posted, so the next tick tries again; the same error is reported once.
              const error = (posted.err || posted.out || `exit ${posted.code}`).replace(/\s+/g, " ").slice(0, 160);
              if (error !== current.lastProgressError) {
                await save({ lastProgressError: error });
                acts.push({ kind: "progress-failed", lane: lane.key, detail: `thread hook failed: ${error}` });
              }
            }
          }
        } else if (lane.thread !== "none" && (current.lastNudgeAt ?? 0) < heard) {
          // Nothing can be posted for it (no Todo item on its pane, or no thread hook), and a working lane is not
          // interrupted: the lead hears once per silence and decides.
          await save({ lastNudgeAt: now });
          acts.push({ kind: "no-progress", lane: lane.key, detail: `${silentMin} min without a thread update while working; ${progress ? "no threadReply hook to post its todo" : "its pane shows no Todo item to post"}` });
        }
      } else if ((current.lastNudgeAt ?? 0) < heard) {
        const delivery = await sendVerified(run, deps.clock, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
        await save({ lastNudgeAt: now });
        acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery ${delivery}` });
      }
    }
    if (silentMin >= deps.config.postAfterMin && hook && lane.thread !== "none" && (current.lastAutoReplyAt ?? 0) < heard) {
      const report = lastReportLine(await view.screen(lane, 200), lane.key);
      // The two reads are a full loop interval apart: a line counts only once it is still there on the next tick.
      const seenBefore = current.lastSeenReport;
      const lastSeenReport = report ?? undefined;
      current = { ...current, lastSeenReport };
      let hold: { kind: SweepAct["kind"]; detail: string } | null = null;
      if (!report) hold = { kind: "no-report", detail: "pane has no [REPORT] line" };
      else if (report !== seenBefore) hold = { kind: "pending-report", detail: "a new [REPORT] line; posting once it holds on the next tick" };
      else if (report === current.lastPostedReport) hold = { kind: "stale-report", detail: "the last [REPORT] line was already posted" };
      if (hold) {
        const note = `${hold.kind}|${hold.detail}|${report ?? ""}`;
        if (note !== current.lastFreshnessNote) acts.push({ kind: hold.kind, lane: lane.key, detail: hold.detail });
        await save({ lastSeenReport, lastFreshnessNote: note });
        continue;
      }
      const text = `Progress (from the lane's last report): ${scrubForThread(report ?? "", home)}`;
      await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      await save({ lastSeenReport, lastAutoReplyAt: now, lastPostedReport: report ?? undefined, lastFreshnessNote: undefined });
      acts.push({ kind: "posted", lane: lane.key, detail: text });
    }
  }
  return acts;
};
