#!/usr/bin/env bun
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { configPath, loadConfig } from "./config.ts";
import { envFilePath, resolveCredential } from "./credentials.ts";
import { resolveTarget } from "./messenger/target.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { callerLane, claimDone, closeLane, type FlowDeps, laneActRefusal, laneSendRefusal, objectDone, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { diskGuardPath, guardTick, sampleHost } from "./host-guard.ts";
import { adoptLane, doneRepos, type LaunchInput, launchLane, LaunchError, validateLaunch } from "./launch.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { Registry, statusOf } from "./registry.ts";
import { Repos, ReposError } from "./repos.ts";
import { realClock, run, setDefaultRunTimeout } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { canLaunch, dequeueLaunch, enqueueLaunch, journalQuotaBypass, launchGate, launchQueue, recordLaunchVerdict } from "./routing.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence, openDiscordGateway } from "./messenger/discord.ts";
import { acquireDiscordGateway, DiscordGatewayOwnedError } from "./messenger/discord-lock.ts";
import { DiscordCommands } from "./messenger/discord-commands.ts";
import { gateLine, launchQuotaHold, lookupQuotaResults, NO_CLAUDE, quotaReport, readGate } from "./claude-quota.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { supervise } from "./supervise-loop.ts";
import { lookupStatus } from "./status.ts";
import { Waits } from "./waits.ts";
import { LeadRestartError, requestLeadRestart } from "./lead-restart.ts";
import { approveEmergency, clearEmergencyApproval, emergencyApprovedAt } from "./emergency.ts";
import { recoverLanes } from "./recover.ts";
import { ack, AckError } from "./ack.ts";
import { checkMemory, MemoryCheckError, needsAction, renderMemoryReport } from "./memory-check.ts";
import { StoreError } from "./store.ts";
import { openOperations, operationLine, type OperationState, settleOperation } from "./operations.ts";
import { ackLaneMessage, LaneMessageError, openLaneMessages } from "./lane-messages.ts";
import { isReportKind, oneLine, openLaneReports, REPORT_KINDS, type ReportKind, UNFENCED_GENERATION } from "./lane-reports.ts";
import { publicSpec, queueEmit, readSourceStatus, SourceError, SourceSpecs, sourceViews } from "./event-sources.ts";
import { nextSlot, queueRunNow, SCHEDULE_ACTION, scheduleRow, type ScheduleSpec } from "./schedule.ts";
import { kst } from "./status.ts";

const USAGE = `dori <command> [options]

  doctor                                                         read-only health check: OK/WARN/FAIL with the exact fix; exit 1 on any FAIL
  status [--json | --page N]                                     one-screen summary: services, lead, lanes, waits, repos, gateway (also /status in Discord); --page N lists more lanes, --json every lane with its latest report
  setup  [--yes] [--token-file F] [--channel ID] [--autostart]   interactive install: token, channels, herdr, autostart (dori setup --help)
  quota [--json]                                                 Claude 5h/7d usage and the gate mode (ok, hold-lanes, brief, blocked); read before taking on work
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR] [--ignore-quota --reason TEXT]
                [--share-thread] [--allow-repo-mismatch]   refused when another open lane has the thread or the git checkout, or cwd's repo is not in Done
                HOLD (exit 4) on host limits or the quota gate queues the launch in launch-hold.json until it launches or is dropped
                [--machine LABEL-OR-ID] [--pane ID | --workspace ID]   target a saved machine; run in an existing idle shell pane instead of a new tab; cwd defaults to the pane's
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--cwd DIR] [--machine LABEL-OR-ID] [--share-thread] [--allow-repo-mismatch]   with --machine, --cwd is the remote directory
  hold list | hold drop <key>          the launches waiting after a HOLD (JSON), or drop one
  sync   [--write]                     registry vs live panes; read-only unless --write
  recover [key]                        recover missing or wrong-model working lane panes
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for $HERDR_PANE_ID
  object-done <key> --reason TEXT [--reason TEXT ...]
  ops [list] [--lane KEY] [--all] [--json]   operation rows: open, failed and ambiguous ones; --all adds verified
  ops resolve <id> --as verified|retry  the lead's answer for an ambiguous or failed operation after checking the world by hand
  close  <key> [--note TEXT] [--force] close now (Done signals must read back live; unpushed, uncommitted or untracked work refuses unless --force)
                                       inside a lane (DORI_LANE_KEY or its pane) claim-done/close/pause/resume act on its own key only, and send posts only to its own thread
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  watch                                long-running: emits LANE_* lines every 30 s
  supervise                            own inbound/sweeps and restart a cold idle lead
  lead-restart [--model ID] [--thinking LEVEL]   request a cold start at the next idle moment
  lead-emergency approve|revoke|status           the owner's approval for the lead's paid emergency models
  store import                         with the supervisor stopped: move supervisor.json into supervisor.sqlite (verified field by field),
                                       then set "store": "sqlite" in the config
  store export                         with the supervisor stopped: write supervisor.json, lead-events.log and github-events.json back
                                       from supervisor.sqlite (rollback), then set "store": "json" in the config
  wait <key> --until SIGNAL --note TEXT [--thread REF] [--every SEC] [--timeout MIN]
  wait --list | --cancel <key>          durable supervisor-owned follow-ups
  emit <KIND> --text T [--id ID]       journal one event (dedupe by --id); its class comes from eventPolicy
  source list [--json]                 event sources: built-ins and registered ones, with their last event and error
  source add <name> --type poll --command CMD --every SEC --match RE --kind KIND [--cwd DIR]
                                       CMD is a shell line, or a JSON argv array; each stdout line matching RE is one event
  source add <name> --type webhook --port P --kind KIND [--secret S]   POST to 127.0.0.1:P with X-Dori-Secret (secret printed once when generated)
  source add <name> --type file --path FILE --match RE --kind KIND     each new line of FILE matching RE is one event
  source remove <name>                 stop and forget a registered source
  schedule add <name> (--cron EXPR | --every SEC) (--text T | --command CMD [--cwd DIR] [--heavy] [--timeout SEC]) --kind KIND
               [--tz ZONE] [--catch-up once|skip]   a scheduled job: emit <KIND> T, or run CMD and emit its result;
                                       cron in ZONE (default Asia/Seoul); a missed slot runs once after downtime (or is skipped)
  schedule list [--json] | schedule remove <name> | schedule run-now <name>   jobs with their next and last run; run one now
  repos add/remove <owner/repo>        manage this machine's GitHub watched repos
  repos list                          print this machine's watched repos as JSON
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch [--model M]               exit 0 if the host and the Claude quota gate have room for a new lane, else print why and exit 4
  memory check                         read-only: the lead's human.md size vs memoryCheck.maxKb and Open items naming closed lanes
                                       or merged PRs; exit 1 when action is needed, 2 when it cannot check
  report <key> <progress|question|blocked|milestone|done> --text T [--evidence E]
                                       a lane's structured report (own key only): one row the supervisor routes
  report ack <id>                      inside a lane: confirm a supervisor message to this lane by its ID (CI follow-up)
  ack <channel> <messageId> [...]      the lead's read receipt (one <channel> <messageId> pair per message) on a Discord owner message: hourglass off, eyes on, ack recorded for the supervisor
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN)
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

if (process.argv[2] === "setup") {
  const { setupMain } = await import("./setup-cli.ts");
  process.exit(await setupMain(process.argv.slice(3)));
}

if (process.argv[2] === "doctor") process.exit(await (await import("./doctor.ts")).doctorMain());
if (process.argv[2] === "status") {
  const args = process.argv.slice(3);
  const json = args.length === 1 && args[0] === "--json";
  const paged = args.length === 2 && args[0] === "--page" && /^[1-9]\d*$/.test(args[1] ?? "");
  if (args.length && !json && !paged) { console.error("usage: dori status [--json | --page N]"); process.exit(1); }
  const page = paged ? Number(args[1]) : 1;
  const { collectStatus, statusPage } = await import("./status.ts");
  const cfg = await loadConfig();
  setDefaultRunTimeout(cfg.runTimeoutMs);
  const status = await collectStatus({ run, clock: realClock, config: cfg, registry: new Registry(cfg.stateDir) });
  console.log(json ? JSON.stringify(status, null, 2) : statusPage(status, page));
  process.exit(0);
}

const config = await loadConfig();
setDefaultRunTimeout(config.runTimeoutMs);
const archiveToken = resolveCredential("DORI_DISCORD_TOKEN");
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config, ...(archiveToken ? { discord: new Discord(fetchHttp, realClock, archiveToken) } : {}) };
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, thinking: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, workspace: { type: "string" }, machine: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" },
    until: { type: "string" }, every: { type: "string" }, timeout: { type: "string" },
    list: { type: "boolean" }, cancel: { type: "string" }, "ignore-quota": { type: "boolean" }, "share-thread": { type: "boolean" }, "allow-repo-mismatch": { type: "boolean" }, json: { type: "boolean" }, force: { type: "boolean" },
    lane: { type: "string" }, as: { type: "string" }, all: { type: "boolean" },
    type: { type: "string" }, command: { type: "string" }, match: { type: "string" }, kind: { type: "string" }, path: { type: "string" },
    port: { type: "string" }, secret: { type: "string" }, id: { type: "string" },
    cron: { type: "string" }, tz: { type: "string" }, "catch-up": { type: "string" }, heavy: { type: "boolean" },
  },
});
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
const key = flags.positionals[0];
const loopMin = Number(opt("loop") ?? 0);

/** `--command`: a JSON argv array, else a shell line run with `sh -c`. */
const commandArgv = (command: string | undefined): unknown => {
  if (!command) return die("--command is required");
  if (!command.startsWith("[")) return ["sh", "-c", command];
  try { return JSON.parse(command) as unknown; } catch { return die("--command starting with [ must be a JSON argv array"); }
};

/** Lane permission isolation: inside a lane, a lane command may name only that lane (and defaults to it); the lead may name any. */
const ownKey = async (command: string, k: string | undefined): Promise<string | undefined> => {
  const caller = await callerLane(deps);
  const refusal = k === undefined ? undefined : laneActRefusal(caller, command, k);
  return refusal ? die(refusal) : (k ?? caller);
};

/** Lead-only commands: a lane (DORI_LANE_KEY or its pane) may not run them. */
const LEAD_ONLY = new Set(["ack", "handled", "launch", "adopt", "hold", "lead-restart", "lead-emergency", "store", "ops", "source", "schedule"]);
if (LEAD_ONLY.has(command)) {
  const caller = await callerLane(deps);
  if (caller !== undefined) die(`LANE_PERMISSION_DENIED lane ${caller} may not run ${command}; it is lead-only`);
}

const lane = async (k: string | undefined) => {
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(process.env.HERDR_PANE_ID ?? "", opt("machine"));
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

try {
  switch (command) {
    case "recover": {
      if (flags.positionals.length > 1 || Object.keys(flags.values).length) die("usage: dori recover [key]");
      if (key && !(await deps.registry.read(key))) die(`no registered lane "${key}"`);
      for (const line of await recoverLanes(deps, key)) console.log(line);
      break;
    }
    case "lead-emergency": {
      const [action, ...extra] = flags.positionals;
      if (extra.length || Object.keys(flags.values).length || (action !== "approve" && action !== "revoke" && action !== "status")) {
        die("usage: dori lead-emergency approve|revoke|status");
      }
      if (action === "approve") {
        // The lead runs with DORI_SUPERVISED=1 in the lead pane: it may relay the owner's word, never approve for itself.
        if (process.env.DORI_SUPERVISED === "1" || (config.leadPane && process.env.HERDR_PANE_ID === config.leadPane)) {
          die("LEAD_EMERGENCY_REFUSED the lead may not approve its own paid emergency model; the owner approves with /emergency or from their own shell");
        }
        if (approveEmergency(config.stateDir, realClock.now()) === undefined) {
          die("LEAD_EMERGENCY_REFUSED no lead quota episode is open; an approval counts only for the outage it is given in");
        }
      }
      if (action === "revoke") clearEmergencyApproval(config.stateDir);
      const at = emergencyApprovedAt(config.stateDir);
      console.log(at === undefined ? "LEAD_EMERGENCY not approved" : `LEAD_EMERGENCY approved ${new Date(at).toISOString()}`);
      break;
    }
    case "store": {
      const [action, ...extra] = flags.positionals;
      if (extra.length || Object.keys(flags.values).length || (action !== "import" && action !== "export")) die("usage: dori store import|export");
      if (action === "export") {
        const { exportStore } = await import("./store-export.ts");
        const report = exportStore(config.stateDir, realClock.now());
        console.log(JSON.stringify(report, null, 2));
        console.log(`STORE_EXPORTED ${config.stateDir}; set "store": "json" in ${configPath()} before starting the supervisor`);
        break;
      }
      const { importStore } = await import("./store-import.ts");
      const report = importStore(config.stateDir, realClock.now());
      console.log(JSON.stringify(report, null, 2));
      console.log(`STORE_IMPORTED ${report.database}; set "store": "sqlite" in ${configPath()} before starting the supervisor`);
      break;
    }
    case "lead-restart": {
      if (flags.positionals.length || Object.keys(flags.values).some((name) => name !== "model" && name !== "thinking") ||
          ("model" in flags.values && !opt("model")) || ("thinking" in flags.values && !opt("thinking"))) {
        die("usage: dori lead-restart [--model ID] [--thinking LEVEL]");
      }
      const request = requestLeadRestart(config, realClock.now(), opt("model"), opt("thinking"));
      console.log(`LEAD_RESTART_REQUESTED ${request.id} ${request.models[0]?.model}`);
      break;
    }
    case "repos": {
      const [action, repo, ...extra] = flags.positionals;
      const repos = new Repos(config.stateDir);
      if (Object.keys(flags.values).length || extra.length ||
          (action === "list" ? repo !== undefined : !repo || (action !== "add" && action !== "remove"))) {
        die("usage: dori repos add/remove <owner/repo> | dori repos list");
      }
      switch (action) {
        case "add": repos.add(repo ?? die("repos add needs owner/repo")); break;
        case "remove": repos.remove(repo ?? die("repos remove needs owner/repo")); break;
        case "list": break;
        default: die("usage: dori repos add/remove <owner/repo> | dori repos list");
      }
      console.log(JSON.stringify(repos.list(), null, 2));
      break;
    }
    case "wait": {
      const waits = new Waits(config.stateDir);
      if (flags.values.list) {
        if (key || opt("cancel") || opt("until")) die("usage: dori wait --list");
        console.log(JSON.stringify(waits.list(), null, 2));
      } else if (opt("cancel")) {
        if (key || opt("until")) die("usage: dori wait --cancel <key>");
        const cancelled = need("cancel");
        if (!waits.cancel(cancelled)) die(`no wait "${cancelled}"`);
        console.log(`WAIT_CANCELLED ${cancelled}`);
      } else {
        const wait = waits.register({
          key: key ?? die("wait needs a key"), until: need("until"), note: need("note"),
          thread: opt("thread"), every: opt("every"), timeout: opt("timeout"), cwd: process.cwd(),
        }, realClock.now());
        console.log(`WAIT_REGISTERED ${wait.key}`);
      }
      break;
    }
    case "emit": {
      const kind = key;
      if (!kind || flags.positionals.length > 1 || Object.keys(flags.values).some((name) => name !== "text" && name !== "id")) die("usage: dori emit <KIND> --text T [--id ID]");
      const id = queueEmit(config.stateDir, kind ?? "", need("text"), realClock.now(), opt("id"));
      console.log(`EMIT_QUEUED ${id}`);
      break;
    }
    case "source": {
      const [action, name, ...extra] = flags.positionals;
      const specs = new SourceSpecs(config.stateDir);
      const usage = "usage: dori source list [--json] | dori source add <name> --type poll|webhook|file ... | dori source remove <name>";
      if (extra.length) die(usage);
      if (action === "list" && name === undefined) {
        const view = sourceViews(config.stateDir);
        const registered = new Map(specs.list().map((spec) => [spec.name, publicSpec(spec)]));
        const rows = view.sources.map((source) => ({ ...source, ...(registered.get(source.name) ?? {}) }));
        if (flags.values.json) console.log(JSON.stringify(rows, null, 2));
        else for (const row of rows) console.log(`${row.name} ${row.type}${row.kind ? ` ${row.kind}` : ""} events=${row.events ?? 0} duplicates=${row.duplicates ?? 0} last=${row.lastEventAt === undefined ? "never" : `${row.lastKind} ${new Date(row.lastEventAt).toISOString()}`}${row.failing ? ` FAILING ${row.lastError}` : ""}`);
        break;
      }
      if (action === "remove" && name) {
        if (!specs.remove(name)) die(`no source "${name}"`);
        console.log(`SOURCE_REMOVED ${name}`);
        break;
      }
      if (action !== "add" || !name) die(usage);
      const type = need("type");
      const command = opt("command");
      const generated = type === "webhook" && !opt("secret") ? randomBytes(24).toString("hex") : undefined;
      const spec = specs.add({
        name, type, kind: need("kind"),
        ...(type === "poll" ? {
          command: commandArgv(command),
          everySec: Number(need("every")), match: need("match"), ...(opt("cwd") ? { cwd: opt("cwd") } : {}),
        } : {}),
        ...(type === "webhook" ? { port: Number(need("port")), secret: generated ?? need("secret") } : {}),
        ...(type === "file" ? { path: need("path"), match: need("match") } : {}),
      });
      console.log(JSON.stringify(publicSpec(spec), null, 2));
      if (generated) console.log(`WEBHOOK_SECRET ${generated} (shown once; send it as X-Dori-Secret)`);
      console.log(`SOURCE_ADDED ${spec.name}`);
      break;
    }
    case "schedule": {
      const [action, name, ...extra] = flags.positionals;
      const specs = new SourceSpecs(config.stateDir);
      const usage = "usage: dori schedule list [--json] | dori schedule add <name> (--cron EXPR | --every SEC) (--text T | --command CMD [--cwd DIR] [--heavy] [--timeout SEC]) --kind KIND [--tz ZONE] [--catch-up once|skip] | dori schedule remove <name> | dori schedule run-now <name>";
      if (extra.length) die(usage);
      const now = realClock.now();
      const find = (job: string): ScheduleSpec => {
        const spec = specs.list().find((s) => s.name === job);
        return spec?.type === "schedule" ? spec : die(`no schedule "${job}"`);
      };
      const at = (ms: number | undefined): string => (ms === undefined ? "never" : `${kst(ms)} KST`);
      if (action === "list" && name === undefined) {
        const status = readSourceStatus(config.stateDir)?.sources ?? {};
        const rows = specs.list().filter((spec): spec is ScheduleSpec => spec.type === "schedule").map((spec) => scheduleRow(spec, status[spec.name], now));
        if (flags.values.json) console.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) console.log("SCHEDULES none");
        else for (const row of rows) console.log(`${row.name} ${row.kind} ${row.when}${row.heavy ? " heavy" : ""} catch-up=${row.catchUp} next=${row.waiting ? `waiting for a ${row.waiting}` : at(row.nextRunAt)} last=${at(row.lastRunAt)}${row.lastResult ? ` ${row.lastResult}` : ""}`);
        break;
      }
      if (action === "remove" && name) {
        find(name);
        specs.remove(name);
        console.log(`SCHEDULE_REMOVED ${name}`);
        break;
      }
      if (action === "run-now" && name) {
        find(name);
        queueRunNow(config.stateDir, name, now);
        console.log(`SCHEDULE_RUN_QUEUED ${name}; the supervisor runs it on its next pass`);
        break;
      }
      if (action !== "add" || !name) die(usage);
      const every = opt("every");
      const timeout = opt("timeout");
      const spec = specs.add({
        name, type: "schedule", kind: need("kind"), since: now,
        ...(opt("cron") ? { cron: opt("cron") } : {}), ...(every !== undefined ? { everySec: Number(every) } : {}),
        ...(opt("text") !== undefined ? { text: opt("text") } : {}),
        ...(opt("command") !== undefined ? { command: commandArgv(opt("command")) } : {}),
        ...(opt("cwd") ? { cwd: opt("cwd") } : {}), ...(flags.values.heavy ? { heavy: true } : {}),
        ...(timeout !== undefined ? { timeoutSec: Number(timeout) } : {}),
        ...(opt("tz") ? { tz: opt("tz") } : {}), ...(opt("catch-up") ? { catchUp: opt("catch-up") } : {}),
      });
      console.log(JSON.stringify(spec, null, 2));
      console.log(`SCHEDULE_ADDED ${spec.name} next ${at(spec.type === "schedule" ? nextSlot(spec, now) : undefined)}`);
      break;
    }
    case "supervise": {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try { await supervise(deps, controller.signal); }
      finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      break;
    }
    case "quota": {
      const read = await readGate(lookupQuotaResults(), config.quotaGate, config.stateDir, realClock.now(), AbortSignal.timeout(30_000));
      if (flags.values.json) console.log(JSON.stringify(read.claude ? { ...read.claude.verdict, usage: read.claude.usage } : { mode: "unknown" }, null, 2));
      else console.log(`${read.claude ? gateLine(read.claude.verdict) : NO_CLAUDE}\n\n${read.text}`);
      break;
    }
    case "launch": {
      const input: LaunchInput = { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), model: opt("model"), cwd: opt("cwd"), pane: opt("pane"), workspace: opt("workspace"), machine: opt("machine"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]) };
      const ignoreQuota = Boolean(flags.values["ignore-quota"]);
      const reason = ((flags.values.reason as string[] | undefined) ?? []).map((r) => r.trim()).filter(Boolean).join("; ");
      if (ignoreQuota && !reason) die("--ignore-quota needs --reason TEXT (why the Claude quota gate is bypassed; it is journaled and relayed to the owner)");
      await validateLaunch(deps, input);
      const quotaHold = await launchQuotaHold(config, lookupQuotaResults(), input.model ?? config.defaultModel, realClock.now(), (line) => console.error(line));
      const gate = launchGate({ key: input.key, sample: await sampleHost(run, diskGuardPath(config)), guard: config.guard, quotaHold, ignoreQuota, reason });
      if (gate.error) die(gate.error);
      for (const line of gate.lines) console.log(line);
      if (gate.hold) {
        const repos = doneRepos(input.done);
        const queue = enqueueLaunch(config.stateDir, {
          key: input.key, title: input.title, done: input.done, brief: input.brief, queuedAt: new Date().toISOString(), reasons: [gate.hold],
          ...(input.cwd ? { cwd: input.cwd } : {}), ...(repos.length ? { repos } : {}), ...(input.thread ? { thread: input.thread } : {}), ...(input.model ? { model: input.model } : {}),
          ...(input.machine ? { machine: input.machine } : {}), ...(input.pane ? { pane: input.pane } : {}), ...(input.workspace ? { workspace: input.workspace } : {}),
        });
        console.log(`HOLD ${gate.hold}`);
        console.log(`QUEUED ${input.key} (${queue.length} waiting; dori hold list)`);
        process.exit(4);
      }
      if (ignoreQuota) journalQuotaBypass(config.stateDir, { key: input.key, reason, ...(quotaHold ? { quotaHold } : {}), at: Date.now() });
      const r = await launchLane(deps, input);
      dequeueLaunch(config.stateDir, input.key);
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "hold": {
      const [action, dropKey, ...extra] = flags.positionals;
      if (Object.keys(flags.values).length || extra.length || (action === "list" ? dropKey !== undefined : action !== "drop" || !dropKey)) die("usage: dori hold list | dori hold drop <key>");
      if (action === "list") console.log(JSON.stringify(launchQueue(config.stateDir), null, 2));
      else if (dequeueLaunch(config.stateDir, dropKey ?? "")) console.log(`HOLD_DROPPED ${dropKey}`);
      else die(`no queued launch "${dropKey}"`);
      break;
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), pane: need("pane"), machine: opt("machine"), cwd: opt("cwd"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]) });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "claim-done":
      console.log(await claimDone(deps, await lane(await ownKey("claim-done", key)), need("evidence")));
      break;
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      console.log(await objectDone(deps, await lane(await ownKey("object-done", key ?? die("object-done needs a lane key"))), reasons));
      break;
    }
    case "ops": {
      const [action = "list", id, ...extra] = flags.positionals;
      const store = openOperations(config);
      try {
        if (action === "list" && id === undefined && !extra.length) {
          const states: OperationState[] | undefined = flags.values.all ? undefined : ["planned", "attempted", "failed", "ambiguous"];
          const ops = store.list({ ...(opt("lane") ? { lane: opt("lane") } : {}), ...(states ? { states } : {}) });
          if (flags.values.json) console.log(JSON.stringify(ops, null, 2));
          else console.log(ops.length ? ops.map(operationLine).join("\n") : "OPS none");
          break;
        }
        const as = opt("as");
        if (action !== "resolve" || !id || extra.length || (as !== "verified" && as !== "retry")) die("usage: dori ops [list] [--lane KEY] [--all] [--json] | dori ops resolve <id> --as verified|retry");
        const op = store.get(id ?? "");
        if (!op) die(`no operation "${id}"`);
        if (op?.state !== "ambiguous" && op?.state !== "failed") die(`operation ${id} is ${op?.state}; only an ambiguous or failed operation is resolved by hand`);
        const done = settleOperation(store, realClock.now(), id ?? "", as === "verified" ? "verified" : "planned",
          as === "verified" ? "resolved by the lead: the effect is in place" : "resolved by the lead: the effect did not happen; may retry");
        if (done) console.log(operationLine(done));
        console.log(op?.action === SCHEDULE_ACTION ? `OPS_RESOLVED ${id}${as === "retry" ? "; the supervisor runs it again on its next pass" : ""}`
          : `OPS_RESOLVED ${id}; run dori close ${op?.lane} to finish its close`);
      } finally { store.close(); }
      break;
    }
    case "close": {
      const r = await closeLane(deps, await lane(await ownKey("close", key ?? die("close needs a lane key"))), opt("note") ?? "closed by the lead", { force: Boolean(flags.values.force) });
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "pause":
    case "resume": {
      const act = command === "pause" ? pauseLane : resumeLane;
      const r = await act(deps, await lane(await ownKey(command, key ?? die(`${command} needs a lane key`))), opt("note") ?? `${command}d by the lead`);
      for (const line of r.lines) console.log(line);
      process.exit(r.code);
    }
    case "watch":
      console.log("LANE_WATCH_READY");
      for (;;) {
        for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`])) console.log(line);
        await Bun.sleep(30_000);
      }
    case "freshness":
      await every(loopMin, async () => {
        const reports = openLaneReports(deps.config);
        try {
          for (const a of await freshnessTick(deps, process.env.HOME ?? "", undefined, reports)) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
        } finally { reports.close(); }
      });
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      const paneState = newDeadPaneState();
      await every(loopMin, async () => {
        for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paneState, await deps.registry.open())) console.log(line);
      });
      break;
    }
    case "guard": {
      const state = { alerting: false };
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        for (const line of guardTick(await sampleHost(run, diskGuardPath(config)), config.guard, state)) console.log(line);
      });
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
      const load = async () => (await sampleHost(run, diskGuardPath(config))).load1;
      const slot = await acquireSlot({ dir: `${config.stateDir}/heavy`, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "can-launch": {
      const host = canLaunch(await sampleHost(run, diskGuardPath(config)), config.guard);
      const hold = await launchQuotaHold(config, lookupQuotaResults(), opt("model") ?? config.defaultModel, realClock.now(), (line) => console.error(line));
      const v = hold ? { ok: false, reasons: [...host.reasons, hold] } : host;
      recordLaunchVerdict(config.stateDir, v, Date.now());
      console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
      process.exit(v.ok ? 0 : 4);
    }
    case "memory": {
      if (key !== "check" || flags.positionals.length > 1 || Object.keys(flags.values).length) die("usage: dori memory check", 2);
      try {
        const report = await checkMemory(deps, process.env.HOME ?? "");
        console.log(renderMemoryReport(report));
        process.exit(needsAction(report) ? 1 : 0);
      } catch (e) {
        if (e instanceof MemoryCheckError) die(`MEMORY_CHECK_ERROR ${e.message}`, 2);
        throw e;
      }
    }
    case "ack": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { tasks: { type: "string" } } });
      // Each message is named explicitly as a <channel> <messageId> pair; --tasks applies to one message only.
      const pairs = parsed.positionals;
      if (!pairs.length || pairs.length % 2 || (pairs.length > 2 && parsed.values.tasks !== undefined)) {
        die("usage: dori ack <channel> <messageId> [<channel> <messageId> ...] [--tasks N, one message only]");
      }
      const tasks = parsed.values.tasks === undefined ? undefined : Number(parsed.values.tasks);
      const token = resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`);
      const discord = new Discord(fetchHttp, realClock, token);
      for (let i = 0; i < pairs.length; i += 2) {
        const [channel = "", message = ""] = [pairs[i], pairs[i + 1]];
        await ack(config.stateDir, discord, channel, message, realClock.now(), tasks);
        console.log(`ACKED ${channel} ${message}`);
      }
      break;
    }
    case "report": {
      const [action, id, ...extra] = flags.positionals;
      if (action !== "ack" || Object.keys(flags.values).length) {
        // `dori report <key> <kind> --text T [--evidence E]`: one row the supervisor routes.
        const kind = id;
        if (!action || !isReportKind(kind) || extra.length || Object.keys(flags.values).some((name) => name !== "text" && name !== "evidence")) {
          die(`usage: dori report <key> <${REPORT_KINDS.join("|")}> --text T [--evidence E] | dori report ack <id>`);
        }
        const text = oneLine(need("text"));
        const evidence = opt("evidence") ? oneLine(opt("evidence") ?? "") : undefined;
        const target = await lane(await ownKey("report", action));
        const reports = openLaneReports(config);
        try {
          const row = reports.append({ lane: target.key, generation: UNFENCED_GENERATION, kind: kind as ReportKind, text, ...(evidence ? { evidence } : {}), at: realClock.now() });
          console.log(`LANE_REPORTED ${row.id} ${row.kind}`);
        } finally { reports.close(); }
        break;
      }
      if (!id || extra.length) die("usage: dori report ack <id>");
      const me = await callerLane(deps);
      if (!me) die("dori report ack runs inside a lane (DORI_LANE_KEY or its pane): it confirms a message to that lane");
      const messages = openLaneMessages(config);
      try {
        const acked = ackLaneMessage(messages, me ?? "", id ?? "", realClock.now());
        console.log(`LANE_MESSAGE_ACKED ${acked.lane} ${acked.id}`);
      } finally { messages.close(); }
      break;
    }
    case "handled": {
      const { recordHandled } = await import("./ack.ts");
      const parsed = parseArgs({
        args: rest, allowPositionals: true,
        options: { lane: { type: "string", multiple: true }, reply: { type: "boolean" }, tasks: { type: "string" } },
      });
      const [channel, message, ...extra] = parsed.positionals;
      if (!channel || !message || extra.length) die("usage: dori handled <channel> <messageId> [--tasks N] [--lane key ...] [--reply]");
      for (const key of parsed.values.lane ?? []) {
        if (!(await deps.registry.read(key))) die(`no registered lane "${key}"`);
      }
      recordHandled(config.stateDir, channel ?? "", message ?? "", realClock.now(), {
        tasks: parsed.values.tasks === undefined ? undefined : Number(parsed.values.tasks),
        lanes: parsed.values.lane, reply: parsed.values.reply,
      });
      console.log(`HANDLED_LINKED ${channel} ${message}`);
      break;
    }
    case "send": {
      const platform = key ?? die("send needs slack, telegram or discord");
      const named = platform === "slack" || platform === "telegram" || platform === "discord" ? platform : die(`unknown platform ${platform}`);
      const { to, thread } = resolveTarget(named, need("to"), opt("thread"));
      const me = await callerLane(deps);
      const sendRefusal = laneSendRefusal(me, me ? await deps.registry.read(me) : null, named, { to, ...(thread ? { thread } : {}) });
      if (sendRefusal) die(sendRefusal);
      const text = need("text");
      const edit = opt("edit");
      const token = (name: string) => resolveCredential(name) ?? die(`${name} is not set in the environment or in ${envFilePath()}`);
      if (platform === "slack") {
        const slack = new Slack(fetchHttp, realClock, { token: token("DORI_SLACK_TOKEN"), cookie: resolveCredential("DORI_SLACK_COOKIE") }, undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
        if (edit) await slack.edit(to, edit, text);
        else console.log(`SENT ${(await slack.post(to, text, thread)).ts}`);
      } else if (platform === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
        const target = { chatId: to, ...(thread ? { threadId: Number(thread) } : {}) };
        if (edit) await tg.edit(target, Number(edit), text);
        else console.log(`SENT ${await tg.send(target, text)}`);
      } else if (platform === "discord") {
        const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
        if (edit) await dc.edit(to, edit, text);
        // Each dori send is its own message: without a unique id Discord would dedupe a repeat of the same text.
        else console.log(`SENT ${await dc.send(to, text, randomUUID())}`);
      }
      break;
    }
    case "presence": {
      if (key === "slack") {
        const auth = { token: resolveCredential("DORI_SLACK_TOKEN") ?? die(`DORI_SLACK_TOKEN is not set in the environment or in ${envFilePath()}`), cookie: resolveCredential("DORI_SLACK_COOKIE") ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
        const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
          const options: Bun.WebSocketOptions = { headers: { ...headers } };
          const ws = new WebSocket(url, options);
          return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
        }, auth);
        console.log("PRESENCE_READY slack");
        await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
      } else if (key === "discord") {
        const token = resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`);
        const release = acquireDiscordGateway(token);
        let presence: ReturnType<typeof discordPresence> | undefined;
        try {
          if (!config.discord) console.warn("PRESENCE_WARNING discord slash commands skipped: config.discord is missing; run dori setup");
          const commands = config.discord ? new DiscordCommands(fetchHttp, token, config.discord, quotaReport(lookupQuotaResults(), () => config.quotaGate, config.stateDir, realClock.now), undefined, config.discordChannels, lookupStatus(deps)) : undefined;
          await commands?.register();
          presence = discordPresence(openDiscordGateway, token, realTimers, commands ? (data) => commands.handle(data) : undefined);
          console.log("PRESENCE_READY discord");
          await new Promise<void>((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
          });
        } finally {
          presence?.close();
          await presence?.settled();
          release();
        }
      } else die("presence needs slack or discord");
      break;
    }
    case "inbound": {
      if (key !== "slack") die("inbound supports slack");
      const auth = { token: resolveCredential("DORI_SLACK_TOKEN") ?? die(`DORI_SLACK_TOKEN is not set in the environment or in ${envFilePath()}`), cookie: resolveCredential("DORI_SLACK_COOKIE") };
      const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
      const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
      const me = String((await slack.call("auth.test", {})).user_id ?? die("auth.test returned no user_id"));
      console.log("INBOUND_READY slack");
      await every(loopMin, async () => {
        for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me })) console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`);
      });
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof ReposError || e instanceof DiscordGatewayOwnedError || e instanceof AckError || e instanceof LeadRestartError || e instanceof StoreError || e instanceof LaneMessageError || e instanceof SourceError) die(e.message);
  throw e;
}
