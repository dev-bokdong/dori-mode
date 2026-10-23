import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { saveJsonFile, SQLITE_FILE, StoreError, type StoreKind } from "./store.ts";
import { withStateLockSync } from "./state-lock.ts";

/**
 * Messages the supervisor owes a lane (design 4.5): each has an ID the lane confirms with `dori report ack <id>`.
 * `queued` waits for a safe moment (the pane exists, runs an agent, is idle, the lane is not paused); `delivered` was
 * typed once into that pane; `acked` is the lane's explicit confirmation; `superseded` is no longer true (a newer head
 * SHA, checks no longer failing, the lane closed). Pane activity never counts as a confirmation.
 */
export type LaneMessageState = "queued" | "delivered" | "acked" | "superseded";

export type LaneMessage = {
  /** What the lane types back: `dori report ack <id>`. Words, dots and dashes only. */
  readonly id: string;
  readonly lane: string;
  /** What it is about, e.g. `owner/repo#12@<head sha>`: a newer subject supersedes an open message. */
  readonly subject: string;
  readonly text: string;
  readonly state: LaneMessageState;
  readonly at: number;
  readonly deliveredAt?: number;
  readonly ackedAt?: number;
  /** When the lead was told the lane has not confirmed; at most once per message. */
  readonly escalatedAt?: number;
  /** Why the last delivery attempt did not send (busy, paused, missing pane, ...). */
  readonly blocked?: string;
  readonly updatedAt: number;
};

export const LANE_MESSAGE_ID = /^[\w.-]{1,120}$/;
export const OPEN_MESSAGE_STATES: readonly LaneMessageState[] = ["queued", "delivered"];

export class LaneMessageError extends Error {}

export interface LaneMessageStore {
  get(id: string): LaneMessage | undefined;
  /** Durable before returning: a delivery operation may follow. */
  put(message: LaneMessage): void;
  list(filter?: { readonly lane?: string; readonly states?: readonly LaneMessageState[] }): LaneMessage[];
  close(): void;
}

export const LANE_MESSAGES_FILE = "lane-messages.json";
const LANE_MESSAGES_LOCK = "lane-messages.lock.sqlite";

const order = (a: LaneMessage, b: LaneMessage): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const matches = (m: LaneMessage, filter: { readonly lane?: string; readonly states?: readonly LaneMessageState[] }): boolean =>
  (filter.lane === undefined || m.lane === filter.lane) && (filter.states === undefined || filter.states.includes(m.state));

/** `lane-messages.json` beside supervisor.json, rewritten whole under a short state lock (CLI and supervisor both write). */
export class JsonLaneMessages implements LaneMessageStore {
  private readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, LANE_MESSAGES_FILE);
    this.lock = join(stateDir, LANE_MESSAGES_LOCK);
  }
  private read(): Record<string, LaneMessage> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { messages: Record<string, LaneMessage> }).messages : {};
  }
  get(id: string): LaneMessage | undefined { return this.read()[id]; }
  put(message: LaneMessage): void {
    withStateLockSync(this.lock, () => { saveJsonFile(this.path, { messages: { ...this.read(), [message.id]: message } }); });
  }
  list(filter: { readonly lane?: string; readonly states?: readonly LaneMessageState[] } = {}): LaneMessage[] {
    return Object.values(this.read()).filter((m) => matches(m, filter)).sort(order);
  }
  close(): void {}
}

/** Created on first use like the operations table, not by a schema migration. */
const DDL = `CREATE TABLE IF NOT EXISTS lane_messages (id TEXT PRIMARY KEY, lane TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS lane_messages_open ON lane_messages (state, lane);`;

export class SqliteLaneMessages implements LaneMessageStore {
  private readonly db: Database;
  constructor(path: string) {
    if (!existsSync(path)) throw new StoreError(`STORE_MISSING ${path}; lane messages live in the sqlite store`);
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
  get(id: string): LaneMessage | undefined {
    const row = this.db.query("SELECT body FROM lane_messages WHERE id = ?").get(id) as { body: string } | null;
    return row ? (JSON.parse(row.body) as LaneMessage) : undefined;
  }
  put(m: LaneMessage): void {
    this.db.query("INSERT OR REPLACE INTO lane_messages (id, lane, state, at, body) VALUES (?, ?, ?, ?, ?)").run(m.id, m.lane, m.state, m.at, JSON.stringify(m));
  }
  list(filter: { readonly lane?: string; readonly states?: readonly LaneMessageState[] } = {}): LaneMessage[] {
    return (this.db.query("SELECT body FROM lane_messages ORDER BY at, id").all() as { body: string }[])
      .map((row) => JSON.parse(row.body) as LaneMessage).filter((m) => matches(m, filter));
  }
  close(): void { this.db.close(); }
}

export const openLaneMessages = (config: { readonly stateDir: string; readonly store: StoreKind }): LaneMessageStore =>
  config.store === "sqlite" ? new SqliteLaneMessages(join(config.stateDir, SQLITE_FILE)) : new JsonLaneMessages(config.stateDir);

/** Queues `message` unless a message with its ID exists (the same subject is the same message); returns the stored one. */
export const queueLaneMessage = (store: LaneMessageStore, now: number, message: Pick<LaneMessage, "id" | "lane" | "subject" | "text">): LaneMessage => {
  if (!LANE_MESSAGE_ID.test(message.id)) throw new LaneMessageError(`lane message id must match ${LANE_MESSAGE_ID}`);
  const existing = store.get(message.id);
  if (existing) return existing;
  const queued: LaneMessage = { ...message, state: "queued", at: now, updatedAt: now };
  store.put(queued);
  return queued;
};

export const updateLaneMessage = (store: LaneMessageStore, message: LaneMessage, patch: Partial<LaneMessage>, now: number): LaneMessage => {
  const next: LaneMessage = { ...message, ...patch, updatedAt: now };
  store.put(next);
  return next;
};

/**
 * The lane's confirmation (`dori report ack <id>`): only the lane the message is addressed to may confirm it. Acking an
 * acked message is a no-op; a superseded one is still recorded as acked (the lane read it).
 */
export const ackLaneMessage = (store: LaneMessageStore, lane: string, id: string, now: number): LaneMessage => {
  const message = store.get(id);
  if (!message) throw new LaneMessageError(`no lane message "${id}"`);
  if (message.lane !== lane) throw new LaneMessageError(`lane message ${id} is addressed to lane ${message.lane}, not ${lane}`);
  if (message.state === "acked") return message;
  return updateLaneMessage(store, message, { state: "acked", ackedAt: now }, now);
};
