import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { saveJsonFile, SQLITE_FILE, StoreError, type StoreKind } from "./store.ts";
import { withStateLockSync } from "./state-lock.ts";

/**
 * The operation contract (design 4.1): every mechanical effect the engine or a CLI command performs on a lane's world
 * (closing a pane, removing a worktree, marking a thread done; later merging, deleting a branch,
 * archiving a thread, messaging a lane) is one operation row, keyed by what it acts on. The row reaches `attempted`
 * durably before the effect runs, so a crash can never hide an effect that may have happened. Afterwards a read-back of
 * the world decides the state; only a read-back proving the effect did not happen allows another attempt, and anything
 * unclear is `ambiguous`, which stops the sequence and goes to the lead.
 *
 * Usage for a new effect (#208-#212):
 *
 * ```ts
 * const store = openOperations(config);
 * const { op } = await perform(store, clock.now, { lane: key, action: "branch-delete", target: `${branch}@${sha}` },
 *   async () => { const r = await run(["git", "branch", "-D", branch]); return { ok: r.code === 0, detail: r.err }; },
 *   async () => (await run(["git", "rev-parse", "--verify", branch])).code === 0 ? "not-done" : "done");
 * if (op.state === "ambiguous") stop and tell the lead (OPERATION_AMBIGUOUS);
 * ```
 *
 * A sequence that must resume after a crash also records one row for itself (action = the sequence, e.g. `close`)
 * before its first effect, and has a resumer (see `resumeOperations` in done-flow.ts).
 */
export type OperationState = "planned" | "attempted" | "verified" | "failed" | "ambiguous";

/** What a read-back of the world shows: the effect is in place, it is not, or this cannot be told. */
export type Observed = "done" | "not-done" | "unknown";

export type Operation = {
  /** `<lane>/<action>/<target>`: the same key is the same operation, so it never runs twice once verified. */
  readonly id: string;
  readonly lane: string;
  readonly action: string;
  /** What the effect acts on: a path, pane or tab id, thread, PR number and head SHA, message revision. */
  readonly target: string;
  readonly state: OperationState;
  /** Why the row is in its state (the effect's error, the read-back, the lead's resolution). */
  readonly detail: string;
  /** Input a resumer needs (JSON), e.g. a close's note and force flag. */
  readonly data?: string;
  /** Attempts started; a crash after the attempted write counts too. */
  readonly attempts: number;
  readonly at: number;
  readonly updatedAt: number;
};

export type OperationSpec = { readonly lane: string; readonly action: string; readonly target: string; readonly data?: string };

/** The effect itself. A throw counts as a failure report; the read-back still decides the state. */
export type Effect = () => Promise<{ readonly ok: boolean; readonly detail: string }>;
/** Reads the world. A throw counts as `unknown`. */
export type ReadBack = () => Promise<Observed>;

export const FINAL_STATES: ReadonlySet<OperationState> = new Set(["verified", "failed", "ambiguous"]);
/** States a sequence still has to finish: planned (intent recorded) and attempted (an effect may be in flight). */
export const OPEN_STATES: readonly OperationState[] = ["planned", "attempted"];

export const operationId = (spec: Pick<OperationSpec, "lane" | "action" | "target">): string => `${spec.lane}/${spec.action}/${spec.target}`;

/** Where operation rows live: the sqlite store's `operations` table, or `operations.json` beside supervisor.json. */
export interface OperationStore {
  get(id: string): Operation | undefined;
  /** Writes the row durably (fsync, or a FULL-synchronous commit) before returning: it may precede an effect. */
  put(op: Operation): void;
  /** Rows of one lane and/or in the given states, oldest first. */
  list(filter?: { readonly lane?: string; readonly states?: readonly OperationState[] }): Operation[];
  close(): void;
}

export const OPERATIONS_FILE = "operations.json";
const OPERATIONS_LOCK = "operations.lock.sqlite";

/** Oldest first, then by id: the order both stores list rows in. */
export const byAt = (a: Operation, b: Operation): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const matches = (op: Operation, filter: { readonly lane?: string; readonly states?: readonly OperationState[] }): boolean =>
  (filter.lane === undefined || op.lane === filter.lane) && (filter.states === undefined || filter.states.includes(op.state));

/** `operations.json`: rewritten whole (temp file, fsync, rename) under a short state lock, so CLI and supervisor can both write. */
export class JsonOperations implements OperationStore {
  readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, OPERATIONS_FILE);
    this.lock = join(stateDir, OPERATIONS_LOCK);
  }
  private read(): Record<string, Operation> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { ops: Record<string, Operation> }).ops : {};
  }
  get(id: string): Operation | undefined { return this.read()[id]; }
  put(op: Operation): void {
    withStateLockSync(this.lock, () => { saveJsonFile(this.path, { ops: { ...this.read(), [op.id]: op } }); });
  }
  list(filter: { readonly lane?: string; readonly states?: readonly OperationState[] } = {}): Operation[] {
    return Object.values(this.read()).filter((op) => matches(op, filter)).sort(byAt);
  }
  close(): void {}
}

/**
 * The table lives in supervisor.sqlite but is created on first use, not by a schema migration: until the first close
 * the database is exactly what an older release reads, so a rollback needs no export of it.
 */
export const OPERATIONS_DDL = `
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, lane TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL,
  data TEXT, attempts INTEGER NOT NULL, at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS operations_open ON operations (state, lane);
`;

type OpRow = { id: string; lane: string; action: string; target: string; state: string; detail: string; data: string | null; attempts: number; at: number; updated_at: number };

const fromRow = (row: OpRow): Operation => ({
  id: row.id, lane: row.lane, action: row.action, target: row.target, state: row.state as OperationState, detail: row.detail,
  ...(row.data !== null ? { data: row.data } : {}), attempts: row.attempts, at: row.at, updatedAt: row.updated_at,
});

/** Writes `ops` into a database's operations table (store import, and the sqlite store itself). */
export const putRows = (db: Database, ops: readonly Operation[]): void => {
  const insert = db.prepare(`INSERT OR REPLACE INTO operations (id, lane, action, target, state, detail, data, attempts, at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const op of ops) insert.run(op.id, op.lane, op.action, op.target, op.state, op.detail, op.data ?? null, op.attempts, op.at, op.updatedAt);
};

/** Every row of a database's operations table; none when the table was never created. */
export const readRows = (db: Database): Operation[] => {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operations'").get()) return [];
  return (db.query("SELECT * FROM operations ORDER BY at, id").all() as OpRow[]).map(fromRow);
};

/** The `operations` table of supervisor.sqlite, on its own connection (WAL: the supervisor's connection keeps writing). */
export class SqliteOperations implements OperationStore {
  private readonly db: Database;
  constructor(path: string) {
    if (!existsSync(path)) throw new StoreError(`STORE_MISSING ${path}; the operation table lives in the sqlite store`);
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      // Each row may precede an effect: it must survive power loss, not only a crash.
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec(OPERATIONS_DDL);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  get(id: string): Operation | undefined {
    const row = this.db.query("SELECT * FROM operations WHERE id = ?").get(id) as OpRow | null;
    return row ? fromRow(row) : undefined;
  }
  put(op: Operation): void { this.db.transaction(() => putRows(this.db, [op]))(); }
  list(filter: { readonly lane?: string; readonly states?: readonly OperationState[] } = {}): Operation[] {
    return readRows(this.db).filter((op) => matches(op, filter));
  }
  close(): void { this.db.close(); }
}

export const openOperations = (config: { readonly stateDir: string; readonly store: StoreKind }): OperationStore =>
  config.store === "sqlite" ? new SqliteOperations(join(config.stateDir, SQLITE_FILE)) : new JsonOperations(config.stateDir);

const write = (store: OperationStore, op: Operation, patch: Partial<Operation>, now: number): Operation => {
  const next: Operation = { ...op, ...patch, updatedAt: now };
  store.put(next);
  return next;
};

const observe = async (readBack: ReadBack): Promise<Observed> => {
  try { return await readBack(); } catch { return "unknown"; }
};

/** Records the intent of `spec` (state planned) unless a row for it exists; returns the stored row. */
export const plan = (store: OperationStore, now: number, spec: OperationSpec): Operation => {
  const id = operationId(spec);
  const existing = store.get(id);
  if (existing) return existing;
  const op: Operation = { id, ...spec, state: "planned", detail: "planned", attempts: 0, at: now, updatedAt: now };
  store.put(op);
  return op;
};

/**
 * Reconciles a row left `attempted` by a crash: done -> verified, not done -> planned (a retry is allowed), unknown ->
 * ambiguous. Rows in any other state come back unchanged.
 */
export const reconcile = async (store: OperationStore, now: () => number, op: Operation, readBack: ReadBack): Promise<Operation> => {
  if (op.state !== "attempted") return op;
  const seen = await observe(readBack);
  if (seen === "done") return write(store, op, { state: "verified", detail: "read back done after an interrupted attempt" }, now());
  if (seen === "not-done") return write(store, op, { state: "planned", detail: "read back not done after an interrupted attempt; may retry" }, now());
  return write(store, op, { state: "ambiguous", detail: "interrupted attempt and the read-back cannot tell whether it happened" }, now());
};

/**
 * Runs `effect` at most once per verified operation. A verified or ambiguous row returns without acting; an attempted
 * row is reconciled first. A read-back that already shows the effect in place verifies it without acting. Otherwise the
 * row becomes attempted (durably), the effect runs and a read-back decides: done -> verified, not done -> failed (a later
 * call may retry), unknown -> the effect's own report (ok -> verified, else failed). `ran` tells whether the effect ran.
 */
export const perform = async (
  store: OperationStore, now: () => number, spec: OperationSpec, effect: Effect, readBack: ReadBack,
): Promise<{ readonly op: Operation; readonly ran: boolean }> => {
  let op = await reconcile(store, now, plan(store, now(), spec), readBack);
  if (op.state === "verified" || op.state === "ambiguous") return { op, ran: false };
  if ((await observe(readBack)) === "done") return { op: write(store, op, { state: "verified", detail: "read back done before acting" }, now()), ran: false };
  op = write(store, op, { state: "attempted", detail: "attempted", attempts: op.attempts + 1 }, now());
  let report: { readonly ok: boolean; readonly detail: string };
  try { report = await effect(); } catch (e) { report = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  const seen = await observe(readBack);
  const verified = seen === "done" || (seen === "unknown" && report.ok);
  const why = seen === "unknown" ? report.detail || (report.ok ? "effect reported success" : "effect failed") : `read back ${seen}${report.detail ? `: ${report.detail}` : ""}`;
  return { op: write(store, op, { state: verified ? "verified" : "failed", detail: why.replace(/\s+/g, " ").slice(0, 300) }, now()), ran: true };
};

/** Moves a row to a new state by hand or for a sequence (the lead's resolution, an abandoned resume); undefined when unknown. */
export const settleOperation = (store: OperationStore, now: number, id: string, state: OperationState, detail: string): Operation | undefined => {
  const op = store.get(id);
  return op ? write(store, op, { state, detail }, now) : undefined;
};

/** One line per row for `dori ops` and the lead's events. */
export const operationLine = (op: Operation): string =>
  `OP ${op.id} ${op.state} attempts=${op.attempts} ${new Date(op.updatedAt).toISOString()} ${op.detail}`;
