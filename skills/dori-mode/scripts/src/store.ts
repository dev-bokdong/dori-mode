import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { Wake } from "./lead-wakes.ts";
import type { AwaitingAck, Journal, JournalEvent, Notice, OutboxItem, Restart } from "./supervise.ts";

/**
 * Where the supervisor journal lives (config `store`). "json" is today's `supervisor.json`, rewritten whole on every
 * save. "sqlite" is `supervisor.sqlite` (WAL): each save writes only the rows that changed, so an enqueue costs one
 * row instead of the whole history. Both keep `lead-events.log` as the lead's transport; the sqlite store also records
 * each delivery and the log byte offset it has read, so a restart reads only the log tail.
 */
export type StoreKind = "json" | "sqlite";
export const STORE_KINDS: readonly StoreKind[] = ["json", "sqlite"];

export const JOURNAL_FILE = "supervisor.json";
export const SQLITE_FILE = "supervisor.sqlite";
/** The imported `supervisor.json`, kept read-only for audit; it is not the rollback source (that is 0.5's export). */
export const PRE_SQLITE_FILE = "supervisor.json.pre-sqlite";
/** The json store's lead wakes (lead-wakes.ts), one JSON object per line: a wake, or `{close, calls}` closing one. */
export const WAKES_FILE = "lead-wakes.jsonl";
export const SCHEMA_VERSION = 4;
/** Every row belongs to the single lead today; per-lead rows arrive with Phase 3. */
export const DEFAULT_LEAD = "dori";

export class StoreError extends Error {}

const DAY_MS = 24 * 60 * 60_000;
/**
 * Retention per class (sqlite store, Appendix D). Unresolved work is never pruned: undelivered events, the events of
 * tracked owner messages, a pending restart and open PRs. Delivered event bodies leave after `eventBodyMs` for a dedupe
 * tombstone; event and owner tombstones leave after `tombstoneMs`; GitHub status history (closed PR activity, cached
 * responses no poll used) after `statusHistoryMs`.
 */
export const RETENTION = { eventBodyMs: 7 * DAY_MS, tombstoneMs: 90 * DAY_MS, statusHistoryMs: 30 * DAY_MS } as const;

/** `full`: durable against power loss before returning. `normal`: durable against a process crash (WAL). */
export type Durability = "full" | "normal";

export interface JournalStore {
  readonly kind: StoreKind;
  /** The stored journal, or undefined when nothing is stored yet. */
  load(): Journal | undefined;
  /** Persist `journal`; a sqlite store writes only what differs from the last load or save. */
  save(journal: Journal, durability: Durability): void;
  /** Delivered event ids the store recorded; undefined when the delivery log is the only record (json). */
  deliveredIds(): Set<string> | undefined;
  /** Bytes of lead-events.log already reflected in deliveredIds (0 for json: read the whole log). */
  logCursor(): number;
  /** Record deliveries appended to the log, and the log offset they reach. */
  recordDeliveries(ids: readonly string[], cursor: number, at: number): void;
  /** Whether the store prunes delivered event bodies (sqlite); the json journal keeps every event. */
  readonly retains: boolean;
  /** An event id whose body was pruned: still a duplicate until its tombstone expires. */
  tombstoned(id: string): boolean;
  /** Drops event tombstones older than `cutoff` and returns the owner tombstones older than it (the next save drops those). */
  expireTombstones(cutoff: number): string[];
  /** Make every earlier normal write durable against power loss too (the supervisor calls it once per loop pass). */
  sync(): void;
  /** Appends an open lead wake. */
  recordWake(wake: Wake): void;
  /** The latest wake while it is still open. */
  openWake(): Wake | undefined;
  /** Closes the open wake started at `at` with its model calls (undefined: not readable). */
  closeWake(at: number, calls: number | undefined): void;
  /** Drops wakes older than `cutoff` (sqlite; the json store keeps every wake as it keeps every event). */
  pruneWakes(cutoff: number): void;
  close(): void;
}

const appendLine = (path: string, line: string): void => {
  const fd = openSync(path, "a", 0o600);
  try {
    const data = Buffer.from(`${line}\n`);
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
};

/** The wakes of a json store's lead-wakes.jsonl in order, closes applied; a torn last line is skipped. */
const readWakesFile = (path: string): Wake[] => {
  if (!existsSync(path)) return [];
  const wakes: Wake[] = [];
  const byAt = new Map<number, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let row: { close?: unknown; calls?: unknown } & Partial<Wake>;
    try { row = JSON.parse(line); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    if (typeof row.close === "number") {
      const i = byAt.get(row.close);
      if (i !== undefined) wakes[i] = { ...(wakes[i] as Wake), closed: true, ...(typeof row.calls === "number" ? { calls: row.calls } : {}) };
    } else if (typeof row.at === "number" && typeof row.session === "string") {
      byAt.set(row.at, wakes.length);
      wakes.push({ at: row.at, session: row.session, trigger: row.trigger ?? [], kinds: row.kinds ?? {} });
    }
  }
  return wakes;
};

/** Rename only after the new contents reach disk; a crash leaves either complete version. */
export const saveJsonFile = (path: string, value: unknown): void => {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(join(path, ".."), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

class JsonStore implements JournalStore {
  readonly kind = "json" as const;
  constructor(private readonly path: string) {}
  load(): Journal | undefined { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) as Journal : undefined; }
  save(journal: Journal): void { saveJsonFile(this.path, journal); }
  deliveredIds(): undefined { return undefined; }
  logCursor(): number { return 0; }
  recordDeliveries(): void {}
  readonly retains = false;
  tombstoned(): boolean { return false; }
  expireTombstones(): string[] { return []; }
  sync(): void {}
  private get wakesPath(): string { return join(this.path, "..", WAKES_FILE); }
  /** The latest wake, read once from the file and then kept in step with each write. */
  private latest?: { readonly wake: Wake | undefined };
  recordWake(wake: Wake): void {
    appendLine(this.wakesPath, JSON.stringify(wake));
    this.latest = { wake };
  }
  openWake(): Wake | undefined {
    this.latest ??= { wake: readWakesFile(this.wakesPath).at(-1) };
    return this.latest.wake?.closed ? undefined : this.latest.wake;
  }
  closeWake(at: number, calls: number | undefined): void {
    appendLine(this.wakesPath, JSON.stringify({ close: at, ...(calls !== undefined ? { calls } : {}) }));
    if (this.latest?.wake?.at === at) this.latest = { wake: { ...this.latest.wake, closed: true, ...(calls !== undefined ? { calls } : {}) } };
  }
  pruneWakes(): void {}
  close(): void {}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, lead TEXT NOT NULL,
  line TEXT NOT NULL, at INTEGER, at_synthetic INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT PRIMARY KEY, lead TEXT NOT NULL, generation INTEGER NOT NULL, delivered_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS deliveries_at ON deliveries (delivered_at);
CREATE TABLE IF NOT EXISTS owner_messages (
  id TEXT PRIMARY KEY, pos INTEGER NOT NULL, lead TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
  since INTEGER, reminded INTEGER, noticed INTEGER, acked_at INTEGER, tasks INTEGER, lanes TEXT, reply INTEGER,
  handled_at INTEGER, handling_since INTEGER, unhandled_reminded_at INTEGER, revision TEXT, deleted INTEGER);
CREATE INDEX IF NOT EXISTS owner_messages_state ON owner_messages (state, handled_at);
CREATE TABLE IF NOT EXISTS owner_revisions (
  message_id TEXT NOT NULL, revision_id TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (message_id, revision_id));
CREATE TABLE IF NOT EXISTS owner_tombstones (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, closed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS owner_tombstones_closed ON owner_tombstones (closed_at);
CREATE TABLE IF NOT EXISTS owner_notices (
  kind TEXT NOT NULL, message_id TEXT NOT NULL, pos INTEGER NOT NULL, attempts INTEGER NOT NULL, sent INTEGER,
  PRIMARY KEY (kind, message_id));
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, pos INTEGER NOT NULL, text TEXT NOT NULL, attempts INTEGER, next_at INTEGER);
CREATE TABLE IF NOT EXISTS lead_restarts (
  lead TEXT PRIMARY KEY, session TEXT NOT NULL, events TEXT NOT NULL, "offset" INTEGER NOT NULL, phase TEXT NOT NULL,
  strikes INTEGER, unconfirmed INTEGER, model_index INTEGER, reason TEXT, request TEXT, force INTEGER);
CREATE TABLE IF NOT EXISTS lead_state (
  lead TEXT PRIMARY KEY, lead_model INTEGER, primary_retry_at INTEGER, primary_clear_checks INTEGER,
  quota_exhausted TEXT, models TEXT, quota_stall_since INTEGER, lead_busy_since INTEGER, lead_screen TEXT,
  emergency_episode INTEGER);
`;

/**
 * Schema changes after version 1, each applied once in order. Two lanes adding a migration take consecutive numbers.
 * 2: dedupe tombstones of pruned events, and the GitHub poll state that was github-events.json.
 * 3: lead wakes with their trigger kinds and model calls (lead-wakes.ts).
 * 4: the lead's take cursor and push state (`inbox`) and the forced restarts of the last hour (supervise-push.ts).
 */
const MIGRATIONS: readonly (readonly [number, string | ((db: Database) => void)])[] = [[2, `
CREATE TABLE IF NOT EXISTS event_tombstones (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_tombstones_at ON event_tombstones (at);
CREATE TABLE IF NOT EXISTS gh_repos (repo TEXT PRIMARY KEY, polled INTEGER NOT NULL DEFAULT 0, issues INTEGER NOT NULL DEFAULT 0, failed_at INTEGER);
CREATE TABLE IF NOT EXISTS gh_prs (
  repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, sha TEXT NOT NULL, branch TEXT NOT NULL, updated TEXT NOT NULL,
  url TEXT NOT NULL, conflicting INTEGER NOT NULL, checks TEXT NOT NULL, activity TEXT NOT NULL, PRIMARY KEY (repo, number)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gh_issues (
  repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, reopens INTEGER NOT NULL, PRIMARY KEY (repo, number)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gh_cache (
  repo TEXT NOT NULL, path TEXT NOT NULL, etag TEXT, body TEXT NOT NULL, next TEXT, used_at INTEGER, PRIMARY KEY (repo, path));
CREATE INDEX IF NOT EXISTS gh_cache_used ON gh_cache (used_at);
`], [3, `
CREATE TABLE IF NOT EXISTS lead_wakes (
  seq INTEGER PRIMARY KEY, lead TEXT NOT NULL, at INTEGER NOT NULL, session TEXT NOT NULL, trigger TEXT NOT NULL, kinds TEXT NOT NULL,
  calls INTEGER, closed INTEGER);
CREATE INDEX IF NOT EXISTS lead_wakes_at ON lead_wakes (at);
`], [4, (db) => addColumns(db, "lead_state", ["inbox TEXT", "forced_restarts TEXT"])]];

/** ADD COLUMN has no IF NOT EXISTS: a migration replayed over a database that already has a column must skip it. */
const addColumns = (db: Database, table: string, columns: readonly string[]): void => {
  const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
  for (const column of columns) if (!have.has(column.split(" ")[0] ?? "")) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
};

/** `noticed[]` (ids that already got the legacy "not taken yet" notice) shares owner_notices under this kind. */
const NOTICED_KIND = "noticed";

/** Journal scalars kept in lead_state, with their column. */
const LEAD_STATE = [
  ["leadModel", "lead_model", false], ["primaryRetryAt", "primary_retry_at", false], ["primaryClearChecks", "primary_clear_checks", false],
  ["quotaExhausted", "quota_exhausted", true], ["models", "models", true], ["quotaStallSince", "quota_stall_since", false],
  ["leadBusySince", "lead_busy_since", false], ["leadScreen", "lead_screen", true], ["emergencyEpisode", "emergency_episode", false],
  ["inbox", "inbox", true], ["forcedRestarts", "forced_restarts", true],
] as const satisfies readonly (readonly [keyof Journal, string, boolean])[];

/** Every Journal field this store maps (Appendix D). An import refuses a journal with any other field. */
export const JOURNAL_FIELDS: readonly string[] = ["events", "awaitingAck", "notifications", "restart", "noticed", "closedOwners", "outbox", ...LEAD_STATE.map(([field]) => field)];

type Row = Record<string, string | number | null>;
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : undefined);
const kindOf = (line: string): string => line.split(" ", 1)[0] ?? "";
/** `quarantined` comes first: it is the one state no other column records, so it must survive a round trip. */
const ownerState = (entry: AwaitingAck): string =>
  entry.quarantined ? "quarantined" : entry.deleted ? "deleted" : entry.handledAt !== undefined ? "handled" : entry.ackedAt !== undefined ? "acked" : "open";

/**
 * The SQLite journal. It keeps the last journal it loaded or saved and writes the difference in one transaction:
 * events by array position (they only ever append), owner rows, notices and the outbox by id, scalars by value. The
 * supervisor lock makes it the only writer, so that snapshot is the database's content.
 */
export class SqliteStore implements JournalStore {
  readonly kind = "sqlite" as const;
  private readonly db: Database;
  private last: Journal = { events: [] };
  /** How many events of `last.events` are stored: the supervisor appends to that array in place. */
  private storedEvents = 0;
  private synthetic = new Set<string>();
  private nextPos = 0;
  private durability?: Durability;
  private journalMarked = false;
  private unsynced = false;
  private readonly stmt;
  private readonly now: () => number;
  readonly retains = true;

  constructor(readonly path: string, options: { readonly create?: boolean; readonly wal?: boolean; readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    if (!options.create && !existsSync(path)) throw new StoreError(`STORE_MISSING ${path}`);
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(`PRAGMA journal_mode = ${options.wal === false ? "DELETE" : "WAL"}`);
      this.db.exec("PRAGMA busy_timeout = 5000");
      // Checkpoints are the only fsyncs of a normal commit: 4000 pages (about 16 MB of WAL) keeps them rare.
      this.db.exec("PRAGMA wal_autocheckpoint = 4000");
      const check = this.db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
      if (check?.quick_check !== "ok") throw new StoreError(`STORE_CORRUPT ${path}: ${check?.quick_check ?? "no result"}`);
      this.db.exec(SCHEMA);
      const version = Number(this.meta("schema_version") ?? 1);
      if (version > SCHEMA_VERSION) throw new StoreError(`STORE_SCHEMA ${path}: version ${version}, this code reads ${SCHEMA_VERSION}`);
      for (const [to, ddl] of MIGRATIONS) {
        if (to > version) this.db.transaction(() => { if (typeof ddl === "string") this.db.exec(ddl); else ddl(this.db); this.setMeta("schema_version", String(to)); })();
      }
      if (this.meta("schema_version") === undefined) this.setMeta("schema_version", String(SCHEMA_VERSION));
    } catch (e) {
      this.db.close();
      throw e;
    }
    const db = this.db;
    this.stmt = {
      event: db.prepare(`INSERT INTO events (id, kind, lead, line, at, at_synthetic) VALUES ($id, $kind, $lead, $line, $at, $synthetic)
        ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, line = excluded.line, at = excluded.at, at_synthetic = excluded.at_synthetic`),
      eventDelete: db.prepare("DELETE FROM events WHERE id = ?"),
      deliveryDelete: db.prepare("DELETE FROM deliveries WHERE event_id = ?"),
      eventTombstone: db.prepare("INSERT OR IGNORE INTO event_tombstones (id, at) VALUES (?, ?)"),
      tombstoned: db.prepare("SELECT 1 AS hit FROM event_tombstones WHERE id = ?"),
      owner: db.prepare(`INSERT INTO owner_messages (id, pos, lead, generation, state, since, reminded, noticed, acked_at, tasks, lanes, reply,
          handled_at, handling_since, unhandled_reminded_at, revision, deleted)
        VALUES ($id, $pos, $lead, 0, $state, $since, $reminded, $noticed, $acked_at, $tasks, $lanes, $reply, $handled_at, $handling_since,
          $unhandled_reminded_at, $revision, $deleted)
        ON CONFLICT (id) DO UPDATE SET state = excluded.state, since = excluded.since, reminded = excluded.reminded, noticed = excluded.noticed,
          acked_at = excluded.acked_at, tasks = excluded.tasks, lanes = excluded.lanes, reply = excluded.reply, handled_at = excluded.handled_at,
          handling_since = excluded.handling_since, unhandled_reminded_at = excluded.unhandled_reminded_at, revision = excluded.revision,
          deleted = excluded.deleted`),
      ownerDelete: db.prepare("DELETE FROM owner_messages WHERE id = ?"),
      revisionsDelete: db.prepare("DELETE FROM owner_revisions WHERE message_id = ?"),
      revision: db.prepare("INSERT OR IGNORE INTO owner_revisions (message_id, revision_id, pos) VALUES (?, ?, ?)"),
      tombstone: db.prepare("INSERT OR IGNORE INTO owner_tombstones (id, pos, closed_at) VALUES (?, ?, ?)"),
      tombstoneDelete: db.prepare("DELETE FROM owner_tombstones WHERE id = ?"),
      notice: db.prepare(`INSERT INTO owner_notices (kind, message_id, pos, attempts, sent) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (kind, message_id) DO UPDATE SET attempts = excluded.attempts, sent = excluded.sent`),
      noticeDelete: db.prepare("DELETE FROM owner_notices WHERE kind = ? AND message_id = ?"),
      outbox: db.prepare(`INSERT INTO outbox (id, pos, text, attempts, next_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET text = excluded.text, attempts = excluded.attempts, next_at = excluded.next_at`),
      outboxDelete: db.prepare("DELETE FROM outbox WHERE id = ?"),
      restart: db.prepare(`INSERT OR REPLACE INTO lead_restarts (lead, session, events, "offset", phase, strikes, unconfirmed, model_index, reason, request, force)
        VALUES ($lead, $session, $events, $offset, $phase, $strikes, $unconfirmed, $model_index, $reason, $request, $force)`),
      restartDelete: db.prepare("DELETE FROM lead_restarts WHERE lead = ?"),
      leadState: db.prepare(`INSERT OR REPLACE INTO lead_state (lead, ${LEAD_STATE.map(([, column]) => column).join(", ")})
        VALUES ($lead, ${LEAD_STATE.map(([, column]) => `$${column}`).join(", ")})`),
      delivery: db.prepare("INSERT OR IGNORE INTO deliveries (event_id, lead, generation, delivered_at) VALUES (?, ?, 0, ?)"),
    };
  }

  meta(key: string): string | undefined {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /** A transaction outside save (the import's cursors); `full` syncs before returning. */
  transaction(durability: Durability, body: () => void): void {
    if (this.durability !== durability) {
      this.db.exec(`PRAGMA synchronous = ${durability === "full" ? "FULL" : "NORMAL"}`);
      this.durability = durability;
    }
    this.db.transaction(body)();
    this.unsynced = durability === "normal";
  }

  sync(): void {
    if (!this.unsynced) return;
    // A checkpoint syncs the WAL first, so every normal commit before it survives power loss.
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    this.unsynced = false;
  }

  load(): Journal | undefined {
    const journal = this.read(false);
    this.last = journal;
    this.storedEvents = journal.events.length;
    this.journalMarked = this.meta("journal") !== undefined;
    return this.journalMarked ? journal : undefined;
  }

  /**
   * The stored journal. `raw` gives it as the source file had it: events whose `at` the import synthesized have none.
   * Otherwise those events carry the import time, so a restart does not stamp them again.
   */
  read(raw: boolean): Journal {
    const db = this.db;
    this.synthetic = new Set();
    const events = (db.query("SELECT id, line, at, at_synthetic FROM events ORDER BY seq").all() as Row[]).map((row): JournalEvent => {
      const id = String(row.id);
      if (row.at_synthetic) this.synthetic.add(id);
      const at = num(row.at);
      return { id, line: String(row.line), ...(at !== undefined && !(raw && row.at_synthetic) ? { at } : {}) };
    });
    const revisions = new Map<string, string[]>();
    for (const row of db.query("SELECT message_id, revision_id FROM owner_revisions ORDER BY message_id, pos").all() as Row[]) {
      const list = revisions.get(String(row.message_id)) ?? [];
      list.push(String(row.revision_id));
      revisions.set(String(row.message_id), list);
    }
    const owners = db.query("SELECT * FROM owner_messages ORDER BY pos").all() as Row[];
    const awaitingAck = owners.map((row): AwaitingAck => {
      const lanes = json(row.lanes) as string[] | undefined;
      const revs = revisions.get(String(row.id));
      const entry: Record<string, unknown> = {
        id: String(row.id), since: num(row.since), reminded: row.reminded ? true : undefined, noticed: row.noticed ? true : undefined,
        ackedAt: num(row.acked_at), tasks: num(row.tasks), lanes, reply: row.reply === null ? undefined : row.reply === 1,
        handledAt: num(row.handled_at), handlingSince: num(row.handling_since), unhandledRemindedAt: num(row.unhandled_reminded_at),
        revision: str(row.revision), revisions: revs, deleted: row.deleted ? true : undefined,
        quarantined: row.state === "quarantined" ? true : undefined,
      };
      return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as AwaitingAck;
    });
    const notifications: Record<string, Notice> = {};
    const noticed: string[] = [];
    for (const row of db.query("SELECT * FROM owner_notices ORDER BY pos").all() as Row[]) {
      if (row.kind === NOTICED_KIND) { noticed.push(String(row.message_id)); continue; }
      notifications[`${row.kind}:${row.message_id}`] = { attempts: Number(row.attempts), ...(row.sent ? { sent: true as const } : {}) };
    }
    const closedOwners = (db.query("SELECT id FROM owner_tombstones ORDER BY pos").all() as Row[]).map((row) => String(row.id));
    const outbox = (db.query("SELECT * FROM outbox ORDER BY pos").all() as Row[]).map((row): OutboxItem => ({
      id: String(row.id), text: String(row.text),
      ...(num(row.attempts) !== undefined ? { attempts: Number(row.attempts) } : {}), ...(num(row.next_at) !== undefined ? { retryAt: Number(row.next_at) } : {}),
    }));
    const restartRow = db.query("SELECT * FROM lead_restarts WHERE lead = ?").get(DEFAULT_LEAD) as Row | null;
    const state = db.query("SELECT * FROM lead_state WHERE lead = ?").get(DEFAULT_LEAD) as Row | null;
    const scalars: Record<string, unknown> = {};
    for (const [field, column, isJson] of LEAD_STATE) {
      const value = state?.[column];
      if (value !== null && value !== undefined) scalars[field] = isJson ? json(value) : value;
    }
    const maxPos = db.query(`SELECT max(p) AS p FROM (SELECT max(pos) AS p FROM owner_messages UNION ALL SELECT max(pos) FROM owner_notices
      UNION ALL SELECT max(pos) FROM owner_tombstones UNION ALL SELECT max(pos) FROM outbox UNION ALL SELECT max(pos) FROM owner_revisions)`).get() as { p: number | null };
    this.nextPos = (maxPos.p ?? -1) + 1;
    return {
      events, awaitingAck, notifications, noticed, closedOwners, outbox,
      ...(restartRow ? { restart: restartOf(restartRow) } : {}),
      ...scalars,
    } as Journal;
  }

  save(journal: Journal, durability: Durability): void {
    const prev = this.last;
    if (prev === journal && journal.events.length === this.storedEvents) return;
    const ops: (() => void)[] = [];
    this.diffEvents(prev.events, journal.events, ops);
    this.diffOwners(prev.awaitingAck ?? [], journal.awaitingAck ?? [], ops);
    this.diffNotices(prev, journal, ops);
    this.diffList(prev.closedOwners ?? [], journal.closedOwners ?? [], ops,
      (id) => this.stmt.tombstone.run(id, this.nextPos++, this.now()), (id) => this.stmt.tombstoneDelete.run(id));
    this.diffOutbox(prev.outbox ?? [], journal.outbox ?? [], ops);
    if (prev.restart !== journal.restart) {
      const restart = journal.restart;
      ops.push(restart ? () => this.stmt.restart.run(restartRow(restart)) : () => this.stmt.restartDelete.run(DEFAULT_LEAD));
    }
    if (LEAD_STATE.some(([field]) => prev[field] !== journal[field])) {
      const row: Row = { lead: DEFAULT_LEAD };
      for (const [field, column, isJson] of LEAD_STATE) {
        const value = journal[field];
        row[column] = value === undefined ? null : isJson ? JSON.stringify(value) : value as number;
      }
      ops.push(() => this.stmt.leadState.run(row));
    }
    if (!this.journalMarked) {
      ops.push(() => this.setMeta("journal", "1"));
      this.journalMarked = true;
    }
    this.last = journal;
    this.storedEvents = journal.events.length;
    if (!ops.length) return;
    this.transaction(durability, () => { for (const op of ops) op(); });
  }

  private diffEvents(prev: readonly JournalEvent[], next: readonly JournalEvent[], ops: (() => void)[]): void {
    // `prev` may have grown in place since it was stored: only its first `stored` entries are in the database.
    const stored = this.storedEvents;
    const write = (event: JournalEvent, old: JournalEvent | undefined) => {
      // An event the import stamped keeps its synthetic flag while its time stays the stamped one.
      const synthetic = this.synthetic.has(event.id) && old?.at === event.at;
      ops.push(() => this.stmt.event.run({ id: event.id, kind: kindOf(event.line), lead: DEFAULT_LEAD, line: event.line, at: event.at ?? null, synthetic: synthetic ? 1 : 0 }));
    };
    if (prev === next) {
      // Appended in place: only the tail beyond what is stored is new.
      for (let i = stored; i < next.length; i++) write(next[i] as JournalEvent, undefined);
      return;
    }
    // Pruned (retention): the same event objects in order, some dropped, maybe some appended. One walk, no hashing.
    const removed: JournalEvent[] = [];
    let j = 0;
    for (let i = 0; i < stored; i++) {
      if (j < next.length && prev[i] === next[j]) j++;
      else removed.push(prev[i] as JournalEvent);
    }
    const appended = new Set(next.slice(j).map((event) => event.id));
    if (!removed.some((event) => appended.has(event.id))) {
      for (let k = j; k < next.length; k++) write(next[k] as JournalEvent, undefined);
      for (const event of removed) this.dropEvent(event, ops);
      return;
    }
    // Otherwise (startup mapping) compare by id, so changed events are rewritten and nothing else.
    const before = new Map<string, JournalEvent>();
    for (let i = 0; i < stored; i++) before.set((prev[i] as JournalEvent).id, prev[i] as JournalEvent);
    const keep = new Set<string>();
    for (const event of next) {
      keep.add(event.id);
      const old = before.get(event.id);
      if (old === event || (old && old.line === event.line && old.at === event.at)) continue;
      write(event, old);
    }
    for (const [id, event] of before) if (!keep.has(id)) this.dropEvent(event, ops);
  }

  /** An event that leaves the journal leaves a dedupe tombstone, and its delivery row goes with it. */
  private dropEvent(event: JournalEvent, ops: (() => void)[]): void {
    ops.push(() => { this.stmt.eventDelete.run(event.id); this.stmt.deliveryDelete.run(event.id); this.stmt.eventTombstone.run(event.id, event.at ?? this.now()); });
  }

  private diffOwners(prev: readonly AwaitingAck[], next: readonly AwaitingAck[], ops: (() => void)[]): void {
    if (prev === next) return;
    // Fast path: the same entries in place, some changed or appended (the usual trackOwners/tick shape).
    let aligned = next.length >= prev.length;
    for (let i = 0; aligned && i < prev.length; i++) if ((prev[i] as AwaitingAck).id !== (next[i] as AwaitingAck).id) aligned = false;
    const before = aligned ? undefined : new Map(prev.map((entry) => [entry.id, entry]));
    for (let i = 0; i < next.length; i++) {
      const entry = next[i] as AwaitingAck;
      const old = aligned ? prev[i] : before?.get(entry.id);
      if (old !== entry) this.writeOwner(old, entry, ops);
    }
    if (!aligned) {
      const keep = new Set(next.map((entry) => entry.id));
      for (const entry of prev) if (!keep.has(entry.id)) ops.push(() => { this.stmt.ownerDelete.run(entry.id); this.stmt.revisionsDelete.run(entry.id); });
    }
  }

  private writeOwner(old: AwaitingAck | undefined, entry: AwaitingAck, ops: (() => void)[]): void {
    ops.push(() => {
      this.stmt.owner.run({
        id: entry.id, pos: this.nextPos++, lead: DEFAULT_LEAD, state: ownerState(entry), since: entry.since ?? null,
        reminded: entry.reminded ? 1 : null, noticed: entry.noticed ? 1 : null, acked_at: entry.ackedAt ?? null, tasks: entry.tasks ?? null,
        lanes: entry.lanes === undefined ? null : JSON.stringify(entry.lanes), reply: entry.reply === undefined ? null : entry.reply ? 1 : 0,
        handled_at: entry.handledAt ?? null, handling_since: entry.handlingSince ?? null, unhandled_reminded_at: entry.unhandledRemindedAt ?? null,
        revision: entry.revision ?? null, deleted: entry.deleted ? 1 : null,
      });
      if (old?.revisions === entry.revisions) return;
      const had = new Set(old?.revisions ?? []);
      // Revisions only append; a reopened message starts a new list, which replaces the old one.
      if (!(entry.revisions ?? []).every((id, i) => i >= had.size || old?.revisions?.[i] === id)) { this.stmt.revisionsDelete.run(entry.id); had.clear(); }
      for (const id of entry.revisions ?? []) if (!had.has(id)) this.stmt.revision.run(entry.id, id, this.nextPos++);
    });
  }

  private diffNotices(prev: Journal, next: Journal, ops: (() => void)[]): void {
    if (prev.notifications !== next.notifications) {
      const before = prev.notifications ?? {};
      const after = next.notifications ?? {};
      for (const [key, notice] of Object.entries(after)) {
        if (before[key] === notice) continue;
        const at = key.indexOf(":");
        ops.push(() => this.stmt.notice.run(key.slice(0, at), key.slice(at + 1), this.nextPos++, notice.attempts, notice.sent ? 1 : null));
      }
      for (const key of Object.keys(before)) {
        if (key in after) continue;
        const at = key.indexOf(":");
        ops.push(() => this.stmt.noticeDelete.run(key.slice(0, at), key.slice(at + 1)));
      }
    }
    this.diffList(prev.noticed ?? [], next.noticed ?? [], ops,
      (id) => this.stmt.notice.run(NOTICED_KIND, id, this.nextPos++, 0, 1), (id) => this.stmt.noticeDelete.run(NOTICED_KIND, id));
  }

  private diffList(prev: readonly string[], next: readonly string[], ops: (() => void)[], add: (id: string) => void, remove: (id: string) => void): void {
    if (prev === next) return;
    // Appended to (owner compaction): only the new tail is written, without hashing the whole list.
    if (next.length >= prev.length && prev.every((id, i) => next[i] === id)) {
      for (const id of next.slice(prev.length)) ops.push(() => add(id));
      return;
    }
    const before = new Set(prev);
    const after = new Set(next);
    for (const id of after) if (!before.has(id)) ops.push(() => add(id));
    for (const id of before) if (!after.has(id)) ops.push(() => remove(id));
  }

  private diffOutbox(prev: readonly OutboxItem[], next: readonly OutboxItem[], ops: (() => void)[]): void {
    if (prev === next) return;
    const before = new Map(prev.map((item) => [item.id, item]));
    for (const item of next) {
      if (before.get(item.id) === item) continue;
      ops.push(() => this.stmt.outbox.run(item.id, this.nextPos++, item.text, item.attempts ?? null, item.retryAt ?? null));
    }
    const keep = new Set(next.map((item) => item.id));
    for (const item of prev) if (!keep.has(item.id)) ops.push(() => this.stmt.outboxDelete.run(item.id));
  }

  deliveredIds(): Set<string> {
    return new Set((this.db.query("SELECT event_id FROM deliveries").all() as Row[]).map((row) => String(row.event_id)));
  }

  logCursor(): number { return Number(this.meta("log_offset") ?? 0); }

  tombstoned(id: string): boolean { return this.stmt.tombstoned.get(id) !== null; }

  expireTombstones(cutoff: number): string[] {
    this.transaction("normal", () => { this.db.query("DELETE FROM event_tombstones WHERE at < ?").run(cutoff); });
    return (this.db.query("SELECT id FROM owner_tombstones WHERE closed_at < ?").all(cutoff) as Row[]).map((row) => String(row.id));
  }

  /** The database, for the GitHub poll state that shares it (github-events.ts). */
  get database(): Database { return this.db; }

  recordDeliveries(ids: readonly string[], cursor: number, at: number): void {
    // The log line is already fsynced: a lost row is recovered from the log tail at the next start.
    this.transaction("normal", () => {
      for (const id of ids) this.stmt.delivery.run(id, DEFAULT_LEAD, at);
      this.setMeta("log_offset", String(cursor));
    });
  }

  recordWake(wake: Wake): void {
    this.transaction("normal", () => {
      this.db.query("INSERT INTO lead_wakes (lead, at, session, trigger, kinds) VALUES (?, ?, ?, ?, ?)")
        .run(DEFAULT_LEAD, wake.at, wake.session, JSON.stringify(wake.trigger), JSON.stringify(wake.kinds));
    });
  }

  openWake(): Wake | undefined {
    const row = this.db.query("SELECT * FROM lead_wakes WHERE lead = ? ORDER BY seq DESC LIMIT 1").get(DEFAULT_LEAD) as Row | null;
    return row && !row.closed ? wakeOf(row) : undefined;
  }

  closeWake(at: number, calls: number | undefined): void {
    this.transaction("normal", () => {
      this.db.query("UPDATE lead_wakes SET calls = ?, closed = 1 WHERE lead = ? AND at = ? AND closed IS NULL").run(calls ?? null, DEFAULT_LEAD, at);
    });
  }

  pruneWakes(cutoff: number): void {
    this.transaction("normal", () => { this.db.query("DELETE FROM lead_wakes WHERE at < ?").run(cutoff); });
  }

  counts(): Record<string, number> {
    const tables = ["events", "deliveries", "owner_messages", "owner_revisions", "owner_tombstones", "owner_notices", "outbox", "lead_restarts", "lead_state",
      "event_tombstones", "gh_repos", "gh_prs", "gh_issues", "gh_cache", "lead_wakes"];
    return Object.fromEntries(tables.map((table) => [table, (this.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]));
  }

  markSynthetic(ids: readonly string[]): void {
    const mark = this.db.prepare("UPDATE events SET at_synthetic = 1 WHERE id = ?");
    this.transaction("normal", () => { for (const id of ids) mark.run(id); });
    for (const id of ids) this.synthetic.add(id);
  }

  close(): void { this.db.close(); }
}

const wakeOf = (row: Row): Wake => ({
  at: Number(row.at), session: String(row.session), trigger: json(row.trigger) as string[], kinds: json(row.kinds) as Record<string, number>,
  ...(row.closed ? { closed: true as const } : {}), ...(num(row.calls) !== undefined ? { calls: Number(row.calls) } : {}),
});

/** Wakes since `since` from this state dir's store on disk, oldest first (read-only; [] when none or unreadable). */
export const readWakes = (stateDir: string, since: number): Wake[] => {
  try {
    if (storeOnDisk(stateDir) === "json") return readWakesFile(join(stateDir, WAKES_FILE)).filter((wake) => wake.at >= since);
    const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
    try { return (db.query("SELECT * FROM lead_wakes WHERE at >= ? ORDER BY seq").all(since) as Row[]).map(wakeOf); } finally { db.close(); }
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    return [];
  }
};

const restartRow = (restart: Restart): Row => ({
  lead: DEFAULT_LEAD, session: restart.session, events: JSON.stringify(restart.events), offset: restart.offset, phase: restart.phase,
  strikes: restart.strikes ?? null, unconfirmed: restart.unconfirmed ?? null, model_index: restart.modelIndex ?? null,
  reason: restart.reason ?? null, request: restart.request === undefined ? null : JSON.stringify(restart.request), force: restart.force ? 1 : null,
});

const restartOf = (row: Row): Restart => {
  const value: Record<string, unknown> = {
    session: String(row.session), events: json(row.events), offset: Number(row.offset), phase: String(row.phase),
    strikes: num(row.strikes), unconfirmed: num(row.unconfirmed), modelIndex: num(row.model_index), reason: str(row.reason),
    request: json(row.request), force: row.force ? true : undefined,
  };
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Restart;
};

/**
 * The store the supervisor uses for `kind`, refusing a state dir whose files belong to the other kind: a json
 * supervisor next to an imported database would start from an empty journal and replay the whole delivery log, and
 * a sqlite supervisor next to a live supervisor.json would ignore it.
 */
export const openStore = (stateDir: string, kind: StoreKind, now: () => number = Date.now): JournalStore => {
  const jsonPath = join(stateDir, JOURNAL_FILE);
  const sqlitePath = join(stateDir, SQLITE_FILE);
  if (kind === "json") {
    if (!existsSync(jsonPath) && existsSync(sqlitePath)) {
      throw new StoreError(`STORE_MISMATCH ${stateDir} holds an imported ${SQLITE_FILE} and no ${JOURNAL_FILE}; set "store": "sqlite" in the config`);
    }
    return new JsonStore(jsonPath);
  }
  if (kind !== "sqlite") throw new StoreError(`STORE_UNKNOWN store must be one of ${STORE_KINDS.join(", ")}, got ${String(kind)}`);
  if (existsSync(jsonPath)) {
    throw new StoreError(`STORE_IMPORT_PENDING ${jsonPath} exists; stop the supervisor and run dori store import before using "store": "sqlite"`);
  }
  if (!existsSync(sqlitePath) && existsSync(join(stateDir, PRE_SQLITE_FILE))) {
    throw new StoreError(`STORE_MISSING ${sqlitePath} is gone but ${PRE_SQLITE_FILE} shows an import; restore the database before starting`);
  }
  return new SqliteStore(sqlitePath, { create: true, now });
};

/** The store that holds this state dir's journal on disk: sqlite once imported (no supervisor.json left), else json. */
export const storeOnDisk = (stateDir: string): StoreKind =>
  existsSync(join(stateDir, SQLITE_FILE)) && !existsSync(join(stateDir, JOURNAL_FILE)) ? "sqlite" : "json";

/**
 * Read-only views for readers outside the Supervisor (status, emergency approval): they never parse the journal file
 * themselves. Undefined when nothing is stored or it cannot be read.
 */
export const readStoreView = <T>(stateDir: string, view: { readonly json: (journal: Journal) => T; readonly sqlite: (db: Database) => T }): T | undefined => {
  try {
    if (storeOnDisk(stateDir) === "json") return view.json(JSON.parse(readFileSync(join(stateDir, JOURNAL_FILE), "utf8")) as Journal);
    const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
    try { return view.sqlite(db); } finally { db.close(); }
  } catch {
    return undefined;
  }
};
