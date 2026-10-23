import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type DoriConfig, fill } from "./config.ts";
import { type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Ran, type Runner } from "./run.ts";
import { reportLines } from "./freshness.ts";
import { laneRunner, listPanes, readScreen, sendVerified } from "./panes.ts";
import { OPEN_STATES, openOperations, operationId, type OperationState, type OperationStore, perform, plan, type ReadBack, settleOperation } from "./operations.ts";
import { acquireStateLock, StateLockError, tryStateLock } from "./state-lock.ts";
import { passthroughView, type SweepView } from "./sweep-view.ts";
import { checkDone, type SignalIo } from "./signals.ts";
import { BRANCH_DELETE, type BranchPlan, deleteBranch, planBranchCleanup, readBindings, readBranchBindings } from "./branch-cleanup.ts";
import { otherOpenLanesOnThread } from "./routing.ts";
import type { Discord } from "./messenger/discord.ts";
import { type Platform, resolveTarget, type Target } from "./messenger/target.ts";
import { eventClass } from "./event-policy.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
  /** The operation rows; absent opens the configured store per call. */
  readonly operations?: OperationStore;
  /** Discord threads for the close's thread archive; absent (no DORI_DISCORD_TOKEN) skips the archive with a receipt line. */
  readonly discord?: Pick<Discord, "setThread" | "threadArchived">;
  /**
   * The supervisor's answer to "has the lead received this journaled event" (a claim's window start). Absent (`dori watch`,
   * which hands its lines to stdout) an event counts as received once it is handed over.
   */
  readonly leadDelivered?: (eventId: string) => boolean;
};

/** Signals run on this host: a remote lane's cwd (older entries stored the remote path there) is never a local directory. */
const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: (lane.machine ? undefined : lane.cwd) ?? deps.config.defaultCwd, ...deps.signalIo });

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

/** A lane that claims and closes with no lead wake: its brief declared `autoClose: machine`. */
const machineClose = (lane: Lane): boolean => lane.autoClose === "machine";

/**
 * Whether the claim's window waits for the lead to receive it: only when the policy makes LANE_DONE_CLAIMED wake the
 * lead. By default it is digest: the supervisor settles the claim itself (live re-check, then close or LANE_NOT_DONE),
 * so the window runs from the hand-over.
 */
const claimWaitsForLead = (deps: FlowDeps, lane: Lane): boolean =>
  !machineClose(lane) && eventClass(`LANE_DONE_CLAIMED ${lane.key}`, deps.config.eventPolicy) === "lead-urgent";

/** The journal id of a claim's announcement: stable, so a repeated announcement after a crash is the same event. */
export const claimEventId = (key: string, claimAt: string): string => `done-claim:${key}:${claimAt}`;

export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  deps = { ...deps, run: laneRunner(deps.run, lane) };
  const at = iso(deps.clock);
  await deps.registry.update(lane.key, (current) => withStatus(current ?? lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false } }));
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    const when = claimWaitsForLead(deps, lane)
      ? `${deps.config.closeAfterMin} minutes after the lead receives this claim`
      : `at ${closesAt}Z (${deps.config.closeAfterMin} minutes) once its Done signals read back live`;
    await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically ${when} unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}`;
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  deps = { ...deps, run: laneRunner(deps.run, lane) };
  const at = iso(deps.clock);
  await deps.registry.update(lane.key, (current) => withStatus(current ?? lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  // A remote lane claims by printing a [REPORT] line, and the watcher acts on each distinct line once. The payload
  // stays a <placeholder>: this text lands on the lane's own screen, where a real-looking line would read as a claim.
  const again = lane.machine ? `print a new [REPORT] ${lane.key} | done | <updated evidence> line when fixed` : "claim again when fixed";
  if (lane.pane) await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, ${again}`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  if (lane.machine) return [];
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  if (lane.machine) return [];
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  for (const wt of await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])) {
    if (!exists(wt)) continue;
    // Untracked files are work too (gitignored ones are not listed): a close would delete them with the worktree.
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=normal"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};

export type CloseOptions = {
  /** `dori close --force`: close despite unpushed/uncommitted work; a worktree git refuses to remove is kept, as before. */
  readonly force?: boolean;
};

/** The close sequence's own operation (its intent and resume data); its effects are separate operations of the lane. */
export const CLOSE_ACTION = "close";
const closeId = (key: string): string => operationId({ lane: key, action: CLOSE_ACTION, target: key });
/** Held for a whole close of one lane; a killed holder releases it, so a resumer can tell a live close. */
const closeLockPath = (deps: FlowDeps, key: string): string => join(deps.registry.dir, `${key}.close.lock.sqlite`);

const withOperations = async <T>(deps: FlowDeps, body: (store: OperationStore) => Promise<T>): Promise<T> => {
  const store = deps.operations ?? openOperations(deps.config);
  try { return await body(store); } finally { if (!deps.operations) store.close(); }
};

/** One effect's result for the close sequence: `err`/`out` are the effect's own output when it ran (today's receipt text). */
type Step = { readonly state: OperationState; readonly err: string; readonly out: string; readonly id?: string; readonly detail?: string };
type Act = (action: string, target: string, effect: () => Promise<Ran>, readBack: ReadBack) => Promise<Step>;

/** The effect runs at most once per verified operation, and a read-back decides (operations.ts). */
const actRecorded = (deps: FlowDeps, store: OperationStore, lane: Lane): Act => async (action, target, effect, readBack) => {
  let ran: Ran | undefined;
  const { op } = await perform(store, deps.clock.now, { lane: lane.key, action, target }, async () => {
    ran = await effect();
    return { ok: ran.code === 0, detail: ran.code === 0 ? "" : ran.err || ran.out };
  }, readBack);
  return { state: op.state, err: ran?.err ?? op.detail, out: ran?.out ?? "", id: op.id, detail: op.detail };
};

/** Gone from `herdr pane list` (on the lane's machine) is done; listed is not; an unreadable list cannot tell. */
const paneGone = (deps: FlowDeps, match: (pane: { readonly pane_id: string; readonly tab_id?: string }) => boolean): ReadBack => async () =>
  (await listPanes(deps.run)).some(match) ? "not-done" : "done";

/**
 * Close a lane: every Done signal must read back live, and (unless `force`) no worktree may hold unpushed, uncommitted
 * or untracked work. Worktrees are removed before the pane closes, so a failed removal leaves the lane and its pane up.
 * The thread is marked done only when no other open lane works in it.
 *
 * The close holds a per-lane lock, records its intent (a `close` operation with the note and
 * force flag) and runs every effect as an operation: a crash anywhere is resumed by `resumeOperations` without
 * repeating an effect, and an operation whose read-back cannot tell stops the close as OPERATION_AMBIGUOUS.
 */
export const closeLane = async (deps: FlowDeps, lane: Lane, note: string, opts: CloseOptions = {}): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  deps = { ...deps, run: laneRunner(deps.run, lane) };
  let release: () => void;
  try { release = await acquireStateLock(closeLockPath(deps, lane.key)); } catch (e) {
    if (e instanceof StateLockError) return { closed: false, lines: [`REFUSED ${lane.key}: another close of this lane is still running`] };
    throw e;
  }
  try {
    return await withOperations(deps, async (store) => {
      const id = closeId(lane.key);
      // A close that finished while this one waited for the lock (the CLI and the supervisor resuming the same lane).
      if (statusOf((await deps.registry.read(lane.key)) ?? lane) === "closed") {
        if (store.get(id)?.state === "planned") settleOperation(store, deps.clock.now(), id, "verified", "lane recorded closed");
        return { closed: true, lines: [`CLOSED ${lane.key} already closed`] };
      }
      const data = JSON.stringify({ note, force: Boolean(opts.force) });
      const prior = store.get(id);
      if (!prior) plan(store, deps.clock.now(), { lane: lane.key, action: CLOSE_ACTION, target: lane.key, data });
      else store.put({ ...prior, state: "planned", detail: "close planned", data, updatedAt: deps.clock.now() });
      const result = await closeSequence(deps, lane, note, opts, actRecorded(deps, store, lane), store);
      const now = deps.clock.now();
      if (result.closed) settleOperation(store, now, id, "verified", "lane recorded closed");
      else if (store.get(id)?.state === "planned") settleOperation(store, now, id, "failed", result.lines.at(-1) ?? "refused");
      return result;
    });
  } finally { release(); }
};

const closeSequence = async (
  deps: FlowDeps, lane: Lane, note: string, opts: CloseOptions, act: Act, store: OperationStore,
): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  if (!opts.force) {
    const unpushed = await unpushedWork(deps, lane);
    if (unpushed.length) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: ${unpushed.join("; ")} (commit and push it, or dori close --force)`] };
  }
  const cleanup: string[] = [];
  const ambiguous = (step: Step) => {
    settleOperation(store, deps.clock.now(), closeId(lane.key), "ambiguous", `stopped at ${step.id}`);
    return { closed: false, lines: [...lines, ...cleanup, `OPERATION_AMBIGUOUS ${step.id} ${step.detail}`,
      `REFUSED ${lane.key}: the close stopped at an operation that may or may not have happened; check it, run dori ops resolve ${step.id} --as verified|retry, then close again`] };
  };
  if (lane.machine) cleanup.push(remoteWorktreeNote(lane));
  const root = lane.cwd ?? deps.config.defaultCwd;
  // A worktree an interrupted close already removed is no longer discovered; its operation still has to settle.
  const pending = store.list({ lane: lane.key }).filter((op) => op.action === "worktree-remove" && op.state !== "verified").map((op) => op.target);
  const worktrees = [...new Set([...(await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists), ...pending])];
  // Bound before any worktree goes: a worktree whose branch moved past the merged head stays with its branch.
  // The lane's own cwd, when it is a linked worktree, goes too once it sits exactly at a PR merged into the merge base.
  const branches: BranchPlan | undefined = !lane.machine
    ? await planBranchCleanup(deps.run, lane, worktrees, root, store, deps.clock.now, exists, { base: deps.config.ciMergeBase, candidates: lane.cwd ? [lane.cwd] : [] })
    : undefined;
  cleanup.push(...(branches?.notes ?? []));
  const adopted = new Set(branches?.adopted ?? []);
  for (const wt of [...worktrees, ...adopted]) {
    const hold = branches?.holds.get(wt);
    if (hold) { cleanup.push(`branch-bound worktree ${wt} kept: ${hold}`); continue; }
    const step = await act("worktree-remove", wt, () => deps.run(["git", "-C", root, "worktree", "remove", wt]), async () => (exists(wt) ? "not-done" : "done"));
    if (step.state === "ambiguous") return ambiguous(step);
    // The lane's cwd was never checked for unpushed work: git refuses to remove it dirty, and it is kept, not a refusal.
    if (step.state !== "verified" && !opts.force && !adopted.has(wt)) {
      return { closed: false, lines: [...lines, ...cleanup, `REFUSED ${lane.key}: worktree ${wt} not removed: ${(step.err || step.out).slice(0, 120)}; the pane is left open (dori close --force keeps the worktree and closes)`] };
    }
    cleanup.push(step.state === "verified" ? `worktree ${wt} removed` : `worktree ${wt} kept: ${step.err.slice(0, 120)}`);
  }
  if (branches?.targets.length) {
    const others = (await deps.registry.open()).filter((l) => l.key !== lane.key);
    for (const target of branches.targets) {
      const r = await deleteBranch(deps.run, act, target, others);
      if (r.remoteStep?.state === "ambiguous") return ambiguous(r.remoteStep);
      if (r.step?.state === "ambiguous") return ambiguous(r.step);
      if (r.kept && r.step === undefined) settleOperation(store, deps.clock.now(), operationId({ lane: lane.key, action: BRANCH_DELETE, target: `${target.repo}#${target.n}@${target.sha}` }), "failed", `kept: ${r.kept}`);
      if (r.remoteLine) cleanup.push(r.remoteLine);
      cleanup.push(r.line);
    }
  }
  const hook = deps.config.hooks.threadDone;
  const sharing = otherOpenLanesOnThread(await deps.registry.open(), lane);
  if (sharing.length) cleanup.push(`thread kept open: lane ${sharing.map((l) => l.key).join(", ")} still works in it`);
  else if (lane.thread !== "none") {
    if (hook) {
      // A hook has no read-back: after a crash mid-hook it cannot be told whether the thread was marked, so that is ambiguous.
      const step = await act("thread-done", lane.thread, () => deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key })), async () => "unknown");
      if (step.state === "ambiguous") return ambiguous(step);
      cleanup.push(step.state === "verified" ? "thread marked done" : `thread hook failed: ${step.err.slice(0, 160)}`);
    }
    // After the hook: a post into an archived thread would reopen it.
    const thread = discordThreadId(lane.thread);
    if (thread && !deps.discord) cleanup.push("thread archive skipped: DORI_DISCORD_TOKEN is not set");
    else if (thread && deps.discord) {
      const discord = deps.discord;
      const archived: ReadBack = async () => ((await discord.threadArchived(thread)) ? "done" : "not-done");
      const step = await act("thread-archive", thread, async () => {
        try {
          await discord.setThread(thread, { archived: true });
          // The effect only counts once Discord reports it archived.
          return (await discord.threadArchived(thread)) ? { code: 0, out: "", err: "" } : { code: 1, out: "", err: "read back archived: false" };
        } catch (e) { return { code: 1, out: "", err: e instanceof Error ? e.message : String(e) }; }
      }, archived);
      if (step.state === "ambiguous") return ambiguous(step);
      cleanup.push(step.state === "verified" ? `thread ${thread} archived` : `thread ${thread} not archived: ${step.err.slice(0, 160)}`);
    }
  }
  if (lane.tab) {
    const tab = lane.tab;
    const step = await act("tab-close", tab, () => deps.run(["herdr", "tab", "close", tab]), paneGone(deps, (p) => p.tab_id === tab));
    if (step.state === "ambiguous") return ambiguous(step);
    cleanup.push(step.state === "verified" ? `tab ${tab} closed` : `tab ${tab} not closed`);
  } else if (lane.pane) {
    const pane = lane.pane;
    const step = await act("pane-close", pane, () => deps.run(["herdr", "pane", "close", pane]), paneGone(deps, (p) => p.pane_id === pane));
    if (step.state === "ambiguous") return ambiguous(step);
    cleanup.push(step.state === "verified" ? `pane ${pane} closed` : `pane ${pane} not closed`);
  }
  const at = iso(deps.clock);
  const operations = store.list({ lane: lane.key }).filter((op) => op.action !== CLOSE_ACTION).map((op) => ({ id: op.id, state: op.state }));
  const receipt = { checks, note, cleanup, ...(lane.machine ? { worktreeCheck: { status: "skipped", detail: remoteWorktreeNote(lane) } } : {}), operations };
  await deps.registry.update(lane.key, (current) => withStatus(current ?? lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, ...(lane.machine ? [`WORKTREE_CHECK SKIPPED ${lane.key}: ${remoteWorktreeNote(lane)}`] : []), `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

/**
 * Supervisor and `dori watch`: finishes every close a crash interrupted. A close whose lock is held
 * is still running and is left alone. A lane already recorded closed only settles the row; otherwise the close runs
 * again with its recorded note and force flag, and its operations skip what is verified, reconcile what was in flight
 * and stop at anything ambiguous. Each outcome is one line: LANE_CLOSED, OPERATION_AMBIGUOUS or OPERATION_FAILED.
 */
export const resumeOperations = async (deps: FlowDeps, push: Emit): Promise<void> => {
  const open = await withOperations(deps, async (store) => store.list({ states: OPEN_STATES }).filter((op) => op.action === CLOSE_ACTION));
  for (const op of open) {
    const release = tryStateLock(closeLockPath(deps, op.lane));
    if (!release) continue;
    release();
    const lane = await deps.registry.read(op.lane);
    if (!lane || statusOf(lane) === "closed") {
      await withOperations(deps, async (store) => settleOperation(store, deps.clock.now(), op.id, lane ? "verified" : "failed", lane ? "lane recorded closed" : "lane not registered"));
      continue;
    }
    const { note, force } = JSON.parse(op.data ?? "{}") as { note?: string; force?: boolean };
    const result = await closeLane(deps, lane, note ?? "closed after an interrupted close", { force: Boolean(force) });
    const last = result.lines.at(-1) ?? "";
    if (result.closed) await push(`LANE_CLOSED ${lane.key} ${last.split(" ").slice(2).join(" ")}`);
    else {
      const ambiguousLines = result.lines.filter((line) => line.startsWith("OPERATION_AMBIGUOUS "));
      for (const line of ambiguousLines.length ? ambiguousLines : [`OPERATION_FAILED ${op.id} the interrupted close was not finished: ${last}`]) await push(line);
    }
  }
};

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return objectDone(deps, lane, blocked);
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return objectDone(deps, lane, failing);
  // The close's intent is durable before the lane reads verified-done: a crash from here on resumes it.
  await withOperations(deps, async (store) => {
    const prior = store.get(closeId(lane.key));
    const data = JSON.stringify({ note: `Done: ${evidence}`, force: false });
    if (!prior) plan(store, deps.clock.now(), { lane: lane.key, action: CLOSE_ACTION, target: lane.key, data });
    else if (prior.state !== "planned") store.put({ ...prior, state: "planned", detail: "close planned", data, updatedAt: deps.clock.now() });
  });
  // Only the claim being settled is verified: an objection, pause or newer claim written meanwhile stands.
  const superseded = { status: "" };
  let verified: Lane = lane;
  await deps.registry.update(lane.key, (current) => {
    const fresh = current ?? lane;
    if (statusOf(fresh) !== "done-claimed" || fresh.claim?.at !== lane.claim?.at) { superseded.status = statusOf(fresh); return undefined; }
    return (verified = withStatus(fresh, "verified-done", "Done signals read back live", iso(deps.clock)));
  });
  if (superseded.status) {
    await withOperations(deps, async (store) => settleOperation(store, deps.clock.now(), closeId(lane.key), "failed", `superseded: lane is ${superseded.status}`));
    return `LANE_SETTLE_SKIPPED ${lane.key} is now ${superseded.status}; the done claim being settled was superseded, not closed`;
  }
  const result = await closeLane(deps, verified, `Done: ${evidence}`);
  if (!result.closed) {
    const signals = result.lines.filter((l) => l.startsWith("SIGNAL NOT"));
    return objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, signals.length ? signals : result.lines.filter((l) => l.startsWith("REFUSED")));
  }
  return `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`;
};

/** The thread id of a `discord:<channel>/<thread>` ref; a lane working in a channel itself (no thread) has none. */
const discordThreadId = (ref: string): string | undefined => {
  const [, thread] = /^discord:[^/]+\/(\d+)$/.exec(ref) ?? [];
  return thread;
};

const remoteWorktreeNote = (lane: Lane): string =>
  `worktree checks (unpushed/uncommitted) and cleanup skipped on machine ${lane.machine}: herdr has no read-only remote git execution API; remote paths were not checked locally`;

/** Worktrees a lane's close had to keep (`worktree <path> kept: ...` in its receipt), usually because they were dirty then. */
const keptWorktrees = (lane: Lane): string[] => {
  const receipt = lane.receipt;
  if (typeof receipt !== "object" || receipt === null || !("cleanup" in receipt) || !Array.isArray(receipt.cleanup)) return [];
  return receipt.cleanup.flatMap((line: unknown) => {
    if (typeof line !== "string" || !line.startsWith("worktree ")) return [];
    const end = line.indexOf(" kept: ");
    return end > 9 ? [line.slice(9, end)] : [];
  });
};

/**
 * Finish a closed lane's worktree cleanup: a worktree its close kept is removed once it is clean, only under
 * `worktreeRoot`. Open lanes (working, not-done, paused, done-claimed) are never touched: their Done signals have
 * not all read back yet, and work can continue after a merge. Failures come back as LANE_WATCH_WARN lines.
 */
export const closedWorktreeSweep = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const root = deps.config.worktreeRoot.replace(/\/+$/, "");
  if (lane.machine || statusOf(lane) !== "closed" || !root) return [];
  const exists = deps.exists ?? existsSync;
  const repo = lane.cwd ?? deps.config.defaultCwd;
  const removed: string[] = [];
  const out: string[] = [];
  for (const wt of keptWorktrees(lane)) {
    if (!wt.startsWith(`${root}/`) || wt.includes("..") || !exists(wt)) continue;
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain"]);
    if (dirty.code !== 0) out.push(`LANE_WATCH_WARN ${lane.key} cannot read git status of ${wt}: ${(dirty.err || dirty.out).slice(0, 160)}`);
    else if (dirty.out.trim()) continue;
    else {
      const r = await deps.run(["git", "-C", repo, "worktree", "remove", wt]);
      if (r.code === 0) removed.push(wt);
      else out.push(`LANE_WATCH_WARN ${lane.key} worktree ${wt} not removed: ${(r.err || r.out).slice(0, 160)}`);
    }
  }
  return removed.length ? [`WORKTREE_CLEANED ${lane.key} ${removed.join(" ")}`, ...out] : out;
};

/**
 * The lane this process runs inside, or undefined for the lead. `dori launch` sets DORI_LANE_KEY in a local lane's
 * pane; a pane registered to an open lane (HERDR_PANE_ID) counts as that lane too, so unsetting the variable is not
 * enough. The lead pane (config.leadPane) is never a lane.
 */
export const callerLane = async (deps: Pick<FlowDeps, "registry" | "config">, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> => {
  const key = env.DORI_LANE_KEY?.trim();
  if (key) return key;
  const pane = env.HERDR_PANE_ID?.trim();
  if (!pane || pane === deps.config.leadPane) return undefined;
  return (await deps.registry.byPane(pane))?.key;
};

/** Why a lane may not run `command` on lane `target`, or undefined when it may (the lead always may). */
export const laneActRefusal = (caller: string | undefined, command: string, target: string): string | undefined =>
  caller === undefined || caller === target ? undefined : `LANE_PERMISSION_DENIED lane ${caller} may not ${command} lane ${target}; only its own key (the lead can act on any lane)`;

/**
 * Why a lane may not send to `target`, or undefined when it may. A lane posts only into its own work thread
 * (`lane.thread`, resolved for that platform the way `dori send --to <ref>` resolves it); the lead may send anywhere.
 */
export const laneSendRefusal = (caller: string | undefined, lane: Lane | null, platform: Platform, target: Target): string | undefined => {
  if (caller === undefined) return undefined;
  const denied = `LANE_PERMISSION_DENIED lane ${caller} may send only to its own work thread (${lane?.thread ?? "unregistered"}), not ${platform} ${target.to}${target.thread ? `/${target.thread}` : ""}`;
  if (!lane || lane.key !== caller || !lane.thread.startsWith(`${platform}:`)) return denied;
  let own: Target;
  try { own = resolveTarget(platform, lane.thread); } catch { return denied; }
  return own.to === target.to && (own.thread ?? "") === (target.thread ?? "") ? undefined : denied;
};

/** Hands a line over; `id` is its journal id when the line has a stable one (else the supervisor assigns one). */
export type Emit = (line: string, id?: string) => Promise<void>;

/**
 * A remote lane can neither run `dori claim-done` nor message the lead pane: its newest `[REPORT]` line, read from
 * its own pane, stands in for both. A new `done` report becomes the same claim a local lane makes (same window, same
 * live re-check before close); a new blocker or question is pushed as an urgent LANE_REPORT.
 */
const remoteReport = async (deps: FlowDeps, lane: Lane, push: Emit, view: SweepView): Promise<Lane> => {
  if (!lane.pane) return lane;
  return remoteReportSequence(deps, lane, push, await view.screen(lane, 200));
};

/** The most line hashes a lane keeps: more than one 200-line screen can show, so a line still on screen is never forgotten. */
export const REMOTE_SEEN_MAX = 200;

const lineHash = (line: string): string => createHash("sha256").update(line).digest("hex").slice(0, 16);

/**
 * Every [REPORT] line on the screen not seen before is acted on, top to bottom, so a question and a milestone printed
 * between two polls both arrive, in order. Lines are told apart by (lane, line hash, first-seen): the same line printed
 * again is the same report. A lane watched by an older dori (newest line only) has no hashes yet: the lines up to its
 * `lastRemoteReport` count as seen, so the upgrade replays nothing.
 */
const remoteReportSequence = async (deps: FlowDeps, lane: Lane, push: Emit, screen: string): Promise<Lane> => {
  const lines = reportLines(screen, lane.key);
  let seen = lane.remoteReportsSeen;
  if (!seen) {
    const upTo = lane.lastRemoteReport === undefined ? -1 : lines.lastIndexOf(lane.lastRemoteReport);
    const at = iso(deps.clock);
    seen = [...new Set(lines.slice(0, upTo + 1).map(lineHash))].map((hash) => ({ hash, at }));
  }
  let current = lane;
  for (const line of lines) {
    const hash = lineHash(line);
    if (seen.some((s) => s.hash === hash)) continue;
    seen = [...seen, { hash, at: iso(deps.clock) }].slice(-REMOTE_SEEN_MAX);
    current = await actOnRemoteReport(deps, current, push, line, { lastRemoteReport: line, remoteReportsSeen: seen });
  }
  return current;
};

/** Acts on one remote [REPORT] line, then records `fields` so the line is not acted on again. */
const actOnRemoteReport = async (deps: FlowDeps, lane: Lane, push: Emit, line: string, fields: Partial<Lane>): Promise<Lane> => {
  const seen: Lane = { ...lane, ...fields };
  const [, kind = "", what = ""] = /^\[REPORT\] \S+ \| (\w+) \| (.*)$/.exec(line) ?? [];
  if (kind === "done") {
    // Claim first: a crash before the line is recorded repeats the claim instead of losing it.
    await claimDone(deps, seen, what);
    return (await deps.registry.patch(lane.key, fields)) ?? seen;
  }
  if (kind === "blocker" || kind === "question") await push(`LANE_REPORT ${lane.key} ${kind} ${what}`);
  await deps.registry.patch(lane.key, fields);
  return seen;
};

const watchLane = async (deps: FlowDeps, listed: Lane, push: Emit, view: SweepView): Promise<void> => {
  const status = statusOf(listed);
  if (status === "closed") {
    for (const line of await closedWorktreeSweep(deps, listed)) await push(line);
    return;
  }
  let lane = listed;
  if (lane.machine && (status === "working" || status === "not-done")) lane = await remoteReport(deps, lane, push, view);
  let claim = lane.claim;
  if (statusOf(lane) !== "done-claimed" || !claim) return;
  const machine = machineClose(lane);
  if (!claim.emitted) {
    // Enqueued before the emitted mark is saved: a crash in between repeats the announcement instead of losing it
    // (under the same id, so the supervisor journals it once).
    const event = !machine ? claimEventId(lane.key, claim.at) : undefined;
    await push(`${machine ? "LANE_AUTO_CLAIMED" : "LANE_DONE_CLAIMED"} ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`, event);
    const announced = { emitted: true, ...(event ? { event } : {}) };
    claim = { ...claim, ...announced };
    lane = { ...lane, claim };
    const at = claim.at;
    await deps.registry.patch(lane.key, (current) => (current.claim?.at === at ? { claim: { ...current.claim, ...announced } } : undefined));
  }
  const start = await windowStart(deps, lane, claim);
  let evidence = claim.evidence;
  if (start === undefined || deps.clock.now() - start < windowMs(deps)) {
    // A merged PR settles the claim: nothing is left to object to, so the lane closes now (its signals still re-read).
    const merged = await mergeConfirmed(deps, lane);
    if (!merged) return;
    evidence = `${claim.evidence} (closed at once: ${merged})`;
  }
  const line = await settle(deps, lane, evidence);
  await push(machine && line.startsWith("LANE_CLOSED ") ? `LANE_AUTO_CLOSED ${line.slice("LANE_CLOSED ".length)}` : line);
};

/**
 * Why a done-claimed lane's PR counts as merged, or undefined: the supervisor merged it (a verified
 * `merge` operation of the lane, its CI_MERGED), a `merged` Done signal's PR reads MERGED, or GitHub reports a PR merged
 * into `ciMergeBase` from a lane worktree's branch at exactly that worktree's HEAD.
 */
export const mergeConfirmed = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  if (lane.machine) return undefined;
  const op = await withOperations(deps, async (store) => store.list({ lane: lane.key }).find((o) => o.action === "merge" && o.state === "verified"));
  if (op) return `CI_MERGED ${op.target}`;
  const signalled = (await readBindings(lane.done, deps.run)).find((b) => !("error" in b));
  if (signalled) return `${signalled.repo}#${signalled.n} merged`;
  const worktrees = [...new Set([...(lane.cwd ? [lane.cwd] : []), ...(await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd]))])];
  const { atHead } = await readBranchBindings(deps.run, worktrees, deps.config.ciMergeBase, deps.exists ?? existsSync);
  const pr = atHead[0];
  return pr ? `${pr.repo}#${pr.n} merged into ${pr.base} at ${pr.sha.slice(0, 10)}` : undefined;
};

/** Why a lane's work is already finished (every Done signal reads back live, or its PR is confirmed merged), or undefined. */
export const finishedReason = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  if (checks.length > 0 && checks.every((c) => c.ok)) return "every Done signal holds";
  return mergeConfirmed(deps, lane);
};

/**
 * When a claim's objection window starts, or undefined while the lead has not received it yet. For a machine-closed
 * lane, or a claim announced by an older dori (no event id), it is the claim itself. Otherwise it
 * is the first watcher pass that reads the announcement delivered, recorded on the claim so a restart keeps it.
 */
const windowStart = async (deps: FlowDeps, lane: Lane, claim: NonNullable<Lane["claim"]>): Promise<number | undefined> => {
  if (!claim.event) return Date.parse(claim.at);
  if (claim.deliveredAt) return Date.parse(claim.deliveredAt);
  // Only a claim that wakes the lead waits for its delivery; a digest one (the default) or one the policy keeps from
  // the lead is settled by the supervisor, so handing it over counts.
  if (claimWaitsForLead(deps, lane) && deps.leadDelivered && !deps.leadDelivered(claim.event)) return undefined;
  const at = iso(deps.clock);
  await deps.registry.patch(lane.key, (current) => (current.claim?.at === claim.at ? { claim: { ...current.claim, deliveredAt: at } } : undefined));
  return Date.parse(at);
};

/**
 * One pass over every lane. With `emit`, each line is handed over the moment it exists (the supervisor enqueues it
 * durably); the lines are also returned. One lane's failure is a LANE_WATCH_WARN line and never stops the others.
 * `archived: false` skips the closed lanes in the archive (their worktree cleanup), so a pass reads open lanes only.
 */
export const watchTick = async (deps: FlowDeps, emit?: Emit, view: SweepView = passthroughView(deps.run), archived = true): Promise<string[]> => {
  const out: string[] = [];
  const push: Emit = async (line, id) => {
    if (emit) await emit(line, id);
    out.push(line);
  };
  try {
    await resumeOperations(deps, push);
  } catch (e) {
    await push(`LANE_WATCH_WARN operations ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  for (const listed of archived ? await deps.registry.list() : await deps.registry.open()) {
    try {
      await watchLane(deps, listed, push, view);
    } catch (e) {
      await push(`LANE_WATCH_WARN ${listed.key} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return out;
};
