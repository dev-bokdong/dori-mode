import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { FlowDeps } from "./done-flow.ts";
import { leadChain, leadCommand, providerOf } from "./config.ts";
import { eventClass } from "./event-policy.ts";
import { paneResetAt, providerQuota, QUOTA_SCREEN_LINES, quotaScreenHit, quotaStall } from "./quota-stall.ts";
import { kst } from "./claude-quota.ts";
import { listPanes, readScreen, sendVerified } from "./panes.ts";
import { quoteForPane } from "./launch.ts";
import { handoffLines } from "./lane-outcomes.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { statusOf } from "./registry.ts";
import { Waits } from "./waits.ts";
import { completeLeadRestart } from "./lead-restart.ts";
import { redactSecrets } from "./redact.ts";
import { launchQueue, launchQueueText } from "./routing.ts";
import { approvedEpisode, clearEmergencyApproval } from "./emergency.ts";
import type { Durability } from "./store.ts";
import { type AwaitingAck, type Event, type Journal, type JournalCore, type OutboxItem, type Restart, SuperviseError, TransientSuperviseError } from "./supervise-journal.ts";
import { COLD_START_EMOJI, HUNG_EMOJI, latest, OWNER_INBOUND, OWNER_REVISION, type OwnerTracking, type SupervisorHooks } from "./supervise-owner-tracking.ts";

/**
 * The lead lifecycle: which model the lead runs on (quota switches, the exhaustion episode, the paid emergency model),
 * a stuck lead, warm delivery or a cold restart, and the launch, confirmation and stop of the lead process.
 */

/** How often an idle lead's screen is checked for a quota stall while a fallback model exists. */
export const LEAD_QUOTA_CHECK_MS = 30_000;

export const LEAD_SKILL = fileURLToPath(new URL("../../SKILL.md", import.meta.url));

/**
 * A working lead's screen without its animation, which changes on a frozen turn and is not progress: digits (timers,
 * counters), braille, circle, star and dot spinner glyphs, and a lone ASCII spinner frame (| / - \ as its own token).
 */
export const screenStill = (screen: string): string =>
  screen.replace(/[\d\u2800-\u28ff\u25d0-\u25d3\u25f4-\u25f7\u2722-\u273f\u00b7\u2022\u2219\u25cf\u25cb\u25c9\u23fa]/g, "")
    .replace(/(^|\s)[|/\\-](?=\s|$)/gm, "$1");

/** How much of the lead's session file is read from its end to find an open tool call. */
const SESSION_TAIL_BYTES = 256 * 1024;

/**
 * When the lead's current tool call started: the newest assistant message in its session ends in a tool call that has
 * no result yet. Undefined when the session is between tool calls (streaming, idle) or unreadable.
 */
export const openToolCallSince = (file: string): number | undefined => {
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const size = statSync(file).size;
      const length = Math.min(size, SESSION_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    console.error(`LEAD_SESSION_UNREADABLE ${file}: ${e.message}`);
    return undefined;
  }
  const answered = new Set<string>();
  for (const line of text.trimEnd().split("\n").reverse()) {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (message.role === "toolResult") {
      if (typeof message.toolCallId === "string") answered.add(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const open = message.content.some((part: { type?: unknown; id?: unknown }) => part.type === "toolCall" && typeof part.id === "string" && !answered.has(part.id));
    const at = "timestamp" in entry && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return open && Number.isFinite(at) ? at : undefined;
  }
  return undefined;
};

/** omo's footer on a session paused by Esc ("Paused · N updates held · type to continue, /resume to resume"). */
export const PAUSED = /\bPaused\b.*\/resume\b/;

/** The omo input line holds nothing the owner typed: typing /resume cannot submit or mangle their text. */
const emptyInput = (screen: string): boolean => {
  const input = screen.split("\n").reverse().find((line) => line.trimStart().startsWith("\u276f"));
  return input !== undefined && input.trimStart().slice(1).trim() === "";
};

export class LeadLifecycle {
  private nextQuotaCheck = 0;
  private resumedAt = 0;

  constructor(
    private readonly core: JournalCore, private readonly owners: OwnerTracking, private readonly hooks: SupervisorHooks,
    private readonly enqueue: (id: string, line: string) => void,
  ) {}

  private get deps(): FlowDeps { return this.core.deps; }
  private set deps(deps: FlowDeps) { this.core.deps = deps; }
  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }
  private get delivered(): Set<string> { return this.core.delivered; }
  private persist(durability?: Durability): void { this.core.persist(durability); }

  /** The `leadModels` entry the lead runs on; a chain shortened in the config falls back to the first. */
  leadIndex(): number {
    const index = this.journal.leadModel ?? 0;
    return index < leadChain(this.leadConfig()).length ? index : 0;
  }

  private leadConfig(): FlowDeps["config"] {
    return this.journal.models ? { ...this.deps.config, leadModel: this.journal.models, leadThinking: undefined } : this.deps.config;
  }

  /**
   * A quota stall on the lead pane for chain entry `index`: a screen hit and every account of its provider blocked.
   * An emergency entry is an API-key provider without accounts to check, so its screen hit alone is the stall.
   */
  private async leadQuotaStall(index: number): Promise<string | undefined> {
    const entry = leadChain(this.leadConfig())[index];
    if (!entry) return undefined;
    const screen = await readScreen(this.deps.run, this.deps.config.leadPane, QUOTA_SCREEN_LINES);
    if (entry.emergency) {
      const hit = quotaScreenHit(screen);
      return hit ? `emergency model failed: ${hit}` : undefined;
    }
    return quotaStall(this.deps.run, this.deps.config, screen, entry.model);
  }

  /**
   * The owner approved the paid emergency models for this episode: the stored approval names the open exhaustion
   * episode, or the one that put the running lead on an emergency model. An approval from any earlier episode is void.
   */
  private emergencyApproved(): boolean {
    const episode = approvedEpisode(this.deps.config.stateDir);
    return episode !== undefined && (episode === this.journal.quotaExhausted?.since || episode === this.journal.emergencyEpisode);
  }

  /**
   * The chain entry the lead may move to by itself from `index`: the next one, unless it is a paid emergency model the
   * owner has not approved for this episode (emergency.ts). Undefined when there is none.
   */
  private autoNext(chain: readonly { readonly emergency?: true }[], index: number): number | undefined {
    const next = chain[index + 1];
    if (!next) return undefined;
    return next.emergency && !this.emergencyApproved() ? undefined : index + 1;
  }

  /**
   * Every model the lead may use by itself is blocked: the lead on the last of them is stalled. Once per episode the owner
   * is told with the earliest known reset (omo auth check of each subscription entry, or the pane), and
   * LEAD_QUOTA_EXHAUSTED is queued; when an unapproved emergency model is next, LEAD_EMERGENCY_APPROVAL asks for it.
   * The episode, its events and its announcements reach disk in one write, so a crash cannot bury them. The lead is told
   * to wait for the owner: it may never approve the paid model itself.
   */
  private async noteExhausted(chain: readonly { readonly model: string; readonly emergency?: true }[], index: number, stall: string): Promise<void> {
    if (this.journal.quotaExhausted) return;
    const { run, config, clock } = this.deps;
    const now = clock.now();
    const usable = chain.slice(0, index + 1);
    const resets: number[] = [];
    for (const provider of new Set(usable.filter((m) => !m.emergency).flatMap((m) => providerOf(m.model) ?? []))) {
      const quota = await providerQuota(run, config.quotaCheck, provider);
      if (quota.blocked && quota.resetAt !== undefined) resets.push(quota.resetAt);
    }
    const screenReset = paneResetAt(await readScreen(run, config.leadPane, QUOTA_SCREEN_LINES), now);
    if (screenReset !== undefined) resets.push(screenReset);
    const resetAt = resets.length ? Math.min(...resets) : undefined;
    const model = chain[index]?.model ?? "";
    const models = usable.map((m) => m.model).join(", ");
    const emergency = chain[index + 1]?.emergency ? chain[index + 1]?.model : undefined;
    console.log(`LEAD_QUOTA_EXHAUSTED ${model} ${stall}`);
    const events: Event[] = [];
    const outbox: OutboxItem[] = [];
    const tell = (id: string, line: string) => {
      if (!this.core.known(id) && !events.some((event) => event.id === id)) events.push({ id, line: redactSecrets(line).replace(/[\r\n]+/g, " "), at: now });
    };
    const say = (id: string, text: string) => {
      if (this.hooks.announce && !this.journal.outbox?.some((item) => item.id === id)) outbox.push({ id, text });
    };
    say(`lead-quota-exhausted:${now}`, `Every lead model is out of quota (${models}), so the lead cannot answer until one resets${resetAt !== undefined ? ` (earliest known reset ${kst(resetAt)} KST)` : " (reset time unknown)"}. Your messages stay queued.`);
    if (emergency) {
      say(`lead-emergency-approval:${now}`, `The lead can run on the paid emergency model ${emergency} until ${chain[0]?.model} has quota again. It moves only with your approval for this outage: use /emergency here, or run dori lead-emergency approve on the host.`);
      tell(`lead-emergency-approval:${now}`, `LEAD_EMERGENCY_APPROVAL ${emergency} the paid emergency model waits for the owner's own /emergency approval for this outage; never approve it yourself`);
    }
    tell(`lead-quota-exhausted:${now}`,
      `LEAD_QUOTA_EXHAUSTED ${model} reset=${resetAt !== undefined ? new Date(resetAt).toISOString() : "unknown"} every lead model is blocked on quota (${models}): ${stall}`);
    this.journal = {
      ...this.journal,
      quotaExhausted: { since: now, model, ...(resetAt !== undefined ? { resetAt } : {}) },
      events: [...this.journal.events, ...events],
      ...(outbox.length ? { outbox: [...(this.journal.outbox ?? []), ...outbox] } : {}),
    };
    for (const event of events) this.core.eventIds.add(event.id);
    this.persist();
    this.owners.drainOutbox();
  }

  /**
   * The exhaustion episode ended (the lead's model answers again, or it moved to one that does): told once. Unless the
   * lead now runs on the emergency model that approval bought, the approval ends with the episode.
   */
  private noteCleared(entry: { readonly model: string; readonly emergency?: true } | undefined): void {
    const episode = this.journal.quotaExhausted;
    if (!episode) return;
    const now = this.deps.clock.now();
    const model = entry?.model ?? "";
    if (!entry?.emergency) clearEmergencyApproval(this.deps.config.stateDir);
    console.log(`LEAD_QUOTA_CLEARED ${model}`);
    this.journal = { ...this.journal, quotaExhausted: undefined };
    this.owners.announce(`lead-quota-cleared:${episode.since}`, `The lead has quota again (${model}); queued messages are being answered.`);
    this.enqueue(`lead-quota-cleared:${episode.since}`, `LEAD_QUOTA_CLEARED ${model} the lead has a model with quota again after ${Math.round((now - episode.since) / 60_000)} min`);
  }

  /** Durable episode clocks (M5): a supervisor restart must not start them over. Saved only on change. */
  private patchJournal(patch: Partial<Pick<Journal, "quotaStallSince" | "leadBusySince" | "leadScreen">>): void {
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((key) => JSON.stringify(this.journal[key]) !== JSON.stringify(patch[key]));
    if (!changed) return;
    this.journal = { ...this.journal, ...patch };
    this.persist("normal");
  }

  /**
   * On a fallback, the first model's provider is checked once per leadPrimaryRetryMin whatever the lead is doing; true
   * once leadPrimaryReturnChecks checks in a row found it unblocked. The streak stays until the lead is back on it.
   */
  private async primaryReady(chain: readonly { readonly model: string }[], now: number): Promise<boolean> {
    const { config, run } = this.deps;
    const need = Math.max(1, config.leadPrimaryReturnChecks);
    if (now >= (this.journal.primaryRetryAt ?? 0)) {
      const provider = providerOf(chain[0]?.model ?? "");
      const quota = provider ? await providerQuota(run, config.quotaCheck, provider) : undefined;
      // An unreadable check is not "unblocked"; one blocked check restarts the count.
      const streak = quota && !quota.blocked && !quota.unknown ? (this.journal.primaryClearChecks ?? 0) + 1 : 0;
      this.journal = { ...this.journal, primaryRetryAt: now + config.leadPrimaryRetryMin * 60_000, primaryClearChecks: streak || undefined };
      this.persist();
      if (streak && streak < need) console.log(`LEAD_PRIMARY_CLEAR_CHECK ${chain[0]?.model} ${streak}/${config.leadPrimaryReturnChecks}`);
    }
    return (this.journal.primaryClearChecks ?? 0) >= need;
  }

  /**
   * Quota control, checked every LEAD_QUOTA_CHECK_MS or at once before an urgent delivery. An idle lead stalled on quota
   * moves to the next model it may use by itself; a working one only once the stall has lasted leadQuotaBusySwitchMin,
   * and never onto a paid emergency model. A lead on a fallback moves back to the first model once its provider is
   * unblocked on leadPrimaryReturnChecks consecutive checks: when idle, or at once when it is stalled itself (working
   * included). Either is a cold restart carrying `pending`. A stall with nothing left opens an exhaustion episode
   * (noteExhausted), closed by noteCleared.
   */
  async quotaSwitch(pending: readonly Event[], urgent: boolean): Promise<boolean> {
    const { config, run, clock } = this.deps;
    const chain = leadChain(this.leadConfig());
    const now = clock.now();
    if (!urgent && now < this.nextQuotaCheck) return false;
    // Without a fallback there is nothing to switch: digest-only traffic leaves the lead alone unless an exhaustion
    // episode is open (its end is watched).
    if (chain.length < 2 && !urgent && !this.journal.quotaExhausted) return false;
    this.nextQuotaCheck = now + LEAD_QUOTA_CHECK_MS;
    const pane = (await listPanes(run)).find((p) => p.pane_id === config.leadPane);
    if (!pane?.agent) return false;
    const idle = pane.agent_status === "idle" || pane.agent_status === "done";
    const working = pane.agent_status === "working";
    const index = this.leadIndex();
    const next = this.autoNext(chain, index);
    const stall = await this.leadQuotaStall(index);
    if (stall && next === undefined) await this.noteExhausted(chain, index, stall);
    // Still blocked (an approval only made a move possible): the episode stays open until a model answers.
    else if (!stall) this.noteCleared(chain[index]);
    const primary = index > 0 && await this.primaryReady(chain, now);
    // On a paid emergency model whose approval was revoked (or belongs to no episode): back to the first model.
    const revoked = !!chain[index]?.emergency && !this.emergencyApproved();
    let target: number | undefined;
    let reason: string | undefined;
    let force = false;
    if (stall && primary && (idle || working)) {
      target = 0;
      force = !idle;
      reason = `${chain[index]?.model} is blocked on quota (${stall}) and ${chain[0]?.model} has quota again`;
    } else if (revoked && idle) {
      target = 0;
      reason = `the owner's approval for the paid emergency model ${chain[index]?.model} was revoked`;
    } else if (stall && next !== undefined && idle) {
      target = next;
      reason = `${chain[index]?.model} is blocked on quota (${stall})`;
    } else if (stall && next !== undefined && working && !chain[next]?.emergency) {
      // A working lead stalled with a model left: the provider may be retrying. Switch once the stall outlives the limit.
      const since = this.journal.quotaStallSince ?? now;
      this.patchJournal({ quotaStallSince: since });
      if (now - since < config.leadQuotaBusySwitchMin * 60_000) return false;
      target = next;
      force = true;
      reason = `${chain[index]?.model} is blocked on quota (${stall}) while working for ${Math.round((now - since) / 60_000)} min`;
    } else if (!stall && primary && idle) {
      target = 0;
    }
    this.patchJournal({ quotaStallSince: undefined });
    if (target === undefined) return false;
    console.log(`LEAD_MODEL_SWITCH ${chain[index]?.model} -> ${chain[target]?.model}${reason ? ` ${reason}` : ""}`);
    this.setRestart({
      session: randomUUID(), events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size,
      phase: "stopping", modelIndex: target, ...(reason ? { reason } : {}), ...(force ? { force: true as const } : {}),
    });
    return true;
  }

  /** Owner messages handed to the lead with no ack and not handled; `readable` narrows to those whose read window opened. */
  private unacked(readable?: boolean): AwaitingAck[] {
    return (this.journal.awaitingAck ?? []).filter((entry) => !entry.quarantined && entry.ackedAt === undefined && entry.handledAt === undefined &&
      this.delivered.has(latest(entry)) && (readable === undefined || (entry.since !== undefined) === readable));
  }

  /** The lead's session id and file; either is empty/undefined when it cannot be resolved. */
  private async sessionFile(cwd: string): Promise<{ readonly id: string; readonly file?: string }> {
    const hit = await resolveSession(this.deps.config.leadPane, cwd, await procTable(this.deps.run), { run: this.deps.run, sessionsDir: this.deps.config.sessionsDir });
    if (!hit.id) return { id: "" };
    if (existsSync(hit.id)) return { id: hit.id, file: hit.id };
    const dir = sessionDirFor(this.deps.config.sessionsDir, cwd);
    return { id: hit.id, file: (await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: dir, absolute: true, onlyFiles: true })))
      .find((path) => path.endsWith(`_${hit.id}.jsonl`) || path.endsWith(`/${hit.id}.jsonl`)) };
  }

  /**
   * Push mode: true when the restart cap refuses an unread-driven restart (stuckRestart, the push ladder). Forced
   * restarts and quota switches of the last hour count (they still run past the cap). The first refusal of each hour is
   * logged and told to the owner once; the push step keeps re-pushing meanwhile. Tail and shadow modes never refuse.
   */
  capRefuses(what: string): boolean {
    const { delivery } = this.deps.config;
    if (delivery.mode !== "push") return false;
    const now = this.deps.clock.now();
    const count = this.core.forcedRestartsSince(now);
    if (count < delivery.restartMaxPerHour) return false;
    const hour = Math.floor(now / 3_600_000);
    const inbox = this.journal.inbox;
    if (inbox && inbox.capNotice !== hour) {
      console.log(`LEAD_RESTART_CAPPED ${what}: ${count} forced restarts in the last hour (delivery.restartMaxPerHour ${delivery.restartMaxPerHour}); re-pushing instead`);
      this.journal = { ...this.journal, inbox: { ...inbox, capNotice: hour } };
      this.persist();
      this.owners.announce(`lead-restart-capped:${hour}`, `The lead is not taking new events, but it was already restarted ${count} times in the last hour, so it is not restarted again for now. The supervisor keeps notifying it.`);
    }
    return true;
  }

  /**
   * An idle lead paused by Esc (omo holds every monitor event, so the delivery log never wakes it) with an owner message
   * unacked past the ack window is resumed: `/resume` is typed once per ack window, only into an empty input line.
   * One that stays silent is restarted by stuckRestart after leadUnreadRestartMin.
   */
  async resumePaused(): Promise<void> {
    const { config, clock, run } = this.deps;
    const now = clock.now();
    const window = config.ackTimeoutSec * 1000;
    if (now - this.resumedAt < window) return;
    if (!this.unacked(true).some((entry) => now - (entry.since ?? now) >= window)) return;
    const pane = (await listPanes(run)).find((p) => p.pane_id === config.leadPane);
    if (!pane?.agent || (pane.agent_status !== "idle" && pane.agent_status !== "done")) return;
    const screen = await readScreen(run, config.leadPane, QUOTA_SCREEN_LINES);
    if (!PAUSED.test(screen)) return;
    this.resumedAt = now;
    if (!emptyInput(screen)) {
      console.log(`LEAD_PAUSED_INPUT ${config.leadPane}: paused with text in its input; not typing, restart follows after ${config.leadUnreadRestartMin} min`);
      return;
    }
    console.log(`LEAD_RESUMED ${config.leadPane} ${await sendVerified(run, clock, config.leadPane, "/resume")}`);
  }

  /**
   * A lead that stays blocked (an approval prompt) while owner messages handed to it stay unread (no read window, no
   * ack) for leadStuckRestartMin is cold-restarted with them, and the owner is told. A working lead may be in a long
   * build or review, so it counts only while its screen has also not changed for that long (a hung turn). Measured from
   * the latest of the oldest unread message, the first time the lead was seen busy with it, and the last screen change;
   * those clocks are journaled, so a supervisor restart does not reset them.
   * Two faster rules use leadUnreadRestartMin: a working lead held inside one tool call (a foreground wait or watch cannot
   * take a monitor event until it returns), counted from the later of the call's start and the oldest unacked message;
   * and an idle lead that leaves a readable owner message unacked (an Esc-paused session holds every event). Neither
   * applies while every lead model is out of quota.
   */
  async stuckRestart(pending: readonly Event[]): Promise<boolean> {
    const { config, clock, run } = this.deps;
    const limit = config.leadStuckRestartMin * 60_000;
    if (!(limit > 0)) return false;
    // Push mode: the push ladder owns idle leads, and one tool call is clocked by push.escalateMin (supervise-push.ts).
    const push = config.delivery.mode === "push";
    const unreadLimit = (push ? config.delivery.push.escalateMin : config.leadUnreadRestartMin) * 60_000;
    const waiting = this.unacked();
    if (!waiting.length) { this.patchJournal({ leadBusySince: undefined, leadScreen: undefined }); return false; }
    const now = clock.now();
    const pane = (await listPanes(run)).find((p) => p.pane_id === config.leadPane);
    if (!pane?.agent) { this.patchJournal({ leadBusySince: undefined, leadScreen: undefined }); return false; }
    const restart = (status: string, minutes: number, count: number): boolean => {
      // The cap is checked before anything is announced: a refused restart must not tell the owner it is happening.
      if (this.capRefuses(`stuck ${status}`)) return false;
      this.patchJournal({ leadBusySince: undefined, leadScreen: undefined });
      const session = randomUUID();
      console.log(`LEAD_STUCK_RESTART ${config.leadPane} ${status} ${minutes} min, ${count} owner message(s) unread`);
      this.owners.announce(`lead-stuck:${session}`, `The lead has been stuck (${status}) for ${minutes} min without reading your messages, so it is being restarted; your unanswered messages go to the new lead.`);
      this.setRestart({
        session, events: pending.map(({ id, line }) => ({ id, line })), offset: statSync(this.core.eventLog).size,
        phase: "stopping", force: true,
        reason: `it was stuck ${status} for ${minutes} min with ${count} owner message(s) unread, so the supervisor restarted it`,
      });
      return true;
    };
    const at = (ids: ReadonlySet<string>): number[] => this.journal.events.filter((event) => ids.has(event.id) && event.at !== undefined).map((event) => event.at ?? 0);
    // Every lead model out of quota: no new lead could answer either; quota control owns the lead until one resets.
    const exhausted = this.journal.quotaExhausted !== undefined;
    if (pane.agent_status === "idle" || pane.agent_status === "done") {
      this.patchJournal({ leadBusySince: undefined, leadScreen: undefined });
      if (exhausted || push) return false;
      // An idle lead reads its monitor at once. One that leaves a readable owner message unacked this long is not
      // reading it (an Esc-paused session holds the events, or its monitor is gone): a new lead gets them in its prompt.
      const readable = this.unacked(true);
      const since = Math.min(...readable.map((entry) => entry.since ?? now));
      return readable.length > 0 && now - since >= unreadLimit && restart("idle", Math.round((now - since) / 60_000), readable.length);
    }
    if (pane.agent_status === "working" && !exhausted) {
      // A lead inside one tool call cannot take a monitor event until the call returns: a foreground wait, watch or
      // sleep. Owner messages must not wait for it, however busy its screen looks.
      // A probe that cannot resolve the session must not stop delivery: the other rules still apply.
      let file: string | undefined;
      try { ({ file } = await this.sessionFile(pane.cwd ?? config.defaultCwd)); } catch (e) {
        if (!(e instanceof Error)) throw e;
        console.error(`LEAD_SESSION_UNRESOLVED ${config.leadPane}: ${e.message}`);
      }
      const call = file ? openToolCallSince(file) : undefined;
      const times = at(new Set(waiting.map(latest)));
      if (call !== undefined && times.length) {
        const since = Math.max(Math.min(...times), call);
        if (now - since >= unreadLimit) return restart("in one tool call", Math.round((now - since) / 60_000), waiting.length);
      }
    }
    const unread = new Set(this.unacked(false).map(latest));
    const times = at(unread);
    if (!times.length) { this.patchJournal({ leadBusySince: undefined, leadScreen: undefined }); return false; }
    const busySince = this.journal.leadBusySince ?? now;
    this.patchJournal({ leadBusySince: busySince });
    let since = Math.max(Math.min(...times), busySince);
    if (pane.agent_status === "working") {
      const hash = Bun.hash(screenStill(await readScreen(run, config.leadPane, QUOTA_SCREEN_LINES))).toString(16);
      if (this.journal.leadScreen?.hash !== hash) this.patchJournal({ leadScreen: { hash, since: now } });
      since = Math.max(since, this.journal.leadScreen?.since ?? now);
    } else if (this.journal.leadScreen) this.patchJournal({ leadScreen: undefined });
    if (now - since < limit) return false;
    return restart(pane.agent_status ?? "unknown", Math.round((now - since) / 60_000), unread.size);
  }

  setRestart(restart: Restart | undefined): void {
    if (restart?.phase === "stopping") {
      this.owners.consumeReceipts();
      // Unfinished owner messages travel in their latest revision; deleted ones never reach the new lead.
      const awaiting = this.journal.awaitingAck ?? [];
      const deleted = new Set(awaiting.filter((entry) => entry.deleted).map((entry) => entry.id));
      const unfinished = new Set(awaiting.filter((entry) => entry.handledAt === undefined && !entry.quarantined).map(latest));
      const events = new Map(restart.events.filter((event) => !deleted.has(event.id)).map((event) => [event.id, event]));
      for (const event of this.journal.events) if (unfinished.has(event.id)) events.set(event.id, event);
      restart = { ...restart, events: [...events.values()] };
    }
    this.journal = { ...this.journal, restart };
    this.persist();
  }

  /**
   * Recreate a vanished lead pane like dori-boot-prep.sh: a tab in the "Dori" workspace at defaultCwd.
   * The runtime leadPane changes and persistLeadPane writes it back to the loaded config. Returns the new
   * pane id, or undefined when the pane exists or cannot be recreated cleanly (retries continue).
   */
  async repairLeadPane(): Promise<string | undefined> {
    const { run, config } = this.deps;
    if ((await listPanes(run)).some((p) => p.pane_id === config.leadPane)) return undefined;
    const pane = await this.createLeadPane();
    if (!pane) return undefined;
    // A launch submitted into the vanished pane can never confirm there; the same events get a fresh session in the new one.
    const pending = this.journal.restart;
    if (pending?.phase === "submitted") this.abandon(pending);
    console.log(`LEAD_PANE_RECREATED ${config.leadPane} -> ${pane}`);
    return pane;
  }

  /** Move a restart to a fresh session id (phase starting) with the same events and offset; drops the old prompt file. */
  private abandon(restart: Restart): Restart {
    const old = join(this.deps.config.stateDir, `lead-${restart.session}.md`);
    if (existsSync(old)) unlinkSync(old);
    const next: Restart = { ...restart, session: randomUUID(), phase: "starting", unconfirmed: 0 };
    this.setRestart(next);
    return next;
  }

  /**
   * A new "dori-lead" tab in the Dori workspace at defaultCwd, persisted as the lead pane. herdr removes a workspace
   * together with its last pane, so closing the lead by hand can take the Dori workspace with it: then the workspace is
   * created again, as dori-boot-prep.sh does, and its root pane becomes the lead. Undefined, with herdr's reason logged,
   * when herdr refuses.
   */
  private async createLeadPane(): Promise<string | undefined> {
    const { run, config } = this.deps;
    const refused = (what: string, result: { readonly out: string; readonly err: string }): undefined => {
      console.error(`LEAD_PANE_CREATE_FAILED ${what}: ${result.err || result.out}`);
      return undefined;
    };
    const listed = await run(["herdr", "workspace", "list"]);
    if (listed.code !== 0) return refused("herdr workspace list", listed);
    const workspace = (JSON.parse(listed.out) as { result: { workspaces: { label?: string; workspace_id: string }[] } }).result.workspaces.find((w) => w.label === "Dori");
    let pane: string | undefined;
    if (workspace) {
      const made = await run(["herdr", "tab", "create", "--workspace", workspace.workspace_id, "--cwd", config.defaultCwd, "--label", "dori-lead"]);
      if (made.code !== 0) return refused(`herdr tab create in ${workspace.workspace_id}`, made);
      pane = (JSON.parse(made.out) as { result: { root_pane: { pane_id?: string } } }).result.root_pane.pane_id;
    } else {
      const made = await run(["herdr", "workspace", "create", "--label", "Dori", "--cwd", config.defaultCwd, "--no-focus"]);
      if (made.code !== 0) return refused("herdr workspace create Dori", made);
      const root = (JSON.parse(made.out) as { result: { root_pane: { pane_id?: string; tab_id?: string; workspace_id?: string } } }).result.root_pane;
      pane = root.pane_id;
      console.log(`LEAD_WORKSPACE_RECREATED ${root.workspace_id ?? "?"}`);
      if (root.tab_id) {
        const renamed = await run(["herdr", "tab", "rename", root.tab_id, "dori-lead"]);
        if (renamed.code !== 0) console.error(`LEAD_TAB_RENAME_FAILED ${root.tab_id}: ${renamed.err || renamed.out}`);
      }
    }
    if (!pane) return refused("herdr returned no pane id", { out: "", err: "" });
    this.deps = { ...this.deps, config: { ...config, leadPane: pane } };
    try { this.hooks.persistLeadPane?.(pane); } catch (e) {
      console.error(`LEAD_PANE_PERSIST_FAILED ${pane}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return pane;
  }

  /** The lead pane's last 80 lines, saved to the state dir: the only evidence of why a start failed once the pane is gone. */
  private async saveLeadScreen(): Promise<void> {
    const { run, config, clock } = this.deps;
    const pane = config.leadPane;
    const screen = await run(["herdr", "pane", "read", pane, "--source", "recent", "--lines", "80"]);
    if (screen.code !== 0) {
      console.error(`LEAD_PANE_SCREEN_UNREADABLE ${pane}: ${screen.err || screen.out}`);
      return;
    }
    const path = join(config.stateDir, `lead-pane-${pane.replace(/[^\w.-]/g, "_")}-${clock.now()}.txt`);
    const fd = openSync(path, "w", 0o600);
    try { writeFileSync(fd, redactSecrets(screen.out)); fsyncSync(fd); } finally { closeSync(fd); }
    console.log(`LEAD_PANE_SCREEN_SAVED ${pane} ${path}`);
  }

  /**
   * Replace an existing lead pane whose launch never confirmed (its screen is saved first by the caller). Only a pane
   * left with a plain shell is closed, after the new tab exists; any other foreground process is not the supervisor's
   * and the pane is kept. Returns the new pane id.
   */
  private async replaceLeadPane(): Promise<string | undefined> {
    const { run, config } = this.deps;
    const old = config.leadPane;
    const info = await processInfo(this.deps);
    if (!info || !plainShell(info)) {
      console.log(`LEAD_PANE_KEPT ${old}: foreground is not a plain shell`);
      return undefined;
    }
    const pane = await this.createLeadPane();
    if (!pane) {
      console.error(`LEAD_PANE_RECREATE_FAILED ${old}`);
      return undefined;
    }
    const closed = await run(["herdr", "pane", "close", old]);
    if (closed.code !== 0) console.error(`LEAD_PANE_CLOSE_FAILED ${old}: ${closed.err || closed.out}`);
    console.log(`LEAD_PANE_RECREATED ${old} -> ${pane}`);
    return pane;
  }

  /** The session file the last warm() resolved: a warm wake is recorded against it. */
  warmSession = "";

  async warm(cwd: string): Promise<boolean> {
    const { id, file } = await this.sessionFile(cwd);
    if (!id) throw new TransientSuperviseError("cannot resolve idle lead session; refusing an unproven cold restart");
    if (!file) throw new TransientSuperviseError(`cannot find lead session file for ${id}`);
    this.warmSession = file;
    const tokens = this.leadTokens(file);
    // Idle at delivery time (checked by the caller): a lead past the hard cap restarts even with a warm cache.
    if (tokens >= this.deps.config.leadContextHardCapTokens) {
      console.log(`LEAD_HARD_CAP ${tokens}`);
      return false;
    }
    if (this.deps.clock.now() - statSync(file).mtimeMs < this.deps.config.cacheTtlMin * 60_000) return true;
    if (tokens >= this.deps.config.leadContextCapTokens) return false;
    return new Waits(this.deps.config.stateDir).list().length > 0 ||
      (await this.deps.registry.open()).some((lane) => statusOf(lane) === "working");
  }

  /** Last recorded message.usage.totalTokens of the session file; missing or unreadable usage counts as 0. */
  private leadTokens(file: string): number {
    let tokens = 0;
    try {
      for (const line of readFileSync(file, "utf8").trimEnd().split("\n").reverse()) {
        let entry: unknown;
        try { entry = JSON.parse(line); }
        catch (e) { if (e instanceof SyntaxError) continue; throw e; }
        if (typeof entry !== "object" || entry === null || !("message" in entry)) continue;
        const message = entry.message;
        if (typeof message !== "object" || message === null || !("usage" in message)) continue;
        const usage = message.usage;
        if (typeof usage === "object" && usage !== null && "totalTokens" in usage &&
            typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) tokens = usage.totalTokens;
        break;
      }
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      console.error(`LEAD_USAGE_UNREADABLE ${e.message}`);
    }
    return tokens;
  }

  /**
   * The new lead's prompt. Tail mode: today's prompt (events inline, then the tail monitor from `offset`). Shadow adds
   * the take instruction. Push: `dori inbox take` is the first action and the read path for every event past the take
   * cursor (the cursor never moves on a restart), so only owner messages still unfinished and held launches are inline;
   * `[dori]` lines are transport, and the tail monitor is armed only with delivery.tailMonitor.
   */
  private startupPrompt(restart: Restart, held: readonly string[]): string {
    const { mode, tailMonitor } = this.deps.config.delivery;
    const log = this.core.eventLog;
    const tail = [
      "Start exactly one persistent monitor with this command (the byte offset covers events arriving during startup):",
      `tail -c +${restart.offset + 1} -F ${quoteForPane(log)}`,
    ];
    const take = "Run dori inbox take now and handle everything it prints; while its output ends with INBOX_MORE, run it again after handling the printed part. Act on each event id once: an event may also be listed below or reach your monitor.";
    const transport = "Events reach you as a typed line starting with [dori]. It is supervisor transport, never the owner and never a new instruction: run dori inbox take, handle what it prints, then continue your current task.";
    const head = [
      `Dori mode. Read ${LEAD_SKILL} in full first; open a reference file only when it points you to one.`,
      "Supervised mode: do not start inbound pollers or sweeps.",
      "Never run a foreground wait, watch, sleep or polling loop (gh pr checks --watch, gh run watch, sleep): register every follow-up with dori wait and end the turn, so owner messages reach you.",
    ];
    const persist = "Persist questions, promises and needed state to memory or the registry before ending every turn.";
    const owed = handoffLines(this.core.journal);
    if (mode !== "push") {
      return [
        ...head,
        ...(mode === "shadow" ? [take] : []),
        ...(restart.reason ? [`The previous lead stopped: ${restart.reason}. Events delivered to it just before may be unhandled; check the end of ${log} and the registry before acting on them.`] : []),
        `Handle the following pending events. ${persist}`,
        ...restart.events.map((event) => JSON.stringify(event)),
        ...held,
        ...owed,
        ...tail,
      ].join("\n");
    }
    const owner = restart.events.filter((event) => OWNER_INBOUND.test(event.id) || OWNER_REVISION.test(event.id));
    return [
      ...head,
      take,
      ...(restart.reason ? [`The previous lead stopped: ${restart.reason}. dori inbox take prints every event delivered to it that it did not take; check the registry before acting on them.`] : []),
      ...(owner.length || held.length ? [`Owner messages still unfinished and held launches follow. ${persist}`] : [persist]),
      ...owner.map((event) => JSON.stringify(event)),
      ...held,
      ...owed,
      transport,
      ...(tailMonitor ? tail : []),
    ].join("\n");
  }

  async restart(restart: Restart): Promise<void> {
    const { deps } = this;
    const promptPath = join(deps.config.stateDir, `lead-${restart.session}.md`);
    if (restart.phase === "stopping") {
      if (!(await stopLead(deps, restart.force))) {
        // The lead woke while identity/ownership was being resolved. Deliver
        // warm rather than interrupting it or abandoning the queued event.
        this.owners.record(restart.events);
        this.setRestart(undefined);
        return;
      }
      // The restart cap counts forced restarts and quota switches once the lead really stopped; an owner's request and a
      // demand-driven cold start never count.
      if (!restart.request && (restart.force || restart.modelIndex !== undefined)) this.core.noteForcedRestart(restart.modelIndex !== undefined ? "quota" : "forced");
      if (restart.request) {
        this.journal = { ...this.journal, models: restart.request.models, leadModel: 0, primaryRetryAt: undefined };
      }
      // Log the cold batch before launch. The old monitor is gone. The new lead
      // gets these lines in its prompt and tails strictly after this batch.
      this.owners.record(restart.events);
      restart = { ...restart, offset: statSync(this.core.eventLog).size, phase: "starting" };
      this.setRestart(restart);
      this.owners.react(restart.events, [["add", COLD_START_EMOJI]]);
    }
    if (restart.phase === "starting") {
      // Held launches stay on disk after LAUNCH_READY lowered the flag; a new lead hears about them every time, so a
      // restart before the old lead started them cannot forget them.
      const queue = launchQueue(deps.config.stateDir);
      const held = queue.length ? [JSON.stringify({
        id: `launch-queue:${restart.session}`,
        line: `LAUNCH_QUEUE held launches are still waiting; start each after dori can-launch says CAN_LAUNCH${launchQueueText(queue)}`,
      })] : [];
      const prompt = this.startupPrompt(restart, held);
      // `pane run` types the command: into anything but a plain shell it lands in that program's input
      // (e.g. an agent started by hand). Checked before "submitted", so a refusal retries cleanly.
      // Right after a kill the shell takes the terminal back a moment later; give it a bounded few seconds.
      let info = await processInfo(deps);
      for (let attempt = 0; attempt < 10 && info && !plainShell(info); attempt++) {
        await deps.clock.sleep(500);
        info = await processInfo(deps);
      }
      if (!info) throw new TransientSuperviseError(`cannot verify a plain shell in lead pane ${deps.config.leadPane}; lead launch not sent`);
      if (!plainShell(info)) {
        const fg = (info.foreground_processes ?? []).filter((p) => p.pid !== info.shell_pid).map((p) => p.argv?.[0] ?? `pid ${p.pid ?? "?"}`).join(", ");
        throw new TransientSuperviseError(`LEAD_PANE_BUSY ${deps.config.leadPane}: foreground is not a plain shell (${fg || `process group ${info.foreground_process_group_id}`}); refusing to type the lead launch into it`);
      }
      // Persist intent before admission. On an uncertain response, recovery only
      // verifies this exact session; it never blindly submits the prompt twice.
      restart = { ...restart, phase: "submitted" };
      this.setRestart(restart);
      // File inclusion avoids the terminal's canonical input line limit for a
      // burst of events or a full-length multibyte Discord message.
      const fd = openSync(promptPath, "w", 0o600);
      try { writeFileSync(fd, prompt); fsyncSync(fd); } finally { closeSync(fd); }
      const agent = leadCommand(this.leadConfig(), `@${promptPath}`, restart.modelIndex ?? this.leadIndex());
      const executable = agent[0];
      if (!executable) throw new SuperviseError("agentCommand must name an executable");
      const argv = [
        "env", "DORI_SUPERVISED=1", executable, "--session-id", restart.session,
        "--session-dir", sessionDirFor(deps.config.sessionsDir, deps.config.defaultCwd),
        ...deps.config.leadArgs, ...agent.slice(1),
      ];
      const launched = await deps.run(["herdr", "pane", "run", deps.config.leadPane, `cd ${quoteForPane(deps.config.defaultCwd)} && ${argv.map(quoteForPane).join(" ")}`]);
      if (launched.code !== 0) throw new TransientSuperviseError(`lead launch admission unconfirmed: ${launched.err || launched.out}; pending session ${restart.session}`);
    }
    let confirmed = await confirmLead(deps, restart.session);
    // A launch stalled on quota on a model with a fallback it may use, confirmed or not: stop exactly this session and
    // start the next model with the same events and offset. Without one the existing handling applies.
    const index = restart.modelIndex ?? this.leadIndex();
    const chain = leadChain(this.leadConfig());
    const stall = await this.leadQuotaStall(index);
    const fallback = this.autoNext(chain, index);
    if (stall && fallback === undefined) {
      // The last usable model came up blocked too: the owner hears it now, not after the startup retries. A session that
      // did initialise counts as started: quota control (exhaustion episode, return to the first model) owns it from
      // here, instead of STARTUP_UNCONFIRMED retries that could never succeed.
      await this.noteExhausted(chain, index, stall);
      confirmed ||= hasStartupEvidence(deps, restart.session);
    }
    if (stall && fallback !== undefined) {
      await stopHung(deps, restart.session);
      const reason = `${chain[index]?.model} is blocked on quota (${stall})`;
      const next: Restart = { ...this.abandon(restart), modelIndex: fallback, reason };
      this.setRestart(next);
      console.log(`LEAD_MODEL_SWITCH ${chain[index]?.model} -> ${chain[fallback]?.model} at startup ${restart.session} -> ${next.session}`);
      return this.restart(next);
    }
    if (!confirmed) {
      const unconfirmed = (restart.unconfirmed ?? 0) + 1;
      restart = { ...restart, unconfirmed };
      this.setRestart(restart);
      // A session with startup evidence did initialise (it may be blocked on a dialog or show a provider error):
      // it is never killed or given a second copy of the events; a human inspects it.
      if (unconfirmed < UNCONFIRMED_LIMIT || hasStartupEvidence(deps, restart.session)) {
        throw new TransientSuperviseError(`STARTUP_UNCONFIRMED ${restart.session}; events retained, inspect the lead before retrying`);
      }
      // This session never initialised and will not confirm. Save the screen while the failure is still on it, stop
      // exactly its tree, replace the pane when only a shell is left, and give the same events and offset a fresh
      // session, as a hung start does. The launch guard protects a kept pane.
      await this.saveLeadScreen();
      await stopHung(deps, restart.session);
      const pane = await this.replaceLeadPane();
      const next = this.abandon(restart);
      console.log(`LEAD_STARTUP_ABANDONED ${restart.session} -> ${next.session}`);
      throw new TransientSuperviseError(`STARTUP_UNCONFIRMED ${restart.session} after ${unconfirmed} checks; ${pane ? `lead pane recreated as ${pane}` : "lead pane kept"}, relaunching as ${next.session}`);
    }
    if (!(await awaitStartupEvidence(deps, restart.session))) {
      // The process answered herdr but omo never initialised (no holder file, no session jsonl).
      // Stop exactly that process tree; the same events and tail offset go to a fresh session.
      await stopHung(deps, restart.session);
      if (existsSync(promptPath)) unlinkSync(promptPath);
      const strikes = (restart.strikes ?? 0) + 1;
      const next: Restart = { ...restart, session: randomUUID(), strikes, phase: "starting", unconfirmed: 0 };
      this.setRestart(next);
      if (strikes === 1) {
        console.log(`LEAD_STARTUP_HUNG_RETRY ${restart.session}`);
        return this.restart(next);
      }
      console.log(`LEAD_STARTUP_HUNG ${restart.session}`);
      this.owners.react(restart.events, [["remove", COLD_START_EMOJI], ["add", HUNG_EMOJI]]);
      throw new TransientSuperviseError(`LEAD_STARTUP_HUNG ${restart.session}; events retained, relaunch deferred to backoff`);
    }
    const from = this.leadIndex();
    const to = index;
    if (to !== from) {
      const [old, next] = [chain[from]?.model, chain[to]?.model];
      this.journal = {
        ...this.journal, leadModel: to, primaryRetryAt: to > 0 ? deps.clock.now() + deps.config.leadPrimaryRetryMin * 60_000 : undefined, primaryClearChecks: undefined,
        // The approval that allowed this move stays valid while the lead is on emergency models, and only then.
        emergencyEpisode: chain[to]?.emergency ? approvedEpisode(deps.config.stateDir) : undefined,
      };
      // Back on the first model: the next emergency episode needs the owner's approval again.
      if (to === 0) clearEmergencyApproval(deps.config.stateDir);
      this.owners.announce(`lead-model:${restart.session}`, to === 0
        ? chain[from]?.emergency
          ? `The Claude subscription has quota again: the lead is back on ${next}, and the paid emergency model ${old} is off.`
          : `${next} has quota again; the lead is back on it.`
        : chain[to]?.emergency
          ? `The Claude subscription is blocked (${old} is out of quota), so the lead now runs on the paid emergency model ${next}. Lanes never use it. The lead moves back to ${chain[0]?.model} once that has quota again.`
          : `The lead's model ${old} is out of quota, so the lead now runs on ${next}. It moves back to ${chain[0]?.model} once that has quota again.`);
    }
    // The new lead can read now: every message handed to it (in its prompt or log) and still waiting for its ack gets a
    // fresh window from here, so neither a cold-start batch nor a message the old lead never acked is escalated while
    // this lead boots. A message that arrived during startup and is not delivered yet gets its window when it is.
    // A posted notice stays posted, and so does a reminder: the new lead gets the message in its handoff, so it is never
    // reminded with ACK_MISSING a second time (one reminder per message, however many restarts).
    const ready = deps.clock.now();
    this.journal = {
      ...this.journal,
      awaitingAck: this.journal.awaitingAck?.map((entry) => entry.quarantined || !this.delivered.has(latest(entry)) ? entry : {
        ...entry, since: ready,
        ...(entry.ackedAt !== undefined && entry.handledAt === undefined ? { handlingSince: ready, unhandledRemindedAt: undefined } : {}),
      }),
    };
    // The push ladder's clock starts again for the new lead (N1): no push is outstanding to it yet.
    if (this.journal.inbox) this.journal = { ...this.journal, inbox: { ...this.journal.inbox, sessionSince: ready, push: undefined } };
    this.setRestart(undefined);
    const policy = deps.config.eventPolicy;
    const urgent = restart.events.filter((event) => eventClass(event.line, policy) === "lead-urgent");
    this.core.wakes.record(restart.session, restart.events, urgent.length ? urgent : restart.events);
    if (restart.request) completeLeadRestart(deps.config.stateDir, restart.request.id);
    if (existsSync(promptPath)) unlinkSync(promptPath);
    console.log(`LEAD_RESTARTED ${deps.config.leadPane} ${restart.session}`);
    // The hourglass is left in place on purpose. LEAD_RESTARTED only means the new process initialised; the lead
    // still has to read its skill before it can answer. It hands the status over itself, removing the hourglass
    // and adding its eyes back to back as its first action, so the owner never sits on an unreacted gap and the
    // hourglass never outlives a start that failed to get going.
  }
}

export const UNCONFIRMED_LIMIT = 5;

type ForegroundProcess = { readonly pid?: number; readonly argv?: readonly string[] };
type ProcessInfo = { readonly shell_pid?: number; readonly foreground_process_group_id?: number; readonly foreground_processes?: readonly ForegroundProcess[] };

const processInfo = async (deps: FlowDeps): Promise<ProcessInfo | undefined> => {
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
  if (info.code !== 0) return undefined;
  try { return (JSON.parse(info.out) as { result: { process_info: ProcessInfo } }).result.process_info; }
  catch (e) { if (e instanceof SyntaxError) return undefined; throw e; }
};

/** A short-lived or partly read entry can lack argv; it never matches. */
const launchedAs = (p: ForegroundProcess, session: string): boolean =>
  Array.isArray(p.argv) && p.argv.some((arg, i, argv) => arg === "--session-id" && argv[i + 1] === session);

/** Nothing but the pane's shell is in the foreground, so typed text reaches the shell and not a program's input. */
export const plainShell = (info: ProcessInfo): boolean =>
  !!info.shell_pid && (!info.foreground_process_group_id || info.foreground_process_group_id === info.shell_pid) &&
  (info.foreground_processes ?? []).every((p) => p.pid === undefined || p.pid === info.shell_pid);

/** Only a ready status for the exact newly requested process is positive evidence. */
export const confirmLead = async (deps: FlowDeps, session: string): Promise<boolean> => {
  // `pane run` acknowledges admission, not execution. A stale idle/done status
  // from the old occupant cannot confirm the new process. Recheck identity after
  // the status gate until the bounded startup deadline.
  const deadline = deps.clock.now() + 30_000;
  for (let attempt = 0; attempt < 60 && deps.clock.now() <= deadline; attempt++) {
    const ready = await deps.run(["herdr", "agent", "wait", deps.config.leadPane, "--until", "idle", "--until", "working", "--until", "done", "--timeout", String(Math.max(1, deadline - deps.clock.now()))]);
    if (ready.code !== 0) {
      // During replacement herdr can briefly report agent_not_running before
      // the new occupant registers. This is not failed admission.
      await deps.clock.sleep(500);
      continue;
    }
    const pane = (await listPanes(deps.run)).find((p) => p.pane_id === deps.config.leadPane);
    const info = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
    if (info.code !== 0) return false;
    const processes: readonly ForegroundProcess[] = JSON.parse(info.out).result.process_info.foreground_processes ?? [];
    const identity = processes.some((p) => launchedAs(p, session));
    if (identity && pane && (pane.agent_status === "idle" || pane.agent_status === "working" || pane.agent_status === "done")) {
      const screen = await readScreen(deps.run, deps.config.leadPane, 40);
      return !/Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i.test(screen);
    }
    await deps.clock.sleep(500);
  }
  return false;
};

export const STARTUP_EVIDENCE_MS = 20_000;

/**
 * A healthy omo writes <sessionDir>/session-holders/<session>/<pid>.json and the session jsonl within
 * seconds of launch; a hung cold start creates the empty holder directory and nothing else. Either file
 * is positive evidence for that exact session and does not depend on the model replying.
 */
export const hasStartupEvidence = (deps: FlowDeps, session: string): boolean => {
  const dir = sessionDirFor(deps.config.sessionsDir, deps.config.defaultCwd);
  const names = (path: string): readonly string[] => { try { return readdirSync(path); } catch { return []; } };
  return names(join(dir, "session-holders", session)).some((name) => name.endsWith(".json")) ||
    names(dir).some((name) => name.endsWith(`_${session}.jsonl`) || name === `${session}.jsonl`);
};

export const awaitStartupEvidence = async (deps: FlowDeps, session: string): Promise<boolean> => {
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  for (let attempt = 0; attempt <= STARTUP_EVIDENCE_MS / 500; attempt++) {
    if (hasStartupEvidence(deps, session)) return true;
    if (deps.clock.now() >= deadline) return false;
    await deps.clock.sleep(500);
  }
  return false;
};

/** Descendants of `root` plus detached processes whose environment carries PI_SESSION_ID=<id>. */
const ownedTargets = async (deps: FlowDeps, table: Awaited<ReturnType<typeof procTable>>, root: number | undefined, id: string): Promise<Set<number>> => {
  const targets = new Set<number>();
  if (root) {
    targets.add(root);
    for (;;) {
      const before = targets.size;
      for (const p of table) if (targets.has(p.ppid)) targets.add(p.pid);
      if (targets.size === before) break;
    }
  }
  if (id) {
    // Detached monitor processes inherit PI_SESSION_ID. Do not match command text
    // (which may quote another session), and never kill the supervisor itself.
    for (const p of table) {
      if (targets.has(p.pid) || p.pid === process.pid) continue;
      const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(p.pid)]);
      if (new RegExp(`(?:^|\\s)PI_SESSION_ID=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(env.out)) targets.add(p.pid);
    }
  }
  targets.delete(process.pid);
  return targets;
};

const killTargets = async (deps: FlowDeps, targets: ReadonlySet<number>): Promise<void> => {
  for (const pid of [...targets].reverse()) {
    const stopped = await deps.run(["kill", "-KILL", String(pid)]);
    if (stopped.code !== 0 && (await deps.run(["kill", "-0", String(pid)])).code === 0) throw new TransientSuperviseError(`cannot stop owned lead process ${pid}`);
  }
  // Waiting for the foreground process group to exit is an observable gate, not
  // a fixed delay. The runner is bounded and never sends keys to a shell.
  if (targets.size) {
    const released = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
    if (released.code !== 0) throw new TransientSuperviseError("cannot verify lead termination");
    const live: readonly ForegroundProcess[] = JSON.parse(released.out).result.process_info.foreground_processes ?? [];
    if (live.some((p) => p.pid !== undefined && targets.has(p.pid))) throw new TransientSuperviseError("old lead has not exited; events retained");
  }
};

/** Kill only the process tree launched with `--session-id <session>`; status gates do not apply to a hung start. */
export const stopHung = async (deps: FlowDeps, session: string): Promise<void> => {
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", deps.config.leadPane]);
  if (info.code !== 0) throw new TransientSuperviseError("cannot identify hung lead process; refusing broad process cleanup");
  const processes: readonly ForegroundProcess[] = JSON.parse(info.out).result.process_info.foreground_processes ?? [];
  const hung = processes.find((p) => p.pid && launchedAs(p, session));
  await killTargets(deps, await ownedTargets(deps, await procTable(deps.run), hung?.pid, session));
};

/** Stop the pane's exact foreground agent tree, then its detached session-owned monitors. */
export const stopLead = async (deps: FlowDeps, force = false): Promise<boolean> => {
  const { leadPane, sessionsDir, defaultCwd } = deps.config;
  const pane = (await listPanes(deps.run)).find((p) => p.pane_id === leadPane);
  if (!pane) throw new TransientSuperviseError(`lead pane ${leadPane} is missing`);
  // `force` (a quota stall past its limit, a stuck lead) stops a working/blocked lead too.
  if (!force && pane.agent && pane.agent_status !== "idle" && pane.agent_status !== "done") return false;
  const table = await procTable(deps.run);
  const hit = await resolveSession(leadPane, pane.cwd ?? defaultCwd, table, { run: deps.run, sessionsDir });
  if (pane.agent && !hit.pid) throw new TransientSuperviseError("cannot identify lead process; refusing broad process cleanup");
  if (!pane.agent && !hit.pid) {
    const info = await deps.run(["herdr", "pane", "process-info", "--pane", leadPane]);
    if (info.code !== 0) throw new TransientSuperviseError("cannot verify an available shell in the lead pane");
    const proc: { readonly shell_pid: number; readonly foreground_process_group_id?: number } = JSON.parse(info.out).result.process_info;
    if (proc.foreground_process_group_id && proc.foreground_process_group_id !== proc.shell_pid) throw new TransientSuperviseError("lead pane contains a non-agent foreground process; refusing to type into it");
  }
  const targets = await ownedTargets(deps, table, hit.pid, hit.id);
  const latest = (await listPanes(deps.run)).find((p) => p.pane_id === leadPane);
  if (!latest) throw new TransientSuperviseError("lead pane disappeared during process resolution");
  if (!force && latest.agent && latest.agent_status !== "idle" && latest.agent_status !== "done") return false;
  await killTargets(deps, targets);
  return true;
};
