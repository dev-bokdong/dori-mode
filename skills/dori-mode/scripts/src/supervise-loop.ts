import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolveCredential } from "./credentials.ts";
import { configPath, deliveryConfigError, saveLeadPane } from "./config.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { type Emit, watchTick, type FlowDeps } from "./done-flow.ts";
import { freshnessTick, scrubForThread } from "./freshness.ts";
import { laneQuotaTick } from "./quota-stall.ts";
import { cachedMode, claudeQuotaTick, gateVerdict, lookupQuotaResults, quotaReport, stateHoldsLanes, type GateMode, type UsageLookup } from "./claude-quota.ts";
import { recoverLanes, type RecoveryEnqueue } from "./recover.ts";
import { memorySweep } from "./memory-check.ts";
import { diskGuardPath, type GuardState, guardTick, sampleHost } from "./host-guard.ts";
import { run, type Runner, setDefaultRunTimeout } from "./run.ts";
import { canLaunch, clearLaunchHold, launchHeld } from "./routing.ts";
import { Discord } from "./messenger/discord.ts";
import { acquireDiscordGateway } from "./messenger/discord-lock.ts";
import { supervisorDiscord, type SupervisorDiscordOptions } from "./messenger/discord-supervisor.ts";
import { fetchHttp } from "./messenger/http.ts";
import { writeGatewayStatus } from "./gateway-status.ts";
import { lookupStatus } from "./status.ts";
import { OWNER_NOTICE_AFTER_MS, RetryingDelivery, SuperviseError, Supervisor } from "./supervise.ts";
import { Waits } from "./waits.ts";
import { GitHubEvents } from "./github-events.ts";
import { CiFollowUp } from "./ci-follow.ts";
import { newSweepCache, passthroughView, type SweepView, sweepRound } from "./sweep-view.ts";
import { StartupProbe } from "./startup-probe.ts";
import { type BuiltinSource, EventSources, type SourceEnqueue } from "./event-sources.ts";
import { pidAlive, releaseSlot, trySlot } from "./heavy-slot.ts";
import { openOperations, type OperationStore } from "./operations.ts";
import { type LaneReportStore, leadPaneViolationTick, openLaneReports, routeReports } from "./lane-reports.ts";

/** One supervisor writer per stateDir, including across competing CLI invocations. */
export const acquireSupervisor = (stateDir: string): (() => void) => {
  mkdirSync(stateDir, { recursive: true });
  // An OS-backed SQLite lock is released even on SIGKILL; a PID file is not.
  const db = new Database(join(stateDir, "supervisor-lock.sqlite"));
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    throw new SuperviseError(`cannot acquire supervisor lock: ${e instanceof Error ? e.message : String(e)}`);
  }
  return () => { db.close(); };
};

/**
 * Tells systemd (Type=notify units) about `state`, e.g. READY=1 or WATCHDOG=1, through systemd-notify. A no-op returning
 * false when NOTIFY_SOCKET is unset; a failure is logged, never thrown.
 */
export const sdNotify = async (state: string, env: Readonly<Record<string, string | undefined>> = process.env, runner: Runner = run): Promise<boolean> => {
  if (!env.NOTIFY_SOCKET) return false;
  try {
    const r = await runner(["systemd-notify", `--pid=${process.pid}`, state], { timeoutMs: 5_000 });
    if (r.code === 0) return true;
    console.error(`SD_NOTIFY_FAILED ${state} ${r.err || r.out || `exit ${r.code}`}`);
  } catch (e) {
    console.error(`SD_NOTIFY_FAILED ${state} ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
};

/** A background task or the foreground loop showing no progress this long withholds the systemd watchdog. */
export const WATCHDOG_STALL_MS = 15 * 60_000;
/** How often the watchdog is considered, independent of the loop (so one long sweep does not trip WatchdogSec). */
export const WATCHDOG_PET_MS = 60_000;
/**
 * A supervisor task whose current pass has run this long is reported by name (TASK_STALLED) while the other
 * tasks keep running; past WATCHDOG_STALL_MS it withholds the watchdog as task:<name>, so systemd restarts the supervisor.
 */
export const TASK_ALERT_MS = 5 * 60_000;
/** The supervisor's independent tasks. */
export const SUPERVISOR_TASKS = ["inbound", "delivery", "sweeps", "polling"] as const;
export type SupervisorTask = (typeof SUPERVISOR_TASKS)[number];

/**
 * Decides when systemd may be told WATCHDOG=1: only while the foreground loop has made progress (a finished pass, or a
 * finished inline sweep) within WATCHDOG_STALL_MS and no tracked background task (delivery, waits, GitHub, each sweep)
 * has been running longer. A
 * stuck component therefore lets systemd restart the supervisor even though the loop itself keeps turning.
 */
export class Watchdog {
  private last: number;
  private readonly running = new Map<string, number>();
  private withheld?: string;

  constructor(private readonly now: () => number, private readonly notify: (state: string) => Promise<boolean>, private readonly stallMs = WATCHDOG_STALL_MS) {
    this.last = now();
  }

  progress(): void { this.last = this.now(); }

  /** Marks `name` running until `work` settles. */
  track<T>(name: string, work: Promise<T>): Promise<T> {
    this.running.set(name, this.now());
    return work.finally(() => { this.running.delete(name); });
  }

  /** Tracked work whose name starts with `prefix`, with how long it has been running (the supervisor tasks' liveness). */
  busy(prefix: string): readonly (readonly [name: string, ms: number])[] {
    const now = this.now();
    return [...this.running].filter(([name]) => name.startsWith(prefix)).map(([name, since]) => [name, now - since] as const);
  }

  stalled(): string | undefined {
    const now = this.now();
    if (now - this.last >= this.stallMs) return "loop";
    for (const [name, since] of this.running) if (now - since >= this.stallMs) return name;
    return undefined;
  }

  async pet(): Promise<boolean> {
    const stalled = this.stalled();
    if (stalled) {
      if (this.withheld !== stalled) console.error(`WATCHDOG_WITHHELD ${stalled} has made no progress for ${Math.round(this.stallMs / 60_000)} min`);
      this.withheld = stalled;
      return false;
    }
    this.withheld = undefined;
    return this.notify("WATCHDOG=1");
  }
}

/** A named sweep. It may hand lines over itself through `emit` (as they happen) and/or return them. */
export type Sweep = readonly [name: string, step: (emit: Emit) => Promise<readonly string[]>];

/** The same warning line is enqueued at most once per hour; the console still logs every failure. */
export const WARN_REPEAT_MS = 60 * 60_000;

/** How often the watcher also walks the closed lanes in the archive (their kept-worktree cleanup). */
export const ARCHIVE_SWEEP_MS = 10 * 60_000;

/**
 * The supervisor's sweeps over one long-lived state (guard transitions, dead-pane memory, pane read cache). The first
 * sweep takes the round's pane snapshot; every later sweep of the round observes panes through it.
 */
export const supervisorSweeps = (
  deps: FlowDeps, home: string, usage: UsageLookup = lookupQuotaResults(), enqueueRecovery?: RecoveryEnqueue,
  laneReports: () => LaneReportStore | undefined = () => undefined,
): readonly Sweep[] => {
  const guard: GuardState = { alerting: false };
  const claude: { at: number; mode?: GateMode } = { at: -Infinity };
  const seen = new Set<string>();
  const dead = newDeadPaneState();
  const cache = newSweepCache();
  let view: SweepView = passthroughView(deps.run);
  let lastArchive = -Infinity;
  return [
    ["snapshot", async () => {
      view = passthroughView(deps.run);
      // A bad deadline warns every round and the sweeps read per lane.
      if (!Number.isFinite(deps.config.sweepMachineDeadlineMs) || deps.config.sweepMachineDeadlineMs <= 0) throw new SuperviseError("sweepMachineDeadlineMs must be positive");
      view = await sweepRound(deps.run, cache, await deps.registry.open(), { now: deps.clock.now, deadlineMs: deps.config.sweepMachineDeadlineMs });
      return [];
    }],
    ["watch", async (emit) => {
      const archived = deps.clock.now() - lastArchive >= ARCHIVE_SWEEP_MS;
      await watchTick(deps, emit, view, archived);
      if (archived) lastArchive = deps.clock.now();
      return [];
    }],
    ["guard", async (emit) => {
      const sample = await sampleHost(deps.run, diskGuardPath(deps.config), () => view.panes().then((panes) => panes.length, () => -1));
      for (const line of guardTick(sample, deps.config.guard, guard)) await emit(line);
      // Work queued on a HOLD from `dori can-launch` resumes on this, whichever threshold kept it held, including the
      // Claude quota gate (read from the usage sweep's cache). An unreadable pane count (-1) proves no room.
      const quota = cachedMode(deps.config, deps.clock.now());
      const quotaHeld = quota !== undefined && stateHoldsLanes(quota);
      if (sample.panes >= 0 && launchHeld(deps.config.stateDir) && canLaunch(sample, deps.config.guard).ok && !quotaHeld) {
        const claude = quota ? `, Claude headroom ${Math.round(gateVerdict(quota.usage, deps.config.quotaGate).headroomPct)}%` : "";
        await emit(`LAUNCH_READY the host has room again (load ${sample.load1.toFixed(0)}, memory free ${sample.memFreePct}%, disk free ${sample.diskFreeGb.toFixed(0)} GB, panes ${sample.panes}${claude}); start the held work after dori can-launch`);
        clearLaunchHold(deps.config.stateDir);
      }
      return [];
    }],
    ["dead-panes", async () => deadPaneTick(deps.run, deps.config, seen, new Date(deps.clock.now()).toISOString().slice(0, 13), dead, await deps.registry.open(), view)],
    // Recovery notices are journaled with stable ids before recover saves the flags that suppress them.
    ["recover", async () => recoverLanes(deps, undefined, enqueueRecovery, view)],
    ["freshness", async () => (await freshnessTick(deps, home, view, laneReports())).map((act) => `${act.kind.toUpperCase()} ${act.lane} ${act.detail}`)],
    // Quota stalls too: the event is journaled before the pause intent that would replay it is cleared.
    ["quota", async () => laneQuotaTick(deps, enqueueRecovery, view)],
    ["claude-quota", async () => claudeQuotaTick(deps, usage, claude)],
    ["memory", async () => memorySweep(deps, home)],
    // Counts [REPORT] lines of `dori report` lanes found in the lead's pane; reads nothing while no such lane is open.
    ["lead-pane", async (emit) => { await leadPaneViolationTick(deps, emit); return []; }],
  ];
};

/**
 * Runs each sweep on its own. Lines are enqueued as each sweep produces them, so a later failure cannot drop them,
 * and a sweep that throws costs only its own remaining lines: it becomes one digest warning (LANE_WATCH_WARN for the
 * watcher, SWEEP_WARN <name> otherwise) and the next sweep still runs. Nothing here ends the supervisor.
 */
export const runSweeps = async (sweeps: readonly Sweep[], emit: Emit, now: () => number, recent: Map<string, number>, log: (line: string) => void): Promise<void> => {
  const put: Emit = async (line, id) => {
    if (/^\S*_WARN\b/.test(line)) {
      for (const [seen, at] of recent) if (now() - at >= WARN_REPEAT_MS) recent.delete(seen);
      const last = recent.get(line);
      if (last !== undefined && now() - last < WARN_REPEAT_MS) return;
      recent.set(line, now());
    }
    await emit(line, id);
  };
  for (const [name, step] of sweeps) {
    try {
      for (const line of await step(put)) await put(line);
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
      log(`SWEEP_ERROR ${name} ${message}`);
      try { await put(name === "watch" ? `LANE_WATCH_WARN ${message}` : `SWEEP_WARN ${name} ${message}`); }
      catch (w) { log(`SWEEP_WARN_LOST ${name} ${w instanceof Error ? w.message : String(w)}`); }
    }
  }
};

/** How supervise() waits between passes; tests inject one that waits for the test instead of real time. */
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or at once when `signal` aborts. */
const pause: Pause = (ms, signal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  if (signal.aborted) done();
});

/**
 * Polling and sweeps enqueue independently of the single serialized lead delivery. There is no single loop: inbound,
 * delivery (with the owner notices and ack ticks), sweeps and GitHub/wait polling each run as their own task, so none
 * waits behind another; a stuck one is reported by name (TASK_STALLED) while the other three keep working, and each sweep
 * is tracked by the watchdog. Each startup step up to READY=1 is timed by `probe` (STARTUP_TIMINGS, STARTUP_SLOW <step>),
 * so a hang names its step, and each task's first pass is reported as `first-<task>` (`first-sweep` for the sweeps).
 */
export const supervise = async (
  deps: FlowDeps, signal: AbortSignal, discordOptions: Partial<Omit<SupervisorDiscordOptions, "emit">> = {},
  notify: (state: string) => Promise<boolean> = sdNotify, probe = new StartupProbe(), wait: Pause = pause,
): Promise<void> => {
  if (!deps.config.leadPane) throw new SuperviseError("supervise requires leadPane");
  if (!Number.isFinite(deps.config.cacheTtlMin) || deps.config.cacheTtlMin <= 0) throw new SuperviseError("cacheTtlMin must be positive");
  if (!Number.isFinite(deps.config.leadContextCapTokens) || deps.config.leadContextCapTokens <= 0) throw new SuperviseError("leadContextCapTokens must be positive");
  if (!Number.isFinite(deps.config.leadContextHardCapTokens) || deps.config.leadContextHardCapTokens <= 0) throw new SuperviseError("leadContextHardCapTokens must be positive");
  if (!Number.isFinite(deps.config.githubPollSeconds) || deps.config.githubPollSeconds <= 0) throw new SuperviseError("githubPollSeconds must be positive");
  if (!Number.isFinite(deps.config.githubTimeoutMs) || deps.config.githubTimeoutMs <= 0) throw new SuperviseError("githubTimeoutMs must be positive");
  if (!Number.isFinite(deps.config.discordSafetyPollSeconds) || deps.config.discordSafetyPollSeconds <= 0) throw new SuperviseError("discordSafetyPollSeconds must be positive");
  if (!Number.isFinite(deps.config.digestMaxDelayMin) || deps.config.digestMaxDelayMin <= 0) throw new SuperviseError("digestMaxDelayMin must be positive");
  if (!Number.isFinite(deps.config.ackTimeoutSec) || deps.config.ackTimeoutSec <= 0) throw new SuperviseError("ackTimeoutSec must be positive");
  if (!Number.isFinite(deps.config.runTimeoutMs) || deps.config.runTimeoutMs < 0) throw new SuperviseError("runTimeoutMs must be zero or positive");
  if (!Number.isFinite(deps.config.handledTimeoutMin) || deps.config.handledTimeoutMin <= 0) throw new SuperviseError("handledTimeoutMin must be positive");
  if (!Number.isFinite(deps.config.reportTimeoutMin) || deps.config.reportTimeoutMin <= 0) throw new SuperviseError("reportTimeoutMin must be positive");
  if (!Number.isFinite(deps.config.leadQuotaBusySwitchMin) || deps.config.leadQuotaBusySwitchMin <= 0) throw new SuperviseError("leadQuotaBusySwitchMin must be positive");
  if (!Number.isFinite(deps.config.leadStuckRestartMin) || deps.config.leadStuckRestartMin <= 0) throw new SuperviseError("leadStuckRestartMin must be positive");
  if (!Number.isFinite(deps.config.leadUnreadRestartMin) || deps.config.leadUnreadRestartMin <= 0) throw new SuperviseError("leadUnreadRestartMin must be positive");
  if (!Number.isInteger(deps.config.leadPrimaryReturnChecks) || deps.config.leadPrimaryReturnChecks <= 0) throw new SuperviseError("leadPrimaryReturnChecks must be a positive integer");
  if (!Number.isInteger(deps.config.waitMaxFailures) || deps.config.waitMaxFailures <= 0) throw new SuperviseError("waitMaxFailures must be a positive integer");
  const deliveryProblem = deliveryConfigError(deps.config.delivery);
  if (deliveryProblem) throw new SuperviseError(deliveryProblem);
  setDefaultRunTimeout(deps.config.runTimeoutMs);
  let release: (() => void) | undefined;
  let ready = false;
  let releaseGateway: (() => void) | undefined;
  let inbound: ReturnType<typeof supervisorDiscord> | undefined;
  let sources: EventSources | undefined;
  let scheduleOps: OperationStore | undefined;
  let reports: LaneReportStore | undefined;
  const watchdog = new Watchdog(deps.clock.now, notify);
  let petting: ReturnType<typeof setInterval> | undefined;
  const stop = new AbortController();
  let tasks: Promise<unknown> | undefined;
  let ci: CiFollowUp | undefined;
  try {
    release = probe.step("lock", () => acquireSupervisor(deps.config.stateDir));
    const token = discordOptions.token ?? probe.step("credential", () => resolveCredential("DORI_DISCORD_TOKEN"));
    if (!token) throw new SuperviseError("supervise requires DORI_DISCORD_TOKEN for lossless paginated Discord polling");
    releaseGateway = probe.step("gateway-lock", () => acquireDiscordGateway(token));
    const discord = new Discord(fetchHttp, deps.clock, token);
    // Resolved once: the file this process loaded (DORI_CONFIG or ~/.dori/config.json).
    const loadedConfig = configPath();
    const supervisor = probe.step("supervisor", () => new Supervisor(deps, {
      react: (op, channel, message, emoji) => op === "add" ? discord.react(channel, message, emoji) : discord.unreact(channel, message, emoji),
      persistLeadPane: (pane) => { saveLeadPane(loadedConfig, pane); },
      announce: async (text, id) => {
        const channel = deps.config.discordChannels[0];
        if (!channel) throw new Error("no discordChannels configured");
        await discord.send(channel, text, id);
      },
    }));
    // Every built-in enqueues through the source registry, which records its last event and errors. The schedule sources
    // run too, each run an operation row; a heavy job takes a heavy slot like `dori heavy`, without waiting for one.
    const ops = scheduleOps = probe.step("schedules", () => openOperations(deps.config));
    const heavyLoad = async (): Promise<number> => (await sampleHost(deps.run, diskGuardPath(deps.config))).load1;
    const registry = sources = new EventSources({
      stateDir: deps.config.stateDir, enqueue: (id, line) => supervisor.enqueue(id, line), now: deps.clock.now, run: deps.run,
      policy: deps.config.eventPolicy, log: (line) => { console.error(line); },
      schedules: {
        operations: ops, journaled: (id: string) => supervisor.journaled(id),
        heavy: {
          take: async (label: string) => (await trySlot({
            dir: join(deps.config.stateDir, "heavy"), slots: deps.config.heavySlots, maxLoad: deps.config.heavyMaxLoad, clock: deps.clock,
            load: heavyLoad, alive: pidAlive, pid: process.pid,
          }, label)) ?? undefined,
          release: releaseSlot,
        },
      },
    });
    const enqueueOf = (name: BuiltinSource): SourceEnqueue => registry.enqueueFor(name);
    const guarded = <T>(name: BuiltinSource, work: Promise<T>): Promise<T> => registry.guard(name, work);
    const enqueueSweep = enqueueOf("sweeps");
    const enqueueWait = enqueueOf("waits");
    const enqueueGitHub = enqueueOf("github");
    const enqueueDiscord = enqueueOf("discord");
    const waits = probe.step("waits", () => new Waits(deps.config.stateDir, deps.config.waitMaxFailures));
    const github = probe.step("github", () => new GitHubEvents(deps.config.stateDir, deps.config.store, deps.clock.now));
    const follow = ci = probe.step("ci-follow", () => new CiFollowUp(deps));
    // CI follow-up reads the poll it follows, so it runs right after each GitHub tick.
    const pollGithub = async (): Promise<void> => {
      await github.tick(deps, enqueueGitHub);
      await follow.tick(github.openPulls(), enqueueGitHub, github.mergedPulls());
    };
    const home = process.env.HOME ?? "";
    // The sweep task gets its own span, so its timings never mix into the startup report.
    const sweepProbe = probe.span();
    // Each sweep is tracked: one stuck past WATCHDOG_STALL_MS withholds the watchdog.
    // The watcher reads its claim announcements back from the journal.
    const sweeps = supervisorSweeps({ ...deps, leadDelivered: (id) => supervisor.leadDelivered(id) }, home, undefined, async (line, id) => { enqueueSweep(id, line); }, () => reports).map(([name, step]): Sweep => [name, async (emit) =>
      watchdog.track(`sweep:${name}`, sweepProbe.step(`loop:sweep:${name}`, () => step(emit)))]);
    const recentWarnings = new Map<string, number>();
    const boot = randomUUID();
    const retry = new RetryingDelivery({
      now: deps.clock.now,
      flush: () => supervisor.flush(),
      repair: () => supervisor.repairLeadPane(),
      enqueue: (id, line) => supervisor.enqueue(id, line),
      notify: async (text) => {
        const channel = deps.config.discordChannels[0];
        if (!channel) throw new Error("no discordChannels configured");
        await discord.send(channel, text);
      },
      log: (line) => { console.error(line); },
    }, boot);
    let sequence = 0;
    let deliveryError: unknown;
    const emit = async (id: string, line: string): Promise<void> => { enqueueDiscord(id, line); };
    const discordInbound = probe.step("inbound", () => supervisorDiscord(deps, {
      ...discordOptions, token, emit,
      http: discordOptions.http ?? ((request) => fetchHttp({
        ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })),
      lookup: discordOptions.lookup ?? quotaReport(lookupQuotaResults(), () => deps.config.quotaGate, deps.config.stateDir, deps.clock.now),
      statusLookup: discordOptions.statusLookup ?? lookupStatus(deps),
    }));
    inbound = discordInbound;
    const heartbeat = (): void => {
      try {
        const gateway = inbound?.state() ?? { connected: false, messageContent: false };
        writeGatewayStatus(deps.config.stateDir, { pid: process.pid, at: deps.clock.now(), ...gateway });
      } catch (e) {
        console.error(`GATEWAY_STATUS_ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const sweep = async (): Promise<void> => {
      const failed: string[] = [];
      await runSweeps(sweeps, async (line, id) => { enqueueSweep(id ?? `sweep:${boot}:${sequence++}`, line); }, deps.clock.now, recentWarnings, (line) => {
        console.error(line);
        if (line.startsWith("SWEEP_ERROR ")) failed.push(line.slice("SWEEP_ERROR ".length));
      });
      if (failed.length) registry.fail("sweeps", failed.join("; "));
      else registry.ok("sweeps");
    };
    // Lane reports are routed in the 5 s polling pass, so a question reaches the lead within one pass and one delivery
    // tick of being written.
    const reportStore = reports = probe.step("lane-reports", () => openLaneReports(deps.config));
    const routeLaneReports = (): Promise<void> => watchdog.track("reports", routeReports(deps, reportStore, enqueueSweep, home))
      .then((lines) => { for (const line of lines) console.log(line); })
      .catch((e: unknown) => { console.error(`LANE_REPORTS_ERROR ${e instanceof Error ? e.message : String(e)}`); });
    const tickSources = (): Promise<void> => watchdog.track("sources", registry.tick())
      .catch((e: unknown) => { console.error(`SOURCES_ERROR ${e instanceof Error ? e.message : String(e)}`); });
    // An owner message the lead has not taken within a minute gets one plain line in its own channel or thread.
    const noticeOverdue = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.overdueOwnerMessages>;
      try { due = supervisor.overdueOwnerMessages(OWNER_NOTICE_AFTER_MS); }
      catch (e) { console.error(`OWNER_NOTICE_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        try {
          supervisor.noticeAttempt("delay", channel, message);
          await discord.send(channel, deps.config.ownerDelayNotice, `delay:${channel}:${message}`);
          supervisor.noticeSent("delay", channel, message);
        }
        catch (e) { console.error(`OWNER_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A message the lead was handed but never acked: ACK_MISSING wakes it, and after a second window the owner gets one line.
    const noticeUnacked = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.ackTick>;
      try { due = supervisor.ackTick(deps.config.ackTimeoutSec * 1_000); }
      catch (e) { console.error(`ACK_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        console.log(`ACK_MISSING_NOTICE ${channel}/${message}`);
        try {
          supervisor.noticeAttempt("ack", channel, message);
          await discord.send(channel, deps.config.ackMissingNotice, `ack:${channel}:${message}`);
          supervisor.noticeSent("ack", channel, message);
        }
        catch (e) { console.error(`ACK_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A message the lead acked but never linked to lanes or a reply: UNHANDLED wakes it, then the owner gets one line.
    const noticeUnhandled = async (): Promise<void> => {
      let due: ReturnType<typeof supervisor.handledTick>;
      try { due = supervisor.handledTick(deps.config.handledTimeoutMin * 60_000); }
      catch (e) { console.error(`HANDLED_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const { channel, message } of due) {
        console.log(`UNHANDLED_NOTICE ${channel}/${message}`);
        try {
          supervisor.noticeAttempt("unhandled", channel, message);
          await discord.send(channel, deps.config.unhandledNotice, `unhandled:${channel}:${message}`);
          supervisor.noticeSent("unhandled", channel, message);
        }
        catch (e) { console.error(`UNHANDLED_NOTICE_FAILED ${channel}/${message}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    // A finished lane the lead did not report to the owner (dori reported) in time: UNREPORTED wakes the lead. The
    // supervisor never tells the owner itself.
    const checkReported = async (): Promise<void> => {
      try { await supervisor.reportTick(); }
      catch (e) { console.error(`REPORT_CHECK_ERROR ${e instanceof Error ? e.message : String(e)}`); }
    };
    let lastGitHub = -Infinity;
    console.log(`SUPERVISOR_READY ${supervisor.eventLog}`);
    await probe.step("ready", () => notify("READY=1"));
    ready = true;
    probe.report("ready");
    petting = setInterval(() => { void watchdog.pet(); }, WATCHDOG_PET_MS);
    // Each task is its own loop, so one stuck pass costs only that task. Every pass is tracked as task:<name>: the
    // loop below reports one running past TASK_ALERT_MS by name, and past WATCHDOG_STALL_MS it withholds the watchdog.
    const halted = AbortSignal.any([signal, stop.signal]);
    const task = (name: SupervisorTask, pauseMs: number, pass: () => Promise<void>): Promise<void> => (async () => {
      const span = name === "sweeps" ? undefined : probe.span();
      while (!halted.aborted) {
        // The pass starts only once task:<name> is tracked, so the watchdog names the task before any work it tracks inside.
        try { await watchdog.track(`task:${name}`, Promise.resolve().then(() => span?.active ? span.step(`task:${name}`, pass) : pass())); }
        catch (e) { console.error(`TASK_ERROR ${name} ${e instanceof Error ? e.message : String(e)}`); }
        if (span?.active) {
          span.report(`first-${name}`);
          span.close();
        }
        await wait(pauseMs, halted);
      }
    })();
    tasks = Promise.all([
      task("inbound", 5_000, async () => {
        try { await guarded("discord", discordInbound.tick()); } catch (e) { console.error(`INBOUND_ERROR ${e instanceof Error ? e.message : String(e)}`); }
        heartbeat();
      }),
      task("delivery", 5_000, async () => {
        await noticeOverdue();
        await noticeUnacked();
        await noticeUnhandled();
        await checkReported();
        if (!retry.due) return;
        // A fatal delivery error ends the supervisor, as in the loop.
        try { await watchdog.track("delivery", retry.tick()); } catch (e) { deliveryError = e; stop.abort(); }
      }),
      task("sweeps", 30_000, () => sweep()
        .catch((e: unknown) => { console.error(`SWEEP_ROUND_ERROR ${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => {
          if (sweepProbe.active) {
            sweepProbe.report("first-sweep");
            sweepProbe.close();
          }
        })),
      task("polling", 5_000, async () => {
        const polls = [watchdog.track("waits", guarded("waits", waits.tick(deps.clock.now, deps.run, enqueueWait)))
          .catch((e: unknown) => { console.error(`WAIT_ERROR ${e instanceof Error ? e.message : String(e)}`); })];
        if (deps.clock.now() - lastGitHub >= deps.config.githubPollSeconds * 1_000) {
          lastGitHub = deps.clock.now();
          polls.push(watchdog.track("github", guarded("github", pollGithub()))
            .catch((e: unknown) => { console.error(`GITHUB_ERROR ${e instanceof Error ? e.message : String(e)}`); }));
        }
        polls.push(tickSources(), routeLaneReports());
        await Promise.all(polls);
      }),
    ]);
    probe.close();
    const stalled = new Set<string>();
    while (!halted.aborted) {
      const busy = new Map(watchdog.busy("task:"));
      for (const name of stalled) {
        if ((busy.get(name) ?? 0) >= TASK_ALERT_MS) continue;
        stalled.delete(name);
        console.log(`TASK_RECOVERED ${name.slice("task:".length)}`);
      }
      for (const [name, ms] of busy) {
        if (ms < TASK_ALERT_MS || stalled.has(name)) continue;
        stalled.add(name);
        const which = name.slice("task:".length);
        const line = `TASK_STALLED ${which} its pass has run ${Math.round(ms / 60_000)} min without finishing; the other supervisor tasks keep running, and the supervisor restarts if it is still stuck at ${Math.round(WATCHDOG_STALL_MS / 60_000)} min`;
        const id = `task-stalled:${boot}:${which}:${deps.clock.now() - ms}`;
        console.error(line);
        try { supervisor.enqueue(id, line); } catch (e) { console.error(`TASK_STALLED_ENQUEUE_FAILED ${which} ${e instanceof Error ? e.message : String(e)}`); }
        // A stuck delivery task cannot hand the line to the lead, so the owner hears it in the main channel. Not awaited:
        // a hung post must not stop this loop.
        const channel = deps.config.discordChannels[0];
        if (which === "delivery" && channel) {
          void discord.send(channel, scrubForThread(`Dori warning: ${line}`, homedir()), id)
            .catch((e: unknown) => { console.error(`TASK_STALLED_NOTIFY_FAILED ${which} ${e instanceof Error ? e.message : String(e)}`); });
        }
      }
      watchdog.progress();
      await watchdog.pet();
      await wait(5_000, halted);
    }
    stop.abort();
    await tasks;
    if (deliveryError) throw deliveryError;
  } finally {
    // A startup that failed or was stopped early still logs how far it got.
    if (probe.active) {
      probe.report(ready ? "first-pass-incomplete" : "startup-incomplete");
      probe.close();
    }
    if (petting !== undefined) clearInterval(petting);
    stop.abort();
    await tasks;
    await inbound?.close();
    if (inbound) writeGatewayStatus(deps.config.stateDir, { pid: process.pid, at: deps.clock.now(), connected: false, messageContent: false });
    reports?.close();
    sources?.close();
    scheduleOps?.close();
    ci?.close();
    releaseGateway?.();
    release?.();
  }
};
