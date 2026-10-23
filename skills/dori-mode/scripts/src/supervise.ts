import { launchQueue, launchQueueText } from "./routing.ts";
import { scrubForThread } from "./freshness.ts";
import { homedir } from "node:os";

import type { FlowDeps } from "./done-flow.ts";
import { redactSecrets } from "./redact.ts";
import { type Event, JournalCore, type OwnerNoticeKind } from "./supervise-journal.ts";
import { OWNER_INBOUND, OWNER_REVISION, type OwnerMessage, OwnerTracking, quarantineDigest, type SupervisorHooks } from "./supervise-owner-tracking.ts";
import { LeadLifecycle } from "./supervise-lead-lifecycle.ts";
import { Delivery, OWNER_WARN_EVENTS } from "./supervise-delivery.ts";
import { eventClass } from "./event-policy.ts";

/*
 * The supervisor in four parts: the journal (supervise-journal.ts), owner tracking (supervise-owner-tracking.ts), the
 * lead lifecycle (supervise-lead-lifecycle.ts) and delivery (supervise-delivery.ts). This file composes them behind the
 * Supervisor API and re-exports their public names, so callers import from here as before.
 */
export {
  type AwaitingAck, type Journal, type JournalEvent, type Notice, type OutboxItem, type OwnerNoticeKind, type Restart, RETAIN_EVERY_MS,
  SuperviseError, TransientSuperviseError,
} from "./supervise-journal.ts";
export {
  ACK_KEEP_MS, COLD_START_EMOJI, HUNG_EMOJI, OUTBOX_ATTEMPTS, OUTBOX_RETRY_MS, OWNER_BODY_MAX, OWNER_NOTICE_AFTER_MS,
  OWNER_NOTIFY_ATTEMPTS, type SupervisorHooks,
} from "./supervise-owner-tracking.ts";
export {
  awaitStartupEvidence, confirmLead, hasStartupEvidence, LEAD_QUOTA_CHECK_MS, LEAD_SKILL, plainShell, screenStill,
  STARTUP_EVIDENCE_MS, stopHung, stopLead, UNCONFIRMED_LIMIT,
} from "./supervise-lead-lifecycle.ts";
export {
  BACKOFF_MAX_MS, BACKOFF_MIN_MS, eventPriority, OWNER_WARN_EVENTS, RetryingDelivery, STUCK_AFTER_MS,
} from "./supervise-delivery.ts";

/**
 * The log is the delivery boundary, not an assertion that the LLM completed the task.
 * Stable source IDs in the durable inbox and log make recovery idempotent. Keep both
 * files: removing either discards the deduplication history.
 */
export class Supervisor {
  readonly eventLog: string;
  private readonly core: JournalCore;
  private readonly owners: OwnerTracking;
  private readonly lead: LeadLifecycle;
  private readonly delivery: Delivery;

  constructor(deps: FlowDeps, hooks: SupervisorHooks = {}) {
    this.core = new JournalCore(deps);
    this.eventLog = this.core.eventLog;
    const enqueue = (id: string, line: string): void => { this.enqueue(id, line); };
    this.owners = new OwnerTracking(this.core, hooks, enqueue);
    this.lead = new LeadLifecycle(this.core, this.owners, hooks, enqueue);
    this.delivery = new Delivery(this.core, this.owners, this.lead);
    const { tail, cursor } = this.core.recoverLog();
    // Owner state comes from its tracking rows, not from the history: an owner message in the history with neither a
    // row nor a tombstone is quarantined and listed to the lead once, never reminded one by one.
    const quarantined = this.owners.trackOwners(this.core.journal.events, true);
    if (quarantined.length) this.enqueue(`owner-quarantine:${deps.clock.now()}`, quarantineDigest(quarantined));
    // Migration/reconciliation is durable before any timers or new delivery can run.
    this.core.persist();
    if (cursor !== this.core.store.logCursor()) this.core.store.recordDeliveries(tail, cursor, deps.clock.now());
    // Announcements a previous run could not post (or crashed before posting) go out now.
    this.owners.drainOutbox();
  }

  /** Releases the store (tests and shutdown); the supervisor must not be used afterwards. */
  close(): void { this.core.close(); }

  /** Synchronous durable enqueue: callers may enqueue while flush awaits a restart. False: a duplicate id, dropped. */
  enqueue(id: string, line: string): boolean {
    if (this.core.known(id)) return false;
    const queued = line === "LAUNCH_READY" || line.startsWith("LAUNCH_READY ") ? launchQueueText(launchQueue(this.core.deps.config.stateDir)) : "";
    const event = { id, line: redactSecrets(`${line}${queued}`).replace(/[\r\n]+/g, " "), at: this.core.deps.clock.now() };
    // Appended in place: copying the whole history per event is what made every enqueue O(history).
    (this.core.journal.events as Event[]).push(event);
    this.core.eventIds.add(id);
    this.owners.trackOwners([event]);
    // An owner message is synced at once (its Discord cursor moves on right after); the rest within one loop pass (ackTick).
    this.core.persist(OWNER_INBOUND.test(id) || OWNER_REVISION.test(id) ? "full" : "normal");
    if (OWNER_WARN_EVENTS.some((prefix) => line.startsWith(`${prefix} `))) this.owners.announce(`warn:${id}`, scrubForThread(`Dori warning: ${event.line}`, homedir()));
    // owner-only goes to the owner's main channel instead of the lead (delivery skips it); engine-only goes nowhere.
    if (eventClass(event.line, this.core.deps.config.eventPolicy) === "owner-only") this.owners.announce(`owner-only:${id}`, scrubForThread(event.line, homedir()));
    return true;
  }

  /** Event `id` is journaled, or was and left a dedupe tombstone: a scheduled run's read-back. */
  journaled(id: string): boolean { return this.core.known(id); }

  /**
   * Owner messages (INBOUND, id discord:<channel>:<message>) waiting longer than `ms` without reaching a running lead:
   * never appended to the lead's log, or appended only into a cold start that has not confirmed yet. Each is returned
   * until noticeSent confirms delivery, with a bounded number of attempts.
   */
  overdueOwnerMessages(ms: number): OwnerMessage[] { return this.owners.overdueOwnerMessages(ms); }

  /** Read receipts stop ACK_MISSING, but never erase unhandled owner work. */
  ackTick(timeoutMs: number): OwnerMessage[] { return this.owners.ackTick(timeoutMs); }

  /** An explicit ack starts the handling clock. A reminder gets a full second window before owner escalation. */
  handledTick(timeoutMs?: number): OwnerMessage[] { return this.owners.handledTick(timeoutMs); }

  /** Called only after the messenger confirms a successful post. Failures remain eligible on the next tick. */
  noticeSent(kind: OwnerNoticeKind, channel: string, message: string): void { this.owners.noticeSent(kind, channel, message); }

  /** Called right before an owner notice is posted: the attempt counts even if the process dies during the post. */
  noticeAttempt(kind: OwnerNoticeKind, channel: string, message: string): void { this.owners.noticeAttempt(kind, channel, message); }

  /** Resolves when queued reactions and announcements have finished (tests and shutdown). */
  reactionsSettled(): Promise<void> { return this.owners.reactionsSettled(); }

  /** The `leadModels` entry the lead runs on; a chain shortened in the config falls back to the first. */
  leadIndex(): number { return this.lead.leadIndex(); }

  flush(): Promise<void> { return this.delivery.flush(); }

  /**
   * The lead has received event `id`: it is in the delivery log and not in a cold start that has not confirmed yet (that
   * batch is logged before the new lead starts). A pruned or unknown id reads false.
   */
  leadDelivered(id: string): boolean {
    return this.core.delivered.has(id) && !this.core.journal.restart?.events.some((event) => event.id === id);
  }

  /**
   * Recreate a vanished lead pane like dori-boot-prep.sh: a tab in the "Dori" workspace at defaultCwd.
   * The runtime leadPane changes and persistLeadPane writes it back to the loaded config. Returns the new
   * pane id, or undefined when the pane exists or cannot be recreated cleanly (retries continue).
   */
  repairLeadPane(): Promise<string | undefined> { return this.lead.repairLeadPane(); }
}
