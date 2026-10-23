import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, statSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import type { LeadRestartRequest } from "./lead-restart.ts";
import { eventClass, forLead } from "./event-policy.ts";
import { WakeMeter } from "./lead-wakes.ts";
import { redactSecrets } from "./redact.ts";
import { type Durability, type JournalStore, openStore, RETENTION, StoreError } from "./store.ts";

/**
 * The supervisor journal: its types, the durable store behind it, the delivery log (lead-events.log) and the in-memory
 * indexes over both (delivered ids, journaled ids, closed owner tombstones). Owner tracking, the lead lifecycle and
 * delivery (supervise-*.ts) all read and write the journal through one JournalCore.
 */

/** `at` is the enqueue time (absent on events journaled by older versions). */
export type Event = { readonly id: string; readonly line: string; readonly at?: number };
export type JournalEvent = Event;
export type Restart = {
  readonly session: string;
  readonly events: readonly Event[];
  readonly offset: number;
  readonly phase: "stopping" | "starting" | "submitted";
  /** Launches that never showed startup evidence; the first one is relaunched at once, later ones wait for backoff. */
  readonly strikes?: number;
  /** Failed confirmations of this submitted session; at UNCONFIRMED_LIMIT the session is abandoned for a fresh one. */
  readonly unconfirmed?: number;
  /** The `leadModels` entry this restart launches; absent means the lead's current one. */
  readonly modelIndex?: number;
  /** Why the model changes (a quota stall), told to the new lead. */
  readonly reason?: string;
  readonly request?: LeadRestartRequest;
  /** Stop the lead even while it is working/blocked (a quota stall past leadQuotaBusySwitchMin, or a stuck lead). */
  readonly force?: true;
};
/**
 * An owner message retained until explicit coverage handles all declared tasks. `since` is when the lead could
 * read it, reset at LEAD_RESTARTED so a cold start's boot never counts against the new lead.
 */
export type AwaitingAck = {
  readonly id: string;
  /** Absent while journaled for a busy lead, or while its cold start is unconfirmed. */
  readonly since?: number;
  readonly reminded?: true;
  readonly noticed?: true;
  readonly ackedAt?: number;
  readonly tasks?: number;
  readonly lanes?: readonly string[];
  readonly reply?: boolean;
  readonly handledAt?: number;
  readonly handlingSince?: number;
  readonly unhandledRemindedAt?: number;
  /** The event id of the owner's latest edit (INBOUND_EDIT); reminders and cold handoffs carry its text. */
  readonly revision?: string;
  /** Every edit/delete event id already applied, so a replay at startup changes nothing. */
  readonly revisions?: readonly string[];
  /** The owner deleted the message: it counts as handled and is never handed to a new lead. */
  readonly deleted?: true;
  /**
   * Found at startup in the event history with neither a tracking row nor a tombstone (tracking was reset, or the
   * journal predates tracking). Listed once to the lead in one OWNER_QUARANTINED digest; never reminded, never noticed
   * to the owner and never handed to a new lead. An ack, a live edit or a delete makes it an ordinary message again.
   */
  readonly quarantined?: true;
};
export type OwnerNoticeKind = "delay" | "ack" | "unhandled";
export type Notice = { readonly attempts: number; readonly sent?: true };
export type Journal = {
  readonly events: readonly Event[];
  readonly awaitingAck?: readonly AwaitingAck[];
  readonly notifications?: Readonly<Record<string, Notice>>;
  readonly restart?: Restart;
  /** Owner messages that already got the "not taken yet" notice. */
  readonly noticed?: readonly string[];
  /** The `leadModels` entry the running lead was started on (absent = the first). */
  readonly leadModel?: number;
  /** While the lead runs on a fallback: when the first model's provider is checked again. */
  readonly primaryRetryAt?: number;
  /** Consecutive primary checks that found it unblocked; the lead returns at leadPrimaryReturnChecks. */
  readonly primaryClearChecks?: number;
  /** An open exhaustion episode: every lead model is blocked on quota. The owner was told once, and is told when it ends. */
  readonly quotaExhausted?: { readonly since: number; readonly model: string; readonly resetAt?: number };
  readonly models?: LeadRestartRequest["models"];
  /** When a working lead was first seen quota-stalled with an automatic fallback left (leadQuotaBusySwitchMin). */
  readonly quotaStallSince?: number;
  /** When the lead was first seen busy while owner messages handed to it were unread (leadStuckRestartMin). */
  readonly leadBusySince?: number;
  /** The working lead's screen (hash) and when it last changed: a working lead counts as stuck only while it is frozen. */
  readonly leadScreen?: { readonly hash: string; readonly since: number };
  /** Owner tracking compacted away once handled for ACK_KEEP_MS: never tracked again from the replayed inbox. */
  readonly closedOwners?: readonly string[];
  /** Owner announcements not yet confirmed posted; retried until they are, so a crash or a failed post loses none. */
  readonly outbox?: readonly OutboxItem[];
  /** While the lead runs on a paid emergency model: the quota episode whose owner approval put it there. */
  readonly emergencyEpisode?: number;
};
export type OutboxItem = { readonly id: string; readonly text: string; readonly attempts?: number; readonly retryAt?: number };

export class SuperviseError extends Error {}

/**
 * A lead state that can clear by itself (pane missing, old lead still exiting, startup not yet
 * confirmed). Delivery retries these with backoff; any other SuperviseError is fatal and exits.
 */
export class TransientSuperviseError extends SuperviseError {}

/** How often retention runs (from ackTick, once per loop pass at most). */
export const RETAIN_EVERY_MS = 60 * 60_000;

/** The bytes of `path` from `from` to `to`. */
const readRange = (path: string, from: number, to: number): Buffer => {
  const data = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(path, "r");
  try {
    let at = 0;
    while (at < data.length) {
      const read = readSync(fd, data, at, data.length - at, from + at);
      if (read === 0) break;
      at += read;
    }
    return data.subarray(0, at);
  } finally { closeSync(fd); }
};

export const append = (path: string, text: string): void => {
  const fd = openSync(path, "a", 0o600);
  try {
    const data = Buffer.from(text);
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
};

/** The journal state shared by the supervisor's parts. `deps` is replaced when the lead pane is recreated. */
export class JournalCore {
  readonly eventLog: string;
  readonly store: JournalStore;
  journal: Journal;
  readonly delivered = new Set<string>();
  /** Every journaled event id: enqueue dedupes in O(1) instead of scanning the history. */
  readonly eventIds = new Set<string>();
  readonly wakes: WakeMeter;
  private nextRetain = 0;
  private closed?: { readonly list: readonly string[]; readonly set: ReadonlySet<string> };

  constructor(public deps: FlowDeps) {
    mkdirSync(deps.config.stateDir, { recursive: true });
    this.eventLog = join(deps.config.stateDir, "lead-events.log");
    try { this.store = openStore(deps.config.stateDir, deps.config.store, deps.clock.now); } catch (e) {
      throw e instanceof StoreError ? new SuperviseError(e.message) : e;
    }
    this.wakes = new WakeMeter(this.store, () => this.deps.config, () => this.deps.clock.now());
    const loaded: Journal = this.store.load() ?? { events: [] };
    // Events journaled before enqueue times existed start their queue clock now.
    this.journal = {
      ...loaded,
      events: loaded.events.map((event) => ({ ...event, line: redactSecrets(event.line), at: event.at ?? deps.clock.now() })),
      ...(loaded.restart ? { restart: { ...loaded.restart, events: loaded.restart.events.map((event) => ({ ...event, line: redactSecrets(event.line) })) } } : {}),
    };
  }

  /**
   * Reads the delivery log past the store's cursor into the delivered set, and journals any legacy append that reached
   * disk without a matching inbox entry. Returns the ids read and the log offset they end at.
   */
  recoverLog(): { readonly tail: readonly string[]; readonly cursor: number } {
    const { deps } = this;
    if (!existsSync(this.eventLog)) append(this.eventLog, "");
    // The store's deliveries cover the log up to its cursor (json: none, so the whole log is read).
    for (const id of this.store.deliveredIds() ?? []) this.delivered.add(id);
    const size = statSync(this.eventLog).size;
    let from = this.store.logCursor();
    if (from > size) {
      console.error(`STORE_LOG_SHORTER ${this.eventLog} is ${size} bytes, the store read ${from}; rereading it whole`);
      from = 0;
    }
    // A killed append can leave a partial final line. It was never a delivery.
    const log = readRange(this.eventLog, from, size);
    const end = log.lastIndexOf(10) + 1;
    if (end < log.length) truncateSync(this.eventLog, from + end);
    const known = this.eventIds;
    for (const event of this.journal.events) known.add(event.id);
    const recovered: Event[] = [];
    const tail: string[] = [];
    for (const line of log.subarray(0, end).toString().split("\n")) {
      if (line) {
        const event: Event = JSON.parse(line);
        this.delivered.add(event.id);
        tail.push(event.id);
        // Recover a legacy append that reached disk without a matching durable inbox entry.
        if (!known.has(event.id) && !this.store.tombstoned(event.id)) {
          known.add(event.id);
          recovered.push({ ...event, line: redactSecrets(event.line), at: deps.clock.now() });
        }
      }
    }
    if (recovered.length) this.journal = { ...this.journal, events: [...this.journal.events, ...recovered] };
    return { tail, cursor: from + end };
  }

  /**
   * Writes the journal through the store. `normal` (frequent bookkeeping, digest events) survives a crash; the default
   * `full` also survives power loss, and a later full write makes every earlier normal one durable too.
   */
  persist(durability: Durability = "full"): void {
    this.store.save(this.journal, durability);
  }

  /** Releases the store (tests and shutdown); the supervisor must not be used afterwards. */
  close(): void { this.store.close(); }

  /** closedOwners as a set, rebuilt only when the list changes: it holds up to 90 days of tombstones. */
  closedSet(): ReadonlySet<string> {
    const list = this.journal.closedOwners ?? [];
    if (this.closed?.list !== list) this.closed = { list, set: new Set(list) };
    return this.closed.set;
  }

  /** Journaled now, or pruned with its dedupe tombstone still kept. */
  known(id: string): boolean {
    return this.eventIds.has(id) || this.store.tombstoned(id);
  }

  /**
   * Retention (RETENTION, sqlite store only), at most once per RETAIN_EVERY_MS: delivered events older than
   * eventBodyMs leave the journal for dedupe tombstones, unless a tracked owner message or a pending restart still needs
   * them; undelivered events are never pruned. Tombstones expire after tombstoneMs.
   */
  retain(now: number): void {
    if (!this.store.retains || now < this.nextRetain) return;
    this.nextRetain = now + RETAIN_EVERY_MS;
    const needed = new Set(this.journal.restart?.events.map((event) => event.id) ?? []);
    for (const entry of this.journal.awaitingAck ?? []) for (const id of [entry.id, ...(entry.revisions ?? [])]) needed.add(id);
    const cutoff = now - RETENTION.eventBodyMs;
    // Events are appended in time order: only the prefix up to the first newer one is looked at (one that came out of
    // order waits for the next pass), so a pass costs the pruned events, not the whole journal.
    const all = this.journal.events;
    const kept: Event[] = [];
    let i = 0;
    for (; i < all.length && ((all[i] as Event).at ?? now) <= cutoff; i++) {
      const event = all[i] as Event;
      // An owner-only or engine-only event is never delivered to the lead: it ages out like a delivered one.
      const waiting = !this.delivered.has(event.id) && forLead(eventClass(event.line, this.deps.config.eventPolicy));
      if (waiting || needed.has(event.id)) { kept.push(event); continue; }
      this.eventIds.delete(event.id);
      this.delivered.delete(event.id);
    }
    this.store.pruneWakes(now - RETENTION.statusHistoryMs);
    const expired = new Set(this.store.expireTombstones(now - RETENTION.tombstoneMs));
    if (kept.length === i && !expired.size) return;
    const events = kept.length === i ? all : [...kept, ...all.slice(i)];
    this.journal = {
      ...this.journal, events,
      ...(expired.size ? { closedOwners: (this.journal.closedOwners ?? []).filter((id) => !expired.has(id)) } : {}),
    };
  }

  /** Appends the events not yet delivered to the delivery log (fsynced) and records them as delivered in the store. */
  appendDelivered(events: readonly Event[]): void {
    const appended: string[] = [];
    for (const event of events) {
      if (this.delivered.has(event.id)) continue;
      append(this.eventLog, `${JSON.stringify({ id: event.id, line: redactSecrets(event.line) })}\n`);
      this.delivered.add(event.id);
      appended.push(event.id);
    }
    if (appended.length) this.store.recordDeliveries(appended, statSync(this.eventLog).size, this.deps.clock.now());
  }
}
