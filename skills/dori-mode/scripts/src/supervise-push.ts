import { randomUUID } from "node:crypto";

import { eventClass, eventKind } from "./event-policy.ts";
import { completeLines, parseLogLine } from "./inbox.ts";
import { listPanes, readScreen, sendVerified } from "./panes.ts";
import { type AwaitingAck, type Event, type InboxPush, type Journal, type JournalCore, TransientSuperviseError } from "./supervise-journal.ts";
import { type LeadLifecycle, PAUSED } from "./supervise-lead-lifecycle.ts";
import { latest } from "./supervise-owner-tracking.ts";

/**
 * Push delivery (delivery.mode push or shadow). Every delivery pass ends here: events appended to lead-events.log but
 * not yet taken by the lead (`dori inbox take` receipts, or an ack/handled receipt for an owner message) get one short
 * `[dori]` pointer typed into the lead pane. Untaken past push.ackSec it is pushed again, later with backoff; an idle lead
 * that keeps ignoring it is cold-restarted after push.escalateMin, within the restart cap. Shadow mode decides the same
 * and only logs. Event bodies are never typed: the lead reads them with `dori inbox take`.
 */

export const POINTER_PREFIX = "[dori] supervisor:";
export const POINTER_TAIL = "Not an owner message. Run dori inbox take, then continue your task.";
export const REPUSH_MAX_MS = 10 * 60_000;

type Untaken = { readonly id: string; readonly line: string };

const squash = (text: string): string => text.replace(/\s+/g, "");

/**
 * omo's input box: the `❯` line and its two-space continuation lines, up to the full-width `───` separator under it.
 * Without a separator below the prompt only the `❯` line counts. Undefined when the screen shows no prompt.
 */
export const inputRegion = (screen: string): string | undefined => {
  const lines = screen.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if ((lines[i] ?? "").trimStart().startsWith("\u276f")) { at = i; break; }
  if (at < 0) return undefined;
  const end = lines.findIndex((line, i) => i > at && /^\s*\u2500{3,}/.test(line));
  const region = [(lines[at] ?? "").trimStart().slice(1), ...(end < 0 ? [] : lines.slice(at + 1, end))];
  return region.join("\n").trim();
};

/**
 * What the input box holds: nothing, only our own pointer (or omo's paste placeholder for it), or anything else, which
 * may be the owner's text and is never typed into or submitted.
 */
export const inputState = (screen: string): "empty" | "ours" | "busy" => {
  const region = inputRegion(screen);
  if (region === undefined) return "busy";
  if (region === "") return "empty";
  const text = squash(region);
  if (text.startsWith(squash(POINTER_PREFIX)) && text.endsWith(squash(POINTER_TAIL))) return "ours";
  return /^\[paste#\d+[^\]]*\]$/.test(text) ? "ours" : "busy";
};

/** One ASCII line of at most `maxChars`: how many events wait, and their kinds (cut to `+N more` when too long). */
export const pointerText = (total: number, urgent: boolean, kinds: readonly string[], maxChars: number): string => {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    const clean = kind.replace(/[^\w*.:/ -]/g, "").trim() || "event";
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => (n > 1 ? `${kind} x${n}` : kind));
  const head = `${POINTER_PREFIX} ${total} new event${total === 1 ? "" : "s"}`;
  for (let shown = parts.length; shown >= 0; shown--) {
    const list = [...parts.slice(0, shown), ...(shown < parts.length ? [`+${parts.length - shown} more`] : [])].join(", ");
    const text = `${head} (${urgent ? "urgent" : "digest"}: ${list}). ${POINTER_TAIL}`;
    if (text.length <= maxChars) return text;
  }
  return `${head}. ${POINTER_TAIL}`.slice(0, maxChars);
};

export class PushDelivery {
  private scan?: { readonly from: number; scannedTo: number; readonly events: Untaken[] };
  private readonly logged = new Set<string>();

  constructor(private readonly core: JournalCore, private readonly lead: LeadLifecycle) {}

  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }

  private once(key: string, line: string): void {
    const id = `${this.journal.inbox?.takenOffset}:${key}`;
    if (this.logged.has(id)) return;
    this.logged.add(id);
    console.log(line);
  }

  /** Delivered lines past the take cursor; the log is read incrementally, from scratch only when the cursor moves. */
  private logPastCursor(from: number): readonly Untaken[] {
    if (this.scan?.from !== from) {
      this.scan = { from, scannedTo: from, events: [] };
      this.logged.clear();
    }
    const scan = this.scan;
    for (const line of completeLines(this.core.eventLog, scan.scannedTo)) {
      scan.events.push(parseLogLine(line.text));
      scan.scannedTo = line.end;
    }
    return scan.events;
  }

  /**
   * Ids the lead already has by a stronger receipt (F3a, N2, N3): owner tracking compacted or tombstoned, and an owner
   * message or edit enqueued at or before its ack or handled time. A delete is covered only while its message was never
   * acked: a delete of a message the lead is working on must reach it.
   */
  private covered(): (id: string, at: number | undefined) => boolean {
    const closed = this.core.closedSet();
    const owners = new Map<string, AwaitingAck>();
    for (const entry of this.journal.awaitingAck ?? []) for (const id of [entry.id, ...(entry.revisions ?? [])]) owners.set(id, entry);
    return (id, at) => {
      if (closed.has(id) || this.core.store.tombstoned(id)) return true;
      const entry = owners.get(id);
      if (!entry) return false;
      if (id.endsWith(":delete")) return entry.ackedAt === undefined;
      const by = Math.max(entry.ackedAt ?? -Infinity, entry.handledAt ?? -Infinity);
      return at === undefined ? by > -Infinity : at <= by;
    };
  }

  /** Re-push interval after `attempts` pushes: ackSec for the first retries + 1, then doubling up to REPUSH_MAX_MS (N7). */
  private interval(attempts: number): number {
    const { ackSec, retries } = this.core.deps.config.delivery.push;
    return Math.min(ackSec * 1000 * 2 ** Math.max(0, attempts - retries), Math.max(REPUSH_MAX_MS, ackSec * 1000));
  }

  private savePush(push: InboxPush | undefined): void {
    const inbox = this.journal.inbox;
    if (!inbox) return;
    this.journal = { ...this.journal, inbox: { ...inbox, push } };
    this.core.persist();
  }

  /**
   * The push step of one delivery pass. Returns true when it set a restart (the caller's loop carries it out). Makes no
   * herdr call while nothing untaken is due.
   */
  async tick(pending: readonly Event[]): Promise<boolean> {
    const { config, clock, run } = this.core.deps;
    const { delivery } = config;
    if (delivery.mode === "tail" || this.journal.restart) return false;
    // A take receipt written since the last pass moves the cursor before anything is decided.
    this.core.consumeTakes();
    const inbox = this.journal.inbox;
    if (!inbox || this.journal.quotaExhausted) return false;
    const shadow = delivery.mode === "shadow";
    const now = clock.now();
    const covered = this.covered();
    const past = this.logPastCursor(inbox.takenOffset);
    const want = new Set(past.map((event) => event.id));
    const at = new Map<string, number>();
    for (const event of this.journal.events) if (want.has(event.id) && event.at !== undefined) at.set(event.id, event.at);
    const push = inbox.push;
    const ageOf = (id: string): number => at.get(id) ?? push?.first ?? now;
    const untaken = past.filter((event) => !covered(event.id, at.get(event.id)));
    const policy = config.eventPolicy;
    const urgent = untaken.filter((event) => eventClass(event.line, policy) === "lead-urgent");
    const overdue = untaken.filter((event) => eventClass(event.line, policy) !== "lead-urgent" &&
      now - ageOf(event.id) >= config.digestMaxDelayMin * 60_000 && !/^\S*_WARN\b/.test(event.line));
    if (!urgent.length && !overdue.length) return false;
    const pane = (await listPanes(run)).find((p) => p.pane_id === config.leadPane);
    if (!pane) throw new TransientSuperviseError(`lead pane ${config.leadPane} does not exist`);
    if (!pane.agent) return false;
    const status = pane.agent_status;
    const idle = status === "idle" || status === "done";
    const batch = push?.batch ?? randomUUID().slice(0, 8);
    if (idle && push) {
      const reason = this.escalation(urgent, push.first, now, ageOf);
      if (reason) {
        const capped = shadow ? this.core.forcedRestartsSince(now) >= delivery.restartMaxPerHour : this.lead.capRefuses("push ladder");
        if (shadow) this.once(`shadow-escalate`, `LEAD_PUSH_SHADOW ${capped ? "would-cap" : "would-escalate"} ${batch} ${reason}`);
        else if (!capped) {
          console.log(`LEAD_PUSH_ESCALATE ${config.leadPane} ${reason}`);
          this.lead.setRestart({
            session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: this.core.logSize(),
            phase: "stopping", force: true, reason: `it did not take pushed events (${reason}), so the supervisor restarted it`,
          });
          return true;
        }
      }
    }
    // Blocked or unclassified: Enter could answer an approval dialog. A working lead gets the pointer only with toWorking.
    if (!idle && !(status === "working" && delivery.push.toWorking)) return false;
    if (push && now - push.at < this.interval(push.attempts)) return false;
    if (push && push.attempts > delivery.push.retries && !push.untakenLogged) {
      console.log(`LEAD_PUSH_UNTAKEN ${batch} ${untaken.length} event(s) after ${push.attempts} pushes`);
      this.savePush({ ...push, untakenLogged: true });
    }
    const first = push?.first ?? now;
    const attempts = push?.attempts ?? 0;
    const upto = this.core.logSize();
    const screen = await readScreen(run, config.leadPane);
    const input = inputState(screen);
    const kinds = (urgent.length ? urgent : overdue).map((event) => eventKind(event.line, policy));
    if (input === "busy") {
      // Not typed into (it may be the owner's text); the escalation clock still starts.
      this.once("busy", `LEAD_PUSH_INPUT_BUSY ${config.leadPane} ${batch}: its input line holds other text; not typing`);
      this.savePush({ at: now, upto, attempts, batch, first, ...(this.journal.inbox?.push?.untakenLogged ? { untakenLogged: true as const } : {}) });
      return false;
    }
    const pointer = pointerText(untaken.length, urgent.length > 0, kinds, delivery.push.maxChars);
    const next: InboxPush = { at: now, upto, attempts: attempts + 1, batch, first, ...(this.journal.inbox?.push?.untakenLogged ? { untakenLogged: true as const } : {}) };
    if (shadow) {
      console.log(`LEAD_PUSH_SHADOW would-push ${batch} ${untaken.length} ${kinds.join(",")} attempt=${next.attempts}`);
      this.savePush(next);
      return false;
    }
    if (input === "ours") {
      // Our own pointer still sits unsubmitted: one Enter submits it, nothing is typed again.
      this.savePush(next);
      await run(["herdr", "pane", "send-keys", config.leadPane, "enter"]);
      console.log(`LEAD_PUSH_ENTER_RETRY ${config.leadPane} ${batch}`);
      return false;
    }
    if (PAUSED.test(screen)) console.log(`LEAD_RESUMED ${config.leadPane} ${await sendVerified(run, clock, config.leadPane, "/resume")}`);
    // Persisted before the send: a crash mid-send re-pushes at most once, and a take is idempotent.
    this.savePush(next);
    const sent = await sendVerified(run, clock, config.leadPane, pointer);
    console.log(`LEAD_PUSH ${batch} ${untaken.length} ${kinds.join(",")} ${sent} attempt=${next.attempts}`);
    if (!push && this.lead.warmSession) this.core.wakes.record(this.lead.warmSession, untaken, urgent.length ? urgent : overdue);
    if (sent === "delivered") return false;
    await clock.sleep(delivery.push.pasteCheckMs);
    const after = inputState(await readScreen(run, config.leadPane));
    if (after === "ours") {
      await run(["herdr", "pane", "send-keys", config.leadPane, "enter"]);
      console.log(`LEAD_PUSH_ENTER_RETRY ${config.leadPane} ${batch}`);
    } else if (after === "busy") this.once("busy", `LEAD_PUSH_INPUT_BUSY ${config.leadPane} ${batch}: its input line holds other text after the push`);
    return false;
  }

  /**
   * Why an idle lead is escalated, or undefined. With the tail monitor on, only an owner message readable and unacked
   * for escalateMin counts (a lead reading the tail never needs to take). Without it, any untaken urgent event counts,
   * clocked from the latest of its enqueue time, the lead's start and the first push attempt (N1): a new lead is never
   * escalated before it got a pointer and escalateMin passed.
   */
  private escalation(urgent: readonly Untaken[], first: number, now: number, ageOf: (id: string) => number): string | undefined {
    const { delivery } = this.core.deps.config;
    const limit = delivery.push.escalateMin * 60_000;
    const minutes = (since: number): number => Math.round((now - since) / 60_000);
    if (delivery.tailMonitor) {
      const unacked = (this.journal.awaitingAck ?? []).filter((entry) => !entry.quarantined && entry.ackedAt === undefined &&
        entry.handledAt === undefined && entry.since !== undefined && this.core.delivered.has(latest(entry)));
      const since = Math.min(...unacked.map((entry) => entry.since ?? now));
      return unacked.length && now - since >= limit && now - first >= limit ? `${unacked.length} owner message(s) unacked for ${minutes(since)} min` : undefined;
    }
    const start = (id: string): number => Math.max(ageOf(id), this.journal.inbox?.sessionSince ?? 0, first);
    const stale = urgent.filter((event) => now - start(event.id) >= limit);
    if (!stale.length) return undefined;
    return `${stale.length} urgent event(s) untaken for ${minutes(Math.min(...stale.map((event) => start(event.id))))} min`;
  }
}
