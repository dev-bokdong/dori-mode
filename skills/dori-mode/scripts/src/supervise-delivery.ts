import { statSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type { FlowDeps } from "./done-flow.ts";
import { DEFAULT_EVENT_POLICY, eventClass, type EventPolicy, forLead } from "./event-policy.ts";
import { scrubForThread } from "./freshness.ts";
import type { OutcomeTracking } from "./lane-outcomes.ts";
import { listPanes } from "./panes.ts";
import { pendingLeadRestart } from "./lead-restart.ts";
import { type Event, type Journal, type JournalCore, TransientSuperviseError } from "./supervise-journal.ts";
import type { LeadLifecycle } from "./supervise-lead-lifecycle.ts";
import { latest, type OwnerTracking } from "./supervise-owner-tracking.ts";
import { PushDelivery } from "./supervise-push.ts";

/**
 * Delivery to the lead: which events wake it (urgent) and which wait as digest, the delivery pass that hands pending
 * events to the lead warm or through a cold restart, and the retrying wrapper that keeps transient lead states from
 * ending the supervisor.
 */

/** Events also posted to the owner's main channel when enqueued (fail-open warnings nobody else would see). */
export const OWNER_WARN_EVENTS = ["QUOTA_GATE_UNKNOWN"] as const;

/** Only `lead-urgent` events wake the lead; `lead-digest` waits for the next urgent one, or digestMaxDelayMin (event-policy.ts). */
export const eventPriority = (line: string, policy: EventPolicy = DEFAULT_EVENT_POLICY): "urgent" | "digest" =>
  eventClass(line, policy) === "lead-urgent" ? "urgent" : "digest";

export class Delivery {
  private flushing?: Promise<void>;
  private readonly push: PushDelivery;

  constructor(private readonly core: JournalCore, private readonly owners: OwnerTracking, private readonly lead: LeadLifecycle, outcomes: OutcomeTracking) {
    this.push = new PushDelivery(core, lead, outcomes);
  }

  private get deps(): FlowDeps { return this.core.deps; }
  private get journal(): Journal { return this.core.journal; }
  private get delivered(): Set<string> { return this.core.delivered; }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    this.owners.drainOutbox();
    for (;;) {
      if (this.journal.restart) {
        await this.lead.restart(this.journal.restart);
        continue;
      }
      const policy = this.deps.config.eventPolicy;
      // owner-only and engine-only events stay in the journal (dedupe, counts) but never reach the lead.
      const pending = this.journal.events.filter((event) => !this.delivered.has(event.id) && forLead(eventClass(event.line, policy)));
      const request = pendingLeadRestart(this.deps.config.stateDir);
      if (request) {
        const pane = (await listPanes(this.deps.run)).find((p) => p.pane_id === this.deps.config.leadPane);
        if (!pane) throw new TransientSuperviseError(`lead pane ${this.deps.config.leadPane} does not exist`);
        if (!pane.agent || pane.agent_status === "idle" || pane.agent_status === "done") {
          this.lead.setRestart({ session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size, phase: "stopping", request, modelIndex: 0 });
          continue;
        }
      }
      // Digest-only traffic must not touch the delivery log or even inspect the lead, until its oldest
      // event has waited digestMaxDelayMin. It survives a supervisor restart in the existing durable inbox.
      const now = this.deps.clock.now();
      // A sweep warning waits for real traffic: a failure that persists must not restart an idle lead every hour.
      const overdue = (event: Event) => event.at !== undefined && now - event.at >= this.deps.config.digestMaxDelayMin * 60_000 && !/^\S*_WARN\b/.test(event.line);
      const urgent = pending.filter((event) => eventPriority(event.line, policy) === "urgent");
      const due = urgent.length > 0 || pending.some(overdue);
      // Before anything reaches a lead stalled on quota, it moves to a model that can answer.
      if (await this.lead.quotaSwitch(pending, due)) continue;
      await this.lead.resumePaused();
      if (await this.lead.stuckRestart(pending)) continue;
      if (!due) {
        if (this.journal.awaitingAck?.some((entry) => !entry.quarantined && entry.since === undefined && this.delivered.has(latest(entry)))) {
          const pane = (await listPanes(this.deps.run)).find((p) => p.pane_id === this.deps.config.leadPane);
          if (!pane) throw new TransientSuperviseError(`lead pane ${this.deps.config.leadPane} does not exist`);
          if (!pane.agent) {
            this.lead.setRestart({ session: randomUUID(), events: [], offset: statSync(this.core.eventLog).size, phase: "stopping" });
            continue;
          }
          if (pane?.agent && (pane.agent_status === "idle" || pane.agent_status === "done")) this.owners.markReadable();
        }
        // Everything due is in the log now: push and shadow modes make sure the lead takes it.
        if (await this.push.tick(pending)) continue;
        return;
      }
      const pane = (await listPanes(this.deps.run)).find((p) => p.pane_id === this.deps.config.leadPane);
      if (!pane) throw new TransientSuperviseError(`lead pane ${this.deps.config.leadPane} does not exist`);
      // Blocked/unknown is not idle. Do not terminate an approval dialog or an unclassified agent.
      if (pane.agent_status === "working" || (pane.agent && pane.agent_status !== "idle" && pane.agent_status !== "done")) {
        this.owners.record(pending);
        continue;
      }
      if (pane.agent && await this.lead.warm(pane.cwd ?? this.deps.config.defaultCwd)) {
        this.owners.record(pending, true);
        this.core.wakes.record(this.lead.warmSession, pending, urgent.length ? urgent : pending.filter(overdue));
        continue;
      }
      this.lead.setRestart({ session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size, phase: "stopping" });
    }
  }
}

export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
export const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Wraps lead delivery so a transient lead state retries with bounded exponential backoff instead of
 * ending the supervisor. Events and the restart journal stay exactly as persisted. The same failure
 * streak reports once after STUCK_AFTER_MS; a fatal error is rethrown.
 */
export class RetryingDelivery {
  private failures = 0;
  private since = 0;
  private retryAt = 0;
  private stuck = false;

  constructor(private readonly io: {
    readonly now: () => number;
    readonly flush: () => Promise<void>;
    readonly repair: () => Promise<unknown>;
    readonly enqueue: (id: string, line: string) => void;
    readonly notify: (text: string) => Promise<void>;
    readonly log: (line: string) => void;
  }, private readonly boot: string) {}

  get nextAttemptAt(): number { return this.retryAt; }

  get due(): boolean { return this.io.now() >= this.retryAt; }

  async tick(): Promise<void> {
    try {
      await this.io.flush();
      this.failures = 0;
      this.stuck = false;
      this.retryAt = 0;
    } catch (e) {
      if (!(e instanceof TransientSuperviseError)) throw e;
      const now = this.io.now();
      if (this.failures === 0) this.since = now;
      this.failures++;
      const delay = Math.min(BACKOFF_MIN_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
      this.retryAt = now + delay;
      this.io.log(`SUPERVISOR_RETRY ${e.message}; attempt ${this.failures}, next in ${delay / 1000}s`);
      try { await this.io.repair(); } catch (r) { this.io.log(`SUPERVISOR_REPAIR_FAILED ${r instanceof Error ? r.message : String(r)}`); }
      if (!this.stuck && now - this.since >= STUCK_AFTER_MS) {
        this.stuck = true;
        const text = `SUPERVISOR_STUCK ${e.message}`;
        this.io.enqueue(`stuck:${this.boot}:${this.since}`, text);
        // The lead gets the raw reason; the channel post loses home paths and pane ids like every automatic post.
        try { await this.io.notify(scrubForThread(text, homedir())); } catch (n) { this.io.log(`SUPERVISOR_STUCK_NOTIFY_FAILED ${n instanceof Error ? n.message : String(n)}`); }
      }
    }
  }
}
