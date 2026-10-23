import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GuardThresholds } from "./config.ts";
import type { HostSample } from "./host-guard.ts";
import { type Lane, statusOf } from "./registry.ts";
import { withStateLockSync } from "./state-lock.ts";

export type LaunchVerdict = { readonly ok: boolean; readonly reasons: readonly string[] };

export const canLaunch = (s: HostSample, t: GuardThresholds): LaunchVerdict => {
  const reasons: string[] = [];
  if (s.memFreePct < t.memFreeMinPct) reasons.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) reasons.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes >= t.panesMax) reasons.push(`panes ${s.panes} >= ${t.panesMax}`);
  return { ok: reasons.length === 0, reasons };
};

const holdFile = (stateDir: string): string => join(stateDir, "launch-hold.json");

/** A launch that `dori launch` answered HOLD for; it waits in launch-hold.json until it launches or is dropped. */
export type QueuedLaunch = {
  readonly key: string;
  readonly title: string;
  readonly done: string;
  readonly brief: string;
  readonly cwd?: string;
  /** owner/repo names from the Done line's merged/closed signals. */
  readonly repos?: readonly string[];
  readonly thread?: string;
  readonly model?: string;
  readonly machine?: string;
  readonly pane?: string;
  readonly workspace?: string;
  readonly queuedAt: string;
  readonly reasons: readonly string[];
};

/** `blocked` false keeps the queue after LAUNCH_READY; a file without `blocked` (older versions) counts as held. */
type HoldState = { readonly revision?: string; readonly blocked?: boolean; readonly at?: number; readonly reasons?: readonly string[]; readonly queue?: readonly QueuedLaunch[] };

const lockedHold = <T>(stateDir: string, act: () => T): T =>
  withStateLockSync(join(stateDir, "launch-hold.lock.sqlite"), act);

// clearLaunchHold acknowledges the exact HOLD a supervisor observed before its asynchronous LAUNCH_READY emission.
const observedHolds = new Map<string, string>();
const holdRevision = (hold: HoldState): string => hold.revision ?? JSON.stringify(hold);

const validLaunch = (value: unknown): value is QueuedLaunch =>
  typeof value === "object" && value !== null &&
  "key" in value && typeof value.key === "string" &&
  "title" in value && typeof value.title === "string" &&
  "done" in value && typeof value.done === "string" &&
  "brief" in value && typeof value.brief === "string" &&
  (!("cwd" in value) || typeof value.cwd === "string") &&
  (!("repos" in value) || (Array.isArray(value.repos) && value.repos.every((repo) => typeof repo === "string"))) &&
  (!("thread" in value) || typeof value.thread === "string") &&
  (!("model" in value) || typeof value.model === "string") &&
  (!("machine" in value) || typeof value.machine === "string") &&
  (!("pane" in value) || typeof value.pane === "string") &&
  (!("workspace" in value) || typeof value.workspace === "string") &&
  "queuedAt" in value && typeof value.queuedAt === "string" &&
  "reasons" in value && Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === "string");

const readHold = (stateDir: string): HoldState | undefined => {
  const path = holdFile(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
        ("blocked" in raw && typeof raw.blocked !== "boolean") ||
        ("at" in raw && (typeof raw.at !== "number" || !Number.isFinite(raw.at))) ||
        ("reasons" in raw && (!Array.isArray(raw.reasons) || !raw.reasons.every((reason) => typeof reason === "string"))) ||
        ("queue" in raw && !Array.isArray(raw.queue))) throw new Error("invalid launch hold state");
    const entries = "queue" in raw ? raw.queue as unknown[] : undefined;
    const queue = entries?.filter(validLaunch);
    if (entries && queue!.length !== entries.length) console.error(`LAUNCH_HOLD_INVALID_ENTRY dropped invalid queue entries from ${path}`);
    return { ...raw, ...(queue === undefined ? {} : { queue }) } as HoldState;
  } catch (e) {
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); } catch (r) { if ((r as NodeJS.ErrnoException).code !== "ENOENT") throw r; }
    console.error(`LAUNCH_HOLD_CORRUPT moved ${path} to ${aside}: ${e instanceof Error ? e.message : String(e)}; continuing blocked with an empty queue`);
    const safeState: HoldState = { blocked: true, reasons: ["launch-hold.json corrupt"], queue: [] };
    return writeHold(stateDir, safeState);
  }
};

const writeHold = (stateDir: string, state: HoldState): HoldState => {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${holdFile(stateDir)}.${process.pid}.tmp`;
  const next = { ...state, revision: randomUUID() };
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(next, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, holdFile(stateDir));
  const dir = openSync(stateDir, "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return next;
};

/**
 * `dori can-launch` and `dori launch` raise the blocked flag while their answer is HOLD, so the supervisor knows work is
 * waiting on the host and can wake the lead (LAUNCH_READY) the moment there is room again. CAN_LAUNCH lowers it.
 * The queued launches are kept either way.
 */
export const recordLaunchVerdict = (stateDir: string, verdict: LaunchVerdict, at: number): void => {
  lockedHold(stateDir, () => {
    const hold = readHold(stateDir);
    if (verdict.ok) {
      if (hold) writeHold(stateDir, { ...hold, blocked: false });
    } else writeHold(stateDir, { ...hold, blocked: true, at, reasons: verdict.reasons });
  });
};

export const launchHeld = (stateDir: string): boolean => lockedHold(stateDir, () => {
  const hold = readHold(stateDir);
  if (!hold || hold.blocked === false) { observedHolds.delete(stateDir); return false; }
  observedHolds.set(stateDir, holdRevision(hold));
  return true;
});

/** Lowers the blocked flag (LAUNCH_READY fired or CAN_LAUNCH); queued launches stay until they launch or are dropped. */
export const clearLaunchHold = (stateDir: string): void => {
  lockedHold(stateDir, () => {
    const observed = observedHolds.get(stateDir);
    observedHolds.delete(stateDir);
    const hold = readHold(stateDir);
    if (hold && (observed === undefined || observed === holdRevision(hold))) writeHold(stateDir, { ...hold, blocked: false });
  });
};

export const launchQueue = (stateDir: string): readonly QueuedLaunch[] => lockedHold(stateDir, () => readHold(stateDir)?.queue ?? []);

/** Adds (or refreshes, keeping its first queued-at time) a held launch; returns the whole queue. */
export const enqueueLaunch = (stateDir: string, item: QueuedLaunch): readonly QueuedLaunch[] => lockedHold(stateDir, () => {
  const hold = readHold(stateDir) ?? { blocked: false };
  const old = (hold.queue ?? []).find((q) => q.key === item.key);
  const queue = [...(hold.queue ?? []).filter((q) => q.key !== item.key), { ...item, queuedAt: old?.queuedAt ?? item.queuedAt }];
  writeHold(stateDir, { ...hold, queue, blocked: true, at: Date.parse(item.queuedAt), reasons: item.reasons });
  return queue;
});

/** Removes a queued launch (it launched, or `dori hold drop`); false when it was not queued. */
export const dequeueLaunch = (stateDir: string, key: string): boolean => lockedHold(stateDir, () => {
  const hold = readHold(stateDir);
  if (!hold?.queue?.some((q) => q.key === key)) return false;
  writeHold(stateDir, { ...hold, queue: hold.queue.filter((q) => q.key !== key) });
  return true;
});

/** The queued launches as one line for LAUNCH_READY ("" when none), so a restarted lead loses nothing. */
export const launchQueueText = (queue: readonly QueuedLaunch[]): string =>
  queue.length
    ? `; queued launches (${queue.length}): ${queue.map((q) => [
      q.key,
      ...(q.cwd ? [`cwd=${q.cwd}`] : []),
      ...(q.repos?.length ? [`repo=${q.repos.join(",")}`] : []),
      ...(q.thread && q.thread !== "none" ? [`thread=${q.thread}`] : []),
      ...(q.machine ? [`machine=${q.machine}`] : []),
      `done=${JSON.stringify(q.done)}`,
      `brief=${q.brief}`,
      `queued ${q.queuedAt}`,
    ].join(" ")).join("; ")} (dori hold list)`
    : "";

/** What `dori launch` must do before it starts a lane: refuse, hold, or go with these stdout lines. */
export type LaunchGate = { readonly error?: string; readonly hold?: string; readonly lines: readonly string[] };

export const OWNER_NOTICE = "OWNER_NOTICE";

/**
 * The host guard (memory, disk, pane count) always applies; `--ignore-quota` lifts only the Claude quota gate, needs a
 * reason, and yields an OWNER_NOTICE line for the lead to relay. A pane budget of 0 or less is unlimited, with a warning.
 */
export const launchGate = (o: {
  readonly key: string; readonly sample: HostSample; readonly guard: GuardThresholds;
  readonly quotaHold?: string; readonly ignoreQuota?: boolean; readonly reason?: string;
}): LaunchGate => {
  if (o.ignoreQuota && !o.reason?.trim()) return { error: "--ignore-quota needs --reason TEXT (why the Claude quota gate is bypassed; it is journaled and relayed to the owner)", lines: [] };
  const lines: string[] = [];
  if (o.guard.panesMax <= 0) lines.push(`LAUNCH_WARN guard.panesMax is ${o.guard.panesMax}: the pane-count limit is off, so nothing caps concurrent lanes; set guard.panesMax to re-enable it`);
  const reasons = [...canLaunch(o.sample, o.guard).reasons];
  if (o.quotaHold && !o.ignoreQuota) reasons.push(o.quotaHold);
  if (reasons.length) return { hold: reasons.join(" | "), lines };
  if (o.ignoreQuota) lines.push(`${OWNER_NOTICE} lane ${o.key} is launching past the Claude quota gate with --ignore-quota (${o.quotaHold ?? "gate open now"}); reason: ${o.reason?.trim()}`);
  return { lines };
};

/** One JSON line per `--ignore-quota` launch in <stateDir>/quota-bypass.jsonl. */
export const journalQuotaBypass = (stateDir: string, entry: { readonly key: string; readonly reason: string; readonly quotaHold?: string; readonly at: number }): void => {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "quota-bypass.jsonl"), `${JSON.stringify({ ...entry, at: new Date(entry.at).toISOString() })}\n`);
};

/** Other open lanes on this lane's messenger thread: while any remain, closing this lane must not mark the thread done. */
export const otherOpenLanesOnThread = (lanes: readonly Lane[], lane: Pick<Lane, "key" | "thread">): Lane[] =>
  lane.thread === "none" ? [] : lanes.filter((l) => l.key !== lane.key && l.thread === lane.thread && statusOf(l) !== "closed");

export const idleLaneFor = (lanes: readonly Lane[], cwd: string, idlePanes: ReadonlySet<string>): Lane | null =>
  lanes.find((l) => statusOf(l) === "working" && l.cwd === cwd && l.pane !== undefined && idlePanes.has(l.pane)) ?? null;
