import { dropAck, pendingAcks } from "./ack.ts";
import type { FlowDeps } from "./done-flow.ts";
import { redactSecrets } from "./redact.ts";
import type { Durability } from "./store.ts";
import type { AwaitingAck, Event, Journal, JournalCore, OwnerNoticeKind } from "./supervise-journal.ts";

/**
 * Owner tracking: one row per owner message (ack, coverage, revisions, deletion, quarantine), the owner notices owed
 * for it (delay, ack, unhandled), the reactions on it, and the durable outbox of owner announcements.
 */

export const COLD_START_EMOJI = "\u23F3";
export const HUNG_EMOJI = "\u26A0\uFE0F";

/** Side effects the supervisor owner provides; both are best-effort and never decide a restart. */
export type SupervisorHooks = {
  readonly react?: (op: "add" | "remove", channel: string, message: string, emoji: string) => Promise<void>;
  readonly persistLeadPane?: (pane: string) => void;
  /** One plain line for the owner's main channel (lead model switches); `id` is stable across retries of the same line. */
  readonly announce?: (text: string, id: string) => Promise<void>;
};

export const OWNER_INBOUND = /^discord:(\d+):(\d+)$/;
/** INBOUND_EDIT / INBOUND_DELETE ids (discord-inbound.ts): they revise the owner message discord:<channel>:<message>. */
export const OWNER_REVISION = /^discord:(\d+):(\d+):(?:edit:.+|delete)$/;
/** The event that carries an owner message's current text: its latest edit, else the original. */
export const latest = (entry: AwaitingAck): string => entry.revision ?? entry.id;
const unquarantined = (entry: AwaitingAck): AwaitingAck => {
  if (!entry.quarantined) return entry;
  const { quarantined: _, ...rest } = entry;
  return rest;
};
/** The one digest that lists owner messages quarantined at startup, grouped by channel. */
export const quarantineDigest = (ids: readonly string[]): string => {
  const byChannel = new Map<string, string[]>();
  for (const id of ids) {
    const [, channel = "", message = ""] = OWNER_INBOUND.exec(id) ?? [];
    const list = byChannel.get(channel) ?? [];
    list.push(message);
    byChannel.set(channel, list);
  }
  const groups = [...byChannel].map(([channel, messages]) => `${channel}:${messages.join(",")}`).join(" ");
  return `OWNER_QUARANTINED ${ids.length} ${groups} (owner messages from the history with no tracking record: never reminded or handed over; dori ack <channel> <messageId> takes one on)`;
};
/** A failed owner announcement is retried this often, at most OUTBOX_ATTEMPTS times. */
export const OUTBOX_RETRY_MS = 60_000;
export const OUTBOX_ATTEMPTS = 60;

/** An ack receipt nobody waits for is dropped after this; unfinished owner messages never expire. */
export const ACK_KEEP_MS = 24 * 60 * 60_000;
export const OWNER_NOTIFY_ATTEMPTS = 3;
export const OWNER_BODY_MAX = 2_000;

/** How long an owner message may wait for a running lead before the supervisor tells the owner it is queued. */
export const OWNER_NOTICE_AFTER_MS = 60_000;

export type OwnerMessage = { readonly channel: string; readonly message: string };

export class OwnerTracking {
  private reactions: Promise<void> = Promise.resolve();
  private draining = false;

  constructor(
    private readonly core: JournalCore, private readonly hooks: SupervisorHooks,
    private readonly enqueue: (id: string, line: string) => void,
  ) {}

  private get deps(): FlowDeps { return this.core.deps; }
  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }
  private get delivered(): Set<string> { return this.core.delivered; }
  private persist(durability?: Durability): void { this.core.persist(durability); }

  /**
   * Owner messages (INBOUND, id discord:<channel>:<message>) waiting longer than `ms` without reaching a running lead:
   * never appended to the lead's log, or appended only into a cold start that has not confirmed yet. Each is returned
   * until noticeSent confirms delivery, with a bounded number of attempts.
   */
  overdueOwnerMessages(ms: number): OwnerMessage[] {
    const now = this.deps.clock.now();
    const starting = new Set(this.journal.restart?.events.map((event) => event.id) ?? []);
    const waiting = (id: string) => !this.delivered.has(id) || starting.has(id) ||
      this.journal.awaitingAck?.some((entry) => entry.id === id && entry.since === undefined && entry.ackedAt === undefined);
    const noticed = new Set(this.journal.noticed ?? []);
    const quarantined = new Set((this.journal.awaitingAck ?? []).filter((entry) => entry.quarantined).map((entry) => entry.id));
    const due = this.journal.events.filter((event) => event.at !== undefined && now - event.at >= ms &&
      event.line.startsWith("INBOUND ") && OWNER_INBOUND.test(event.id) && !noticed.has(event.id) && !quarantined.has(event.id) && waiting(event.id));
    return this.takeNotices("delay", due);
  }

  /** Read receipts stop ACK_MISSING, but never erase unhandled owner work. */
  ackTick(timeoutMs: number): OwnerMessage[] {
    this.consumeReceipts();
    const now = this.deps.clock.now();
    if (this.journal.restart) return [];
    const notices: AwaitingAck[] = [];
    const overdue: AwaitingAck[] = [];
    const awaiting = (this.journal.awaitingAck ?? []).map((entry): AwaitingAck => {
      // A deleted message is handled without an ack: nothing to remind. A quarantined one was listed in its digest.
      if (entry.quarantined || entry.ackedAt !== undefined || entry.handledAt !== undefined || entry.since === undefined) return entry;
      if (entry.reminded && !entry.noticed && now - entry.since >= 2 * timeoutMs) notices.push(entry);
      if (entry.reminded || now - entry.since < timeoutMs) return entry;
      overdue.push(entry);
      return { ...entry, reminded: true };
    });
    this.journal = { ...this.journal, awaitingAck: awaiting };
    // One ACK_MISSING per tick lists every overdue message, so an incident costs the lead one wake, not one per message.
    // It is enqueued after the reminded marks, so both reach the store in the same write.
    if (overdue.length) {
      const items = overdue.map((entry) => {
        const [, channel, message] = OWNER_INBOUND.exec(entry.id) ?? [];
        return `${channel} ${message} ${this.messageBody(entry.id)}`;
      });
      this.enqueue(`ack-missing:${now}:${Bun.hash(overdue.map((entry) => entry.id).join(" ")).toString(16)}`, `ACK_MISSING ${items.join(" | ")}`);
    }
    this.compactOwners(now);
    this.core.retain(now);
    this.persist("normal");
    this.core.store.sync();
    return this.takeNotices("ack", notices);
  }

  /**
   * Owner messages handled for ACK_KEEP_MS leave the tracking list for a tombstone (their id and edit ids), so the list
   * stays small and the replayed inbox never tracks them again. A later edit of the same message opens it anew.
   */
  private compactOwners(now: number): void {
    const awaiting = this.journal.awaitingAck ?? [];
    const done = awaiting.filter((entry) => entry.handledAt !== undefined && now - entry.handledAt >= ACK_KEEP_MS);
    if (!done.length) return;
    const gone = new Set(done.map((entry) => entry.id));
    const notifications = Object.fromEntries(Object.entries(this.journal.notifications ?? {})
      .filter(([key]) => !gone.has(key.slice(key.indexOf(":") + 1))));
    this.journal = {
      ...this.journal,
      awaitingAck: awaiting.filter((entry) => !gone.has(entry.id)),
      closedOwners: [...new Set([...(this.journal.closedOwners ?? []), ...done.flatMap((entry) => [entry.id, ...(entry.revisions ?? [])])])],
      notifications,
      noticed: this.journal.noticed?.filter((id) => !gone.has(id)),
    };
  }

  /** An explicit ack starts the handling clock. A reminder gets a full second window before owner escalation. */
  handledTick(timeoutMs = this.deps.config.handledTimeoutMin * 60_000): OwnerMessage[] {
    this.consumeReceipts();
    if (this.journal.restart) return [];
    const now = this.deps.clock.now();
    const notices: AwaitingAck[] = [];
    const awaiting = (this.journal.awaitingAck ?? []).map((entry): AwaitingAck => {
      if (entry.handledAt !== undefined || entry.ackedAt === undefined) return entry;
      if (entry.unhandledRemindedAt !== undefined) {
        if (now - entry.unhandledRemindedAt >= timeoutMs) notices.push(entry);
        return entry;
      }
      if (now - (entry.handlingSince ?? entry.ackedAt) < timeoutMs) return entry;
      const [, channel, message] = OWNER_INBOUND.exec(entry.id) ?? [];
      this.enqueue(`unhandled:${entry.id}:${entry.handlingSince ?? entry.ackedAt}`,
        `UNHANDLED ${channel} ${message} coverage=${(entry.lanes?.length ?? 0) + Number(!!entry.reply)}/${entry.tasks ?? 1} ${this.messageBody(entry.id)}`);
      return { ...entry, unhandledRemindedAt: now };
    });
    this.journal = { ...this.journal, awaitingAck: awaiting };
    this.persist("normal");
    return this.takeNotices("unhandled", notices);
  }

  /** Called only after the messenger confirms a successful post. Failures remain eligible on the next tick. */
  noticeSent(kind: OwnerNoticeKind, channel: string, message: string): void {
    const key = `${kind}:discord:${channel}:${message}`;
    const previous = this.journal.notifications?.[key];
    this.journal = { ...this.journal, notifications: { ...this.journal.notifications, [key]: { attempts: previous?.attempts ?? 0, sent: true } } };
    this.persist();
  }

  /** Owner notices still owed. An attempt is counted only by noticeAttempt, right before the post is really tried. */
  private takeNotices(kind: OwnerNoticeKind, entries: readonly { readonly id: string }[]): OwnerMessage[] {
    const due: OwnerMessage[] = [];
    for (const entry of entries) {
      const notice = this.journal.notifications?.[`${kind}:${entry.id}`];
      if (notice?.sent || (notice?.attempts ?? 0) >= OWNER_NOTIFY_ATTEMPTS) continue;
      const [, channel, message] = OWNER_INBOUND.exec(entry.id) ?? [];
      if (!channel || !message) continue;
      due.push({ channel, message });
    }
    return due;
  }

  /** Called right before an owner notice is posted: the attempt counts even if the process dies during the post. */
  noticeAttempt(kind: OwnerNoticeKind, channel: string, message: string): void {
    const key = `${kind}:discord:${channel}:${message}`;
    const previous = this.journal.notifications?.[key];
    this.journal = { ...this.journal, notifications: { ...this.journal.notifications, [key]: { attempts: (previous?.attempts ?? 0) + 1 } } };
    this.persist();
  }

  /** The owner message's current text: its latest edit when there is one. */
  private messageBody(id: string): string {
    const entry = this.journal.awaitingAck?.find((tracked) => tracked.id === id);
    const source = entry ? latest(entry) : id;
    return redactSecrets(this.journal.events.find((event) => event.id === source)?.line ?? "").slice(0, OWNER_BODY_MAX);
  }

  /**
   * Owner messages are tracked per message id with their revisions: an edit becomes the text every reminder and cold
   * handoff carries (an edit of a message already handled, or never tracked, is a new instruction and is tracked from
   * scratch), and a delete marks the message handled so it is never handed over again. Replaying the inbox is a no-op.
   * `historical` (the startup pass over the history): a message found there with neither a row nor a tombstone gets a
   * quarantined row instead of an open one. Returns the ids it quarantined that are still quarantined.
   */
  trackOwners(events: readonly Event[], historical = false): string[] {
    // Most events are not owner messages: skip rebuilding the index (O(tracked) per enqueue) when none is.
    if (this.journal.awaitingAck && !events.some((event) => OWNER_INBOUND.test(event.id) || OWNER_REVISION.test(event.id))) return [];
    const awaiting = [...(this.journal.awaitingAck ?? [])];
    const index = new Map(awaiting.map((entry, i) => [entry.id, i]));
    const closed = this.core.closedSet();
    const reopened: string[] = [];
    const quarantined = new Set<string>();
    for (const event of events) {
      if (closed.has(event.id)) continue;
      if (event.line.startsWith("INBOUND ") && OWNER_INBOUND.test(event.id)) {
        if (!index.has(event.id)) {
          index.set(event.id, awaiting.length);
          awaiting.push(historical ? { id: event.id, quarantined: true } : { id: event.id });
          if (historical) quarantined.add(event.id);
        }
        continue;
      }
      const m = OWNER_REVISION.exec(event.id);
      const kind = event.line.startsWith("INBOUND_EDIT ") ? "edit" : event.line.startsWith("INBOUND_DELETE ") ? "delete" : undefined;
      if (!m || !kind) continue;
      const id = `discord:${m[1]}:${m[2]}`;
      const at = index.get(id);
      const entry = at === undefined ? undefined : awaiting[at];
      if (entry?.deleted || entry?.revisions?.includes(event.id)) continue;
      const revisions = [...(entry?.revisions ?? []), event.id];
      let next: AwaitingAck;
      if (kind === "delete") {
        if (!entry) continue;
        next = { ...unquarantined(entry), revisions, deleted: true, handledAt: entry.handledAt ?? this.deps.clock.now() };
        quarantined.delete(id);
      } else if (!entry || entry.handledAt !== undefined || entry.quarantined) {
        // A live edit of a message no longer open is a new instruction; one found only in the history is quarantined.
        next = { id, revision: event.id, revisions, ...(historical ? { quarantined: true as const } : {}) };
        if (historical) quarantined.add(id);
        else reopened.push(id);
      } else {
        next = { ...entry, revision: event.id, revisions };
      }
      if (at === undefined) { index.set(id, awaiting.length); awaiting.push(next); } else awaiting[at] = next;
    }
    const notifications = reopened.length && this.journal.notifications
      ? Object.fromEntries(Object.entries(this.journal.notifications).filter(([key]) => !reopened.some((id) => key === `ack:${id}` || key === `unhandled:${id}`)))
      : this.journal.notifications;
    this.journal = { ...this.journal, awaitingAck: awaiting, ...(notifications ? { notifications } : {}) };
    return [...quarantined];
  }

  consumeReceipts(): void {
    const receipts = pendingAcks(this.deps.config.stateDir);
    if (!receipts.length) return;
    const awaiting = (this.journal.awaitingAck ?? []).map((entry): AwaitingAck => {
      const matching = receipts.filter((receipt) => receipt.id === entry.id);
      if (!matching.length) return entry;
      const tasks = Math.max(entry.tasks ?? 1, ...matching.map((receipt) => receipt.tasks ?? 1));
      const lanes = [...new Set([...(entry.lanes ?? []), ...matching.flatMap((receipt) => receipt.lanes ?? [])])];
      const reply = !!(entry.reply || matching.some((receipt) => receipt.reply));
      const covered = lanes.length + Number(reply) >= tasks;
      // The lead took on a quarantined message: from here it is tracked like any other.
      return {
        ...unquarantined(entry), tasks, lanes, reply, ackedAt: Math.min(entry.ackedAt ?? Infinity, ...matching.map((receipt) => receipt.at)),
        handledAt: covered ? entry.handledAt ?? Math.max(...matching.map((receipt) => receipt.at)) : undefined,
      };
    });
    this.journal = { ...this.journal, awaitingAck: awaiting };
    // A crash before removing a receipt replays only set unions, max(tasks), and stable timestamps.
    this.persist();
    const tracked = new Set(awaiting.map((entry) => entry.id));
    for (const receipt of receipts) {
      if (tracked.has(receipt.id) || this.deps.clock.now() - receipt.at >= ACK_KEEP_MS) dropAck(receipt.path);
    }
  }

  /**
   * Reactions on the owner's inbound messages (ids discord:<channel>:<message>, INBOUND lines only).
   * Serialized on one chain so add/remove order holds, never awaited by a restart, failures swallowed.
   */
  react(events: readonly Event[], steps: readonly (readonly ["add" | "remove", string])[]): void {
    const react = this.hooks.react;
    if (!react) return;
    for (const event of events) {
      const m = OWNER_INBOUND.exec(event.id);
      if (!m?.[1] || !m[2] || !event.line.startsWith("INBOUND ")) continue;
      const [, channel, message] = m;
      for (const [op, emoji] of steps) {
        this.reactions = this.reactions.then(() => react(op, channel, message, emoji)).catch((e: unknown) => {
          console.error(`REACTION_FAILED ${op} ${event.id}: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }
  }

  /** Resolves when queued reactions and announcements have finished (tests and shutdown). */
  reactionsSettled(): Promise<void> { return this.reactions; }

  /**
   * One line for the owner's main channel, through a durable outbox: it is journaled first (with a stable id, so a
   * repeat is a no-op) and removed only once the post succeeded; failures retry every OUTBOX_RETRY_MS.
   */
  announce(id: string, text: string): void {
    if (!this.hooks.announce) return;
    if (this.journal.outbox?.some((item) => item.id === id)) return;
    this.journal = { ...this.journal, outbox: [...(this.journal.outbox ?? []), { id, text }] };
    this.persist();
    this.drainOutbox();
  }

  /** Posts due outbox lines in order on the reaction chain; never runs twice at once. */
  drainOutbox(): void {
    const announce = this.hooks.announce;
    if (!announce || this.draining || !this.journal.outbox?.length) return;
    this.draining = true;
    this.reactions = this.reactions.then(async () => {
      for (const item of this.journal.outbox ?? []) {
        const ask = item.id.startsWith("lead-emergency-approval:");
        const current = ask && item.id === `lead-emergency-approval:${this.journal.quotaExhausted?.since}`;
        if (ask && !current) {
          // An approval request outlives its episode only as a stale question: it is dropped, never posted late.
          this.journal = { ...this.journal, outbox: (this.journal.outbox ?? []).filter((entry) => entry.id !== item.id) };
          this.persist();
          continue;
        }
        if ((item.retryAt ?? 0) > this.deps.clock.now()) continue;
        let posted = false;
        try { await announce(item.text, item.id); posted = true; } catch (e) {
          console.error(`OWNER_ANNOUNCE_FAILED ${item.id} ${e instanceof Error ? e.message : String(e)}`);
        }
        const attempts = (item.attempts ?? 0) + 1;
        // The approval request of the open episode is never given up: without it the owner cannot know to approve.
        const drop = !posted && attempts >= OUTBOX_ATTEMPTS && !current;
        if (drop) console.error(`OWNER_ANNOUNCE_DROPPED ${item.id} after ${attempts} attempts`);
        const outbox = (this.journal.outbox ?? []).flatMap((entry) => entry.id !== item.id ? [entry]
          : posted || drop ? [] : [{ ...entry, attempts, retryAt: this.deps.clock.now() + OUTBOX_RETRY_MS }]);
        this.journal = { ...this.journal, outbox };
        this.persist();
      }
    }).finally(() => { this.draining = false; });
  }

  /** Tracking reaches disk before the delivery log. Busy leads get no read deadline until they become idle. */
  record(events: readonly Event[], readable = false): void {
    this.trackOwners(events);
    this.persist("normal");
    this.core.appendDelivered(events);
    if (readable) this.markReadable();
  }

  markReadable(): void {
    const ready = this.deps.clock.now();
    this.journal = {
      ...this.journal,
      awaitingAck: this.journal.awaitingAck?.map((entry) =>
        !entry.quarantined && entry.since === undefined && this.delivered.has(latest(entry)) ? { ...entry, since: ready } : entry),
    };
    this.persist("normal");
  }
}
