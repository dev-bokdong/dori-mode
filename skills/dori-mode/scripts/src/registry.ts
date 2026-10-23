import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireStateLock } from "./state-lock.ts";
export { LOCK_WAIT_MS, StateLockError as RegistryLockError } from "./state-lock.ts";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = {
  readonly at: string;
  readonly evidence: string;
  readonly emitted?: boolean;
  /** The journal id its LANE_DONE_CLAIMED was enqueued under, so its delivery can be read back. */
  readonly event?: string;
  /** When the watcher first read that event delivered to the lead; the objection window starts here. */
  readonly deliveredAt?: string;
};
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly pane?: string;
  readonly machine?: string;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  /** `machine`: the brief declared its Done signals settle it alone; its claim and close are digest. */
  readonly autoClose?: "machine";
  /** Local directory: command Done signals and worktree checks run here. Remote lanes leave it unset (defaultCwd). */
  readonly cwd?: string;
  /** A remote lane's working directory on its machine; never used as a local path. */
  readonly remoteCwd?: string;
  readonly model?: string;
  /** The GitHub issue the lane works on (`owner/repo#N`, the brief's `issue:` line); closed once its PR merges into ciMergeBase. */
  readonly ghIssue?: string;
  readonly recoveryPending?: boolean;
  readonly recoveryPreviousPane?: string;
  /** An admission reservation is paused until its agent is registered, so recovery never launches it too. */
  readonly launchReservation?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The todo item the freshness sweep last posted from a working lane's pane, so an unchanged item is never posted twice. */
  readonly lastProgressPost?: string;
  /** When that todo item was last posted successfully, so an unchanged item is posted again after nudgeAfterMin. */
  readonly lastProgressAt?: number;
  /** The last failed progress-post error, so a failing hook is reported once per distinct error, not every tick. */
  readonly lastProgressError?: string;
  /** A remote lane's last [REPORT] line the watcher acted on (claim, LANE_REPORT or nothing for a milestone). */
  readonly lastRemoteReport?: string;
  /** Every [REPORT] line the watcher has acted on, by line hash and first-seen time, newest last. */
  readonly remoteReportsSeen?: readonly { readonly hash: string; readonly at: string }[];
  /**
   * `cli`: launched on the `dori report` footer, so it reports with `dori report` and never types into the lead's pane;
   * its [REPORT] lines found there are counted as violations. Absent: an older lane on the [REPORT] footer, or a remote one.
   */
  readonly reportVia?: "cli";
  /** [REPORT] lines of a `reportVia: cli` lane found in the lead's pane, by line hash and first-seen time, newest last. */
  readonly leadPaneSeen?: readonly { readonly hash: string; readonly at: string }[];
  /** How many distinct such lines were found: the lane's lead-pane violations. */
  readonly leadPaneViolations?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string;
  /** The quota stall the lead was last told about (LANE_QUOTA_STALL); cleared once the lane is no longer stalled. */
  readonly lastQuotaStall?: string;
  readonly recoveryAttempts?: number;
  readonly lastRecoveryAt?: number;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus;
  readonly receipt?: unknown;
  /** Bumped by every registry write; a write carrying an older version than the stored one was made from stale state. */
  readonly version?: number;
};

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

const missing = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "ENOENT";

/** The parsed lane file, or null when there is none (a lane moved to the archive meanwhile reads as missing here). */
const readLaneFile = (path: string): Lane | null => {
  try { return JSON.parse(readFileSync(path, "utf8")) as Lane; }
  catch (e) { if (missing(e)) return null; throw e; }
};

const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/**
 * `lanes/` holds open lanes only, so the sweeps read O(open lanes). A closed lane is saved there and then renamed into
 * `lanes-archive/` (one atomic step, so a crash leaves it in exactly one place); `read` falls back to the archive, so
 * a closed key is still found (launch refuses to reuse it, close and status still see it). Hand-moved files from the
 * old `lanes-closed/` directory are kept verbatim under `lanes-archive/legacy/`.
 */
export class Registry {
  readonly dir: string;
  readonly archiveDir: string;
  readonly legacyDir: string;
  private readonly oldClosedDir: string;
  private migrated = false;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
    this.archiveDir = join(stateDir, "lanes-archive");
    this.legacyDir = join(this.archiveDir, "legacy");
    this.oldClosedDir = join(stateDir, "lanes-closed");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  archivePath(key: string): string {
    return join(this.archiveDir, `${key}.json`);
  }

  /** The open file first, then the archive: a lane renamed between the two reads is found in the archive. */
  async read(key: string): Promise<Lane | null> {
    return readLaneFile(this.path(key)) ?? readLaneFile(this.archivePath(key));
  }

  /** SQLite releases this per-lane lock even if the owner is killed; live operations never expire. */
  private lock(key: string): Promise<() => void> {
    return acquireStateLock(join(this.dir, `${key}.lock.sqlite`));
  }

  /** Temp file, fsync, rename, then fsync the directory, so a reader or a crash never sees a half-written lane. */
  private save(lane: Lane): Lane {
    mkdirSync(this.dir, { recursive: true });
    let stored: number | undefined;
    let archived = false;
    try {
      const open = readLaneFile(this.path(lane.key));
      const old = open ?? readLaneFile(this.archivePath(lane.key));
      archived = !open && old !== null;
      stored = old?.version;
    } catch { stored = undefined; }
    if (lane.version !== undefined && stored !== undefined && lane.version < stored) {
      console.error(`REGISTRY_STALE_WRITE ${lane.key} written from v${lane.version} over v${stored}; use registry.update`);
    }
    const next: Lane = { ...lane, version: Math.max(stored ?? 0, lane.version ?? 0) + 1 };
    const closed = statusOf(next) === "closed";
    // An archived lane that stays closed is rewritten in place; anything else is written to lanes/ first.
    const dir = closed && archived ? this.archiveDir : this.dir;
    const target = join(dir, `${lane.key}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(next, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target);
    fsyncDir(dir);
    if (closed && !archived) this.moveToArchive(lane.key);
    else if (!closed && archived) {
      // Reopened: the archived copy goes, so the key lives in exactly one place.
      unlinkSync(this.archivePath(lane.key));
      fsyncDir(this.archiveDir);
    }
    return next;
  }

  /** Atomic rename lanes/<key>.json -> lanes-archive/<key>.json; the caller holds the lane lock. */
  private moveToArchive(key: string): void {
    mkdirSync(this.archiveDir, { recursive: true });
    renameSync(this.path(key), this.archivePath(key));
    fsyncDir(this.archiveDir);
    fsyncDir(this.dir);
  }

  /** Archives a closed lane left in lanes/ (written by older code, or a crash between save and rename). */
  private async archiveIfClosed(key: string): Promise<void> {
    const release = await this.lock(key);
    try {
      const lane = readLaneFile(this.path(key));
      if (lane && statusOf(lane) === "closed") this.moveToArchive(key);
    } finally { release(); }
  }

  /**
   * Once per instance: files hand-moved to the old lanes-closed/ go to lanes-archive/legacy/ under their own names
   * (they are not lane records `read` may return: some are dead or abandoned copies of keys that are open again).
   * A name already taken in legacy/ stays in lanes-closed/, which closedKeys keeps reading.
   */
  private migrateLegacy(): void {
    if (this.migrated) return;
    this.migrated = true;
    if (!existsSync(this.oldClosedDir)) return;
    mkdirSync(this.legacyDir, { recursive: true });
    for (const f of readdirSync(this.oldClosedDir)) {
      const to = join(this.legacyDir, f);
      if (!existsSync(to)) renameSync(join(this.oldClosedDir, f), to);
    }
    fsyncDir(this.legacyDir);
    if (readdirSync(this.oldClosedDir).length === 0) rmdirSync(this.oldClosedDir);
  }

  /** Last writer wins (stale writes are logged as REGISTRY_STALE_WRITE). Prefer `update` for load-modify-save. */
  async write(lane: Lane): Promise<void> {
    const release = await this.lock(lane.key);
    try { this.save(lane); } finally { release(); }
  }

  /**
   * Lock, read the lane fresh, apply `mutate`, save. `mutate` gets null for a missing lane; returning undefined
   * writes nothing. Returns the lane as stored afterwards.
   */
  async update(key: string, mutate: (current: Lane | null) => Lane | undefined | Promise<Lane | undefined>): Promise<Lane | null> {
    const release = await this.lock(key);
    try {
      const current = await this.read(key);
      const next = await mutate(current);
      if (next === undefined) return current;
      if (next.key !== key) throw new Error(`update of lane ${key} returned lane ${next.key}`);
      return this.save({ ...next, version: current?.version ?? 0 });
    } finally { release(); }
  }

  /**
   * `update` that changes only the given fields of the fresh lane (a function gets the fresh lane and may return
   * undefined to write nothing). A missing lane is never recreated: returns null and writes nothing.
   */
  async patch<T extends Lane = Lane>(key: string, fields: Partial<T> | ((current: T) => Partial<T> | undefined)): Promise<T | null> {
    let missing = false;
    const stored = await this.update(key, (current) => {
      if (!current) { missing = true; return undefined; }
      const p = typeof fields === "function" ? fields(current as T) : fields;
      return p === undefined ? undefined : { ...current, ...p, key };
    });
    return missing ? null : (stored as T | null);
  }

  /** Remove only the caller's failed admission, never a lane that has since been replaced or launched. */
  async releaseReservation(key: string, token: string): Promise<void> {
    const release = await this.lock(key);
    try {
      if ((await this.read(key))?.launchReservation !== token) return;
      unlinkSync(this.path(key));
      fsyncDir(this.dir);
    } finally { release(); }
  }

  /** Open lanes: reads lanes/ only, never the archive. A closed lane still found there is archived on the way. */
  async open(): Promise<Lane[]> {
    mkdirSync(this.dir, { recursive: true });
    this.migrateLegacy();
    const lanes: Lane[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const lane = readLaneFile(join(this.dir, f));
      if (!lane) continue;
      if (statusOf(lane) === "closed") await this.archiveIfClosed(lane.key);
      else lanes.push(lane);
    }
    return lanes;
  }

  /** Keys of archived lanes, from file names alone (no file is read). */
  archivedKeys(): string[] {
    if (!existsSync(this.archiveDir)) return [];
    return readdirSync(this.archiveDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
  }

  /** Every archived (closed) lane record. Reads the whole archive: for rare or periodic callers only. */
  async archived(): Promise<Lane[]> {
    await this.open();
    return this.readArchive();
  }

  private readArchive(): Lane[] {
    return this.archivedKeys().flatMap((key) => readLaneFile(this.archivePath(key)) ?? []);
  }

  /** Open and archived lanes. Reads the whole archive: for rare or periodic callers only. */
  async list(): Promise<Lane[]> {
    const open = await this.open();
    const keys = new Set(open.map((l) => l.key));
    return [...open, ...this.readArchive().filter((l) => !keys.has(l.key))];
  }

  /** Hand-moved closed files (lanes-archive/legacy/, and lanes-closed/ when anything is left there): [path, name]. */
  legacyFiles(): [string, string][] {
    this.migrateLegacy();
    return [this.legacyDir, this.oldClosedDir].flatMap((dir) => existsSync(dir) ? readdirSync(dir).map((f): [string, string] => [join(dir, f), f]) : []);
  }

  async byPane(pane: string, machine?: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane && l.machine === machine) ?? null;
  }
}

/** Lock, fresh load, mutate, save: a stale copy can never overwrite newer state (objection, pause). */
export const updateRegistry = (registry: Registry, key: string, mutate: Parameters<Registry["update"]>[1]): Promise<Lane | null> =>
  registry.update(key, mutate);
