import { randomUUID } from "node:crypto";

import type { FlowDeps } from "./done-flow.ts";
import { laneRunner, readScreen, sendVerified, statusLookup } from "./panes.ts";
import type { QuotaLane } from "./quota-stall.ts";
import { type Lane, type LaneStatus, statusOf, withStatus } from "./registry.ts";
import { passthroughView, type SweepView } from "./sweep-view.ts";

/**
 * One state for "wait": a paused lane is skipped by the freshness sweep and its agent's goal is paused,
 * so neither a nudge nor goal continuation wakes it until it is resumed (issue #11). The lane is marked
 * paused only once the pane shows the goal paused: a silenced lane whose goal still runs is the bug itself.
 */
export type PauseResult = { readonly lane: Lane; readonly lines: readonly string[]; readonly code: 0 | 2 | 3 };
/** `resuming`: the claim of a resume whose goal command is in flight; a pause in the meantime removes it. */
type ResumingLane = Lane & { readonly resuming?: string };

const PAUSABLE: ReadonlySet<LaneStatus> = new Set(["working", "not-done"]);
// What the goal command prints (senpi goal/command-registration.ts): its new status, or that there is no goal,
// in which case nothing can auto-continue either.
// Whole lines only, so a lane's own output that merely mentions them does not count. omo prints the no-goal
// reply with an "Error: " prefix (issue #23); only that reply may carry it.
const PAUSED_SHOWN = /^\s*(?:Goal paused|(?:Error:\s*)?cannot update goal: no goal exists)\s*$/gm;
const RESUMED_SHOWN = /^\s*(?:Goal active|(?:Error:\s*)?cannot update goal: no goal exists)\s*$/gm;
const READ_BACK_TRIES = 8;

const count = (screen: string, shown: RegExp): number => screen.match(shown)?.length ?? 0;

/** Sends a goal command and confirms it from the screen: one more matching line than before it was sent. */
const goalCommand = async (deps: FlowDeps, pane: string, text: string, shown: RegExp): Promise<"confirmed" | "unconfirmed" | "failed"> => {
  const before = count(await readScreen(deps.run, pane, 200), shown);
  if ((await sendVerified(deps.run, deps.clock, pane, text)) === "failed") return "failed";
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (count(await readScreen(deps.run, pane, 200), shown) > before) return "confirmed";
    await deps.clock.sleep(700);
  }
  return "unconfirmed";
};

/**
 * Escape, then reads the pane back until its turn has stopped. A paused lane can still be woken (a background result,
 * a monitor event, a queued message), so stopping is confirmed, never assumed; a failed status lookup confirms nothing.
 */
const stopTurn = async (deps: FlowDeps, pane: string): Promise<boolean> => {
  await deps.run(["herdr", "pane", "send-keys", pane, "escape"]);
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    const after = await statusLookup(deps.run, pane);
    if (!after.error && after.status !== "working") return true;
    await deps.clock.sleep(700);
  }
  return false;
};

const isWorking = async (deps: FlowDeps, pane: string): Promise<boolean> => (await statusLookup(deps.run, pane)).status === "working";

/** The status a paused lane had before its pause. */
const beforePause = (lane: Lane): LaneStatus => (lane.pausedFrom && PAUSABLE.has(lane.pausedFrom) ? lane.pausedFrom : "working");

export const pauseLane = async (deps: FlowDeps, lane: Lane, note: string, automatic = false): Promise<PauseResult> => {
  deps = { ...deps, run: laneRunner(deps.run, lane) };
  const status = statusOf(lane);
  if (status === "paused") {
    if (automatic) return { lane, lines: [`PAUSED ${lane.key} already`], code: 0 };
    const fields: Partial<QuotaLane> & Pick<ResumingLane, "resuming"> = { quotaAutoPaused: undefined, quotaPending: undefined, resuming: undefined };
    let interrupted = false;
    lane = await deps.registry.update(lane.key, (current) => {
      if (!current || statusOf(current) !== "paused") return undefined;
      interrupted = (current as ResumingLane).resuming !== undefined;
      return withStatus({ ...current, ...fields }, "paused", note, new Date(deps.clock.now()).toISOString());
    }) ?? lane;
    if (lane.pane && !interrupted && (await isWorking(deps, lane.pane))) {
      // Paused but woken since: a repeat pause stops the turn again.
      return (await stopTurn(deps, lane.pane))
        ? { lane, lines: [`PAUSED ${lane.key} already; its running turn was interrupted again`], code: 0 }
        : { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} paused, but its running turn did not stop after Escape`], code: 3 };
    }
    if (!interrupted || !lane.pane) return { lane, lines: [`PAUSED ${lane.key} already`], code: 0 };
    // A resume was in flight: its `/goal resume` may already have run, and the resumer may die before its commit
    // pauses the goal again. Pause it here too (outside the lock; a second `/goal pause` is harmless).
    const goal = await goalCommand(deps, lane.pane, "/goal pause", PAUSED_SHOWN);
    return goal === "confirmed"
      ? { lane, lines: [`PAUSED ${lane.key} already; a resume in flight was stopped, goal paused`], code: 0 }
      : { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} a resume was in flight; /goal pause ${goal}; lane left paused`], code: 3 };
  }
  if (!PAUSABLE.has(status)) return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}, not working`], code: 2 };
  if (!lane.pane) return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} has no pane, so its goal cannot be paused`], code: 3 };
  // The goal first: stopping the running turn must not hand off to a goal continuation.
  const goal = await goalCommand(deps, lane.pane, "/goal pause", PAUSED_SHOWN);
  if (goal !== "confirmed") return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} /goal pause ${goal}; lane left ${status}`], code: 3 };
  const at = new Date(deps.clock.now()).toISOString();
  let paused: Lane = lane;
  await deps.registry.update(lane.key, (current) => {
    const fresh: QuotaLane = current ?? lane;
    if (automatic && (!fresh.quotaAutoPaused || fresh.quotaPending !== "pausing")) return undefined;
    const fields: Partial<QuotaLane> = automatic ? {} : { quotaAutoPaused: undefined, quotaPending: undefined };
    return (paused = withStatus({ ...fresh, ...fields }, "paused", note, at, { pausedFrom: status, pausedSeenWorking: undefined, lastFreshnessNote: undefined }));
  });
  const running = await isWorking(deps, lane.pane);
  if (running && !(await stopTurn(deps, lane.pane))) {
    // The goal is paused, so the lane stays paused and the freshness sweep keeps interrupting it.
    return { lane: paused, lines: [`PAUSE_UNVERIFIED ${lane.key} goal paused, but its running turn did not stop after Escape; lane left paused`], code: 3 };
  }
  return { lane: paused, lines: [`PAUSED ${lane.key} goal paused${running ? ", running turn interrupted" : ""}`], code: 0 };
};

/**
 * Resume in three steps so the lane lock is never held across pane I/O (a goal command can take many seconds, longer
 * than another writer waits for the lock): claim the paused lane under the lock, send `/goal resume` outside it, then
 * commit under the lock only if the claim still stands. A pause (or a change of `owns`) in the meantime wins: the
 * lane stays paused and its goal is paused again. A newer resume's claim makes this one step aside.
 */
export const resumeLane = async (deps: FlowDeps, lane: Lane, note: string, owns?: (current: Lane) => boolean): Promise<PauseResult> => {
  deps = { ...deps, run: laneRunner(deps.run, lane) };
  const token = randomUUID();
  let result: PauseResult = { lane, lines: [`NOT_RESUMED ${lane.key} ownership changed`], code: 2 };
  const claimed: ResumingLane | null = await deps.registry.update(lane.key, (current) => {
    const fresh = current ?? lane;
    if (owns && (!current || !owns(current))) return undefined;
    if (statusOf(fresh) !== "paused") {
      result = { lane: fresh, lines: [`NOT_RESUMED ${lane.key} is ${statusOf(fresh)}, not paused`], code: 2 };
      return undefined;
    }
    if (!fresh.pane) {
      result = { lane: fresh, lines: [`RESUME_UNVERIFIED ${lane.key} has no pane, so its goal cannot be resumed`], code: 3 };
      return undefined;
    }
    const claim: ResumingLane = { ...fresh, resuming: token };
    return claim;
  });
  if (!claimed?.pane || claimed.resuming !== token) return result;
  const ours = (current: Lane | null): current is ResumingLane => !!current && (current as ResumingLane).resuming === token;
  const goal = await goalCommand(deps, claimed.pane, "/goal resume", RESUMED_SHOWN);
  if (goal !== "confirmed") {
    await deps.registry.update(lane.key, (current) => (ours(current) ? { ...current, resuming: undefined } as ResumingLane : undefined));
    return { lane: claimed, lines: [`RESUME_UNVERIFIED ${lane.key} /goal resume ${goal}; lane left paused`], code: 3 };
  }
  let repause = false;
  await deps.registry.update(lane.key, (current) => {
    if (!current || statusOf(current) !== "paused") {
      result = { lane: current ?? claimed, lines: [`NOT_RESUMED ${lane.key} is ${current ? statusOf(current) : "gone"}, not paused`], code: 2 };
      return undefined;
    }
    const other = (current as ResumingLane).resuming;
    if (!ours(current) || (owns && !owns(current))) {
      // Paused again meanwhile (the claim is gone or ownership moved): that pause stands. A newer resume owns the goal.
      repause = other === undefined || other === token;
      return other === token ? { ...current, resuming: undefined } as ResumingLane : undefined;
    }
    const now = deps.clock.now();
    // Quiet time starts again at the resume: a long pause must not turn into an instant nudge.
    const resumed = withStatus({ ...current, resuming: undefined } as ResumingLane, beforePause(current), note, new Date(now).toISOString(), { lastReplyAt: now, pausedFrom: undefined, pausedSeenWorking: undefined, lastFreshnessNote: undefined });
    result = { lane: resumed, lines: [`RESUMED ${lane.key} as ${statusOf(resumed)}, goal resumed`], code: 0 };
    return resumed;
  });
  if (repause) {
    const again = await goalCommand(deps, claimed.pane, "/goal pause", PAUSED_SHOWN);
    result = { lane: (await deps.registry.read(lane.key)) ?? claimed, lines: [`NOT_RESUMED ${lane.key} was paused again during the resume; /goal pause ${again}`], code: 2 };
  }
  return result;
};

export type PausedCheck = { readonly lane: Lane; readonly outcome: "working-while-paused"; readonly stopped: boolean } | null;

/**
 * Resume is explicit only: `dori resume`, on the owner's word. Activity never ends a pause, because a paused
 * lane can still be woken (a background result, a monitor event, a queued message) and its owner said wait.
 * Every tick that finds a paused lane working interrupts it again (Escape, read back). It is reported when it
 * was working on two ticks in a row, or at once when Escape did not stop it; it stays paused.
 */
export const checkPausedLane = async (deps: FlowDeps, lane: Lane, view: SweepView = passthroughView(deps.run)): Promise<PausedCheck> => {
  if (statusOf(lane) !== "paused" || !lane.pane) return null;
  const working = (await view.status(lane)).status === "working";
  if (!working) {
    // Idle again: the next working stretch is new information and is reported again.
    if (lane.pausedSeenWorking || lane.lastFreshnessNote) {
      await deps.registry.patch(lane.key, (current) => (statusOf(current) === "paused" ? { pausedSeenWorking: undefined, lastFreshnessNote: undefined } : undefined));
    }
    return null;
  }
  const stopped = await stopTurn({ ...deps, run: laneRunner(deps.run, lane) }, lane.pane);
  if (!lane.pausedSeenWorking && stopped) {
    await deps.registry.patch(lane.key, (current) => (statusOf(current) === "paused" ? { pausedSeenWorking: true } : undefined));
    return null;
  }
  return { lane, outcome: "working-while-paused", stopped };
};
