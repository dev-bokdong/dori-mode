import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_EVENT_POLICY, type EventPolicy, resolveEventPolicy } from "./event-policy.ts";
import type { StoreKind } from "./store.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

/**
 * The Claude subscription gate, read before jobs, in percent headroom: quota left over time left until each window's
 * reset (100 is on pace), an account by its tightest window, summed over every Claude account. Under
 * `holdLanesHeadroomPct` new lanes are held (dori launch / can-launch print HOLD with the reset time); under
 * `briefHeadroomPct` the lead answers briefly or declines new work; at 0 (every account has a window used up) blocked.
 */
export type QuotaGate = {
  readonly holdLanesHeadroomPct: number;
  readonly briefHeadroomPct: number;
  /** Minutes between the supervisor's usage reads (cached for dori status). */
  readonly pollMin: number;
};

/** quotaGate keys of the fixed percent-used gate; a config that still has them loads, with one warning. */
export const REMOVED_QUOTA_KEYS = ["holdLanes5hPct", "holdLanes7dPct", "brief5hPct", "brief7dPct", "nearReset5hMin", "nearResetHoldLanes5hPct", "account"] as const;

/** `dori memory check` and the supervisor's daily memory sweep. Read-only: the memory repo is never written. */
export type MemoryCheckConfig = {
  /** The lead's omo memory repo (holds system/human.md); blank finds omo's repo for `defaultCwd` under ~/.omo/memory/agents. */
  readonly repo: string;
  /** human.md above this many KB (1024 bytes) needs condensing. */
  readonly maxKb: number;
};

/**
 * How events reach the lead (supervise-push.ts). `tail`: the lead's own tail monitor on lead-events.log (the default).
 * `shadow`: tail delivery, while the push step logs what it would do. `push`: the supervisor types a short `[dori]`
 * pointer into the lead pane and counts events as delivered only once the lead takes them (`dori inbox take`).
 */
export type DeliveryMode = "tail" | "shadow" | "push";
export const DELIVERY_MODES: readonly DeliveryMode[] = ["tail", "shadow", "push"];

export type PushConfig = {
  /** Untaken this long after a push: push again. */
  readonly ackSec: number;
  /** Pushes after the first before LEAD_PUSH_UNTAKEN; later pushes back off, doubling up to 10 min. */
  readonly retries: number;
  /** Idle lead: minutes untaken before a cold restart. Working lead: the one-tool-call restart clock. */
  readonly escalateMin: number;
  /** Longest pointer line typed into the lead pane. */
  readonly maxChars: number;
  /** After a push that did not visibly start a turn, the input line is checked again this many ms later. */
  readonly pasteCheckMs: number;
  /** Push into a working lead too (its pointer is queued into the running turn). */
  readonly toWorking: boolean;
  /** Default for `dori inbox take --max-bytes`. */
  readonly takeMaxBytes: number;
};

export type DeliveryConfig = {
  readonly mode: DeliveryMode;
  /** The startup prompt also arms the tail monitor; while on, only an unacked owner message escalates an idle lead. */
  readonly tailMonitor: boolean;
  /** Forced restarts and quota switches per rolling hour; past it, push mode refuses unread-driven restarts. */
  readonly restartMaxPerHour: number;
  readonly push: PushConfig;
};

/** delivery.push keys that were removed; a config that still has them loads, with one warning. */
export const REMOVED_PUSH_KEYS = ["debounceMs"] as const;

/** The supervisor's delivery tick: the push step runs at most once per tick. */
export const DELIVERY_TICK_SEC = 5;

/** Why `delivery` cannot run, or undefined when it can. */
export const deliveryConfigError = (delivery: DeliveryConfig): string | undefined => {
  const { push } = delivery;
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (!DELIVERY_MODES.includes(delivery.mode)) return `delivery.mode must be one of ${DELIVERY_MODES.join(", ")}`;
  if (typeof delivery.tailMonitor !== "boolean") return "delivery.tailMonitor must be true or false";
  if (!Number.isInteger(delivery.restartMaxPerHour) || delivery.restartMaxPerHour < 1) return "delivery.restartMaxPerHour must be an integer of at least 1";
  if (!Number.isFinite(push.ackSec) || push.ackSec < 2 * DELIVERY_TICK_SEC) return `delivery.push.ackSec must be at least ${2 * DELIVERY_TICK_SEC} (twice the delivery tick)`;
  if (!Number.isInteger(push.retries) || push.retries < 0) return "delivery.push.retries must be a non-negative integer";
  if (!positive(push.escalateMin)) return "delivery.push.escalateMin must be positive";
  if (push.escalateMin * 60 <= push.ackSec * (push.retries + 1)) {
    return "delivery.push.escalateMin * 60 must exceed ackSec * (retries + 1), so every re-push happens before an escalation";
  }
  if (!Number.isInteger(push.maxChars) || push.maxChars < MIN_POINTER_CHARS || push.maxChars > MAX_POINTER_CHARS) {
    return `delivery.push.maxChars must be an integer from ${MIN_POINTER_CHARS} to ${MAX_POINTER_CHARS}`;
  }
  if (!Number.isFinite(push.pasteCheckMs) || push.pasteCheckMs < 0) return "delivery.push.pasteCheckMs must be zero or positive";
  if (typeof push.toWorking !== "boolean") return "delivery.push.toWorking must be true or false";
  if (!Number.isInteger(push.takeMaxBytes) || push.takeMaxBytes < 1) return "delivery.push.takeMaxBytes must be a positive integer";
  return undefined;
};

/** The shortest pointer (kinds cut to `+N more`) fits in MIN_POINTER_CHARS; omo kept 800 typed chars in one input. */
export const MIN_POINTER_CHARS = 140;
export const MAX_POINTER_CHARS = 800;

export type DiscordConfig = {
  readonly applicationId: string;
  readonly guildId: string;
  readonly ownerId: string;
};

export type DoriConfig = {
  readonly discord?: DiscordConfig;
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  /**
   * Model for the lead session only; absent or blank means `defaultModel`. Lanes never read it. An array is an ordered
   * fallback chain: the supervisor moves the lead to the next entry while the current one is blocked on quota.
   */
  readonly leadModel?: string | readonly LeadModelEntry[];
  /**
   * Paid emergency models for the lead only, tried in order after the `leadModel` chain when the subscription is
   * blocked. Lanes never run on them: launch refuses these models.
   */
  readonly leadEmergencyModels: readonly LeadModelEntry[];
  readonly quotaGate: QuotaGate;
  /** Minutes between checks of the first lead model while the lead runs on a fallback. */
  readonly leadPrimaryRetryMin: number;
  /** Prints a provider's accounts as JSON ({accounts: [{name, blocked}]}); `{provider}` is filled. Never add --credentials. */
  readonly quotaCheck: ArgvTemplate;
  /** `--thinking` level for the lead session only; absent or blank keeps whatever `agentCommand` carries. */
  readonly leadThinking?: string;
  /** Extra argv for the lead session only (after the executable), e.g. ["--approve"]. */
  readonly leadArgs: ArgvTemplate;
  readonly cacheTtlMin: number;
  readonly leadContextCapTokens: number;
  readonly leadContextHardCapTokens: number;
  readonly discordChannels: readonly string[];
  readonly discordSafetyPollSeconds: number;
  /** Messages fetched (one REST page, 1-100) the first time a Discord channel is caught up with no saved cursor. */
  readonly discordFirstSeenLimit: number;
  readonly githubPollSeconds: number;
  readonly githubTimeoutMs: number;
  /** GitHub logins whose new or reopened issues wake the lead as GH_ISSUE; anyone else is digest only. */
  readonly githubIssueAuthors: readonly string[];
  readonly launchKeywords: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  /** Only worktrees under this directory are removed by the closed-lane cleanup sweep; empty turns the sweep off. */
  readonly worktreeRoot: string;
  /** The thread line posted for a working lane's todo item; `{todo}` and `{elapsed}` are filled in. */
  readonly progressTemplate: string;
  /** Digest events wait for an urgent one, but never longer than this. */
  readonly digestMaxDelayMin: number;
  /** Posted once in the owner's channel or thread when the lead has not received their message within a minute. */
  readonly ownerDelayNotice: string;
  /** Seconds the lead has to ack (`dori ack`) an owner message it was handed before ACK_MISSING; twice this posts `ackMissingNotice`. */
  readonly ackTimeoutSec: number;
  /** Posted once in the owner's channel or thread when the lead got their message but has not acked it after two windows. */
  readonly ackMissingNotice: string;
  /** Minutes after reading an owner message to link all tasks with dori handled; a second window notifies the owner. */
  readonly handledTimeoutMin: number;
  readonly unhandledNotice: string;
  /** Minutes after a lane finished (LANE_CLOSED, CI_MERGED) for the lead to tell the owner and run dori reported before UNREPORTED. */
  readonly reportTimeoutMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly memoryCheck: MemoryCheckConfig;
  readonly hooks: Hooks;
  /** Default limit in ms for every external call (herdr, git, df, ...) that sets none itself; 0 turns it off. */
  readonly runTimeoutMs: number;
  /** The path whose filesystem the disk guard checks; blank means `stateDir`. */
  readonly diskGuardPath: string;
  /** A wait without --timeout whose check errors or times out this many times in a row ends as WAIT_FAILED. */
  readonly waitMaxFailures: number;
  /** Minutes a working lead may stay quota-stalled (with a fallback model left) before it is switched anyway. */
  readonly leadQuotaBusySwitchMin: number;
  /** Consecutive leadPrimaryRetryMin checks the first lead model must be unblocked on before the lead moves back to it. */
  readonly leadPrimaryReturnChecks: number;
  /** Minutes a working/blocked lead may leave owner messages unread before it is cold-restarted with them; 0 turns it off. */
  readonly leadStuckRestartMin: number;
  /**
   * Minutes an owner message may stay unacked while the lead sits inside one tool call, or idle (an Esc-paused session
   * holds its monitor events), before the lead is cold-restarted with it. Must be positive.
   */
  readonly leadUnreadRestartMin: number;
  /** Per machine, no herdr call of a sweep round starts later than this many ms after the round began. */
  readonly sweepMachineDeadlineMs: number;
  /** Where the supervisor journal lives: "json" (supervisor.json) or "sqlite" (supervisor.sqlite, after `dori store import`). */
  readonly store: StoreKind;
  /** How each event kind is delivered (event-policy.ts); a config's `kinds` are laid over the default table. */
  readonly eventPolicy: EventPolicy;
  /** Minutes a lane message may stay unconfirmed (queued or delivered without an ack) before the lead hears of it. */
  readonly ciConfirmMin: number;
  /** The only base branch the supervisor merges lane PRs into; `main` is refused whatever this says. */
  readonly ciMergeBase: string;
  /** How events reach the lead: tail monitor (default), shadow, or pushed pointers with take receipts. */
  readonly delivery: DeliveryConfig;
};

/** One lead model: "provider/model", or an object whose `thinking` replaces `leadThinking` for this model only. */
export type LeadModelEntry = string | { readonly model: string; readonly thinking?: string };

export type LeadModel = { readonly model: string; readonly thinking?: string; readonly emergency?: true };

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic-subscription/claude-opus-5-5",
  leadArgs: [],
  leadEmergencyModels: [],
  quotaGate: { holdLanesHeadroomPct: 50, briefHeadroomPct: 25, pollMin: 5 },
  leadPrimaryRetryMin: 15,
  quotaCheck: ["omo", "auth", "check", "--provider", "{provider}", "--json", "--no-refresh"],
  cacheTtlMin: 5,
  leadContextCapTokens: 150_000,
  leadContextHardCapTokens: 300_000,
  discordChannels: [],
  discordSafetyPollSeconds: 300,
  discordFirstSeenLimit: 100,
  githubPollSeconds: 90,
  githubTimeoutMs: 30_000,
  githubIssueAuthors: [],
  launchKeywords: "ulw set goal and work",
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  worktreeRoot: "/data/repos/worktrees",
  progressTemplate: "{todo}",
  digestMaxDelayMin: 60,
  ownerDelayNotice: "Got your message. The lead session is not taking it yet; it stays queued and will be answered as soon as the lead is back.",
  ackTimeoutSec: 60,
  ackMissingNotice: "Your message reached the lead session, but it has not confirmed reading it yet. It has been reminded and will answer here.",
  handledTimeoutMin: 30,
  unhandledNotice: "Your message was read, but not all of its tasks have been linked to work or a reply. The lead has been reminded to handle it.",
  reportTimeoutMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  memoryCheck: { repo: "", maxKb: 15 },
  hooks: {},
  runTimeoutMs: 60_000,
  diskGuardPath: "",
  waitMaxFailures: 30,
  leadQuotaBusySwitchMin: 10,
  leadPrimaryReturnChecks: 2,
  leadStuckRestartMin: 30,
  leadUnreadRestartMin: 5,
  sweepMachineDeadlineMs: 20_000,
  store: "json",
  eventPolicy: DEFAULT_EVENT_POLICY,
  ciConfirmMin: 20,
  ciMergeBase: "dev",
  delivery: {
    mode: "tail", tailMonitor: true, restartMaxPerHour: 3,
    push: { ackSec: 45, retries: 2, escalateMin: 5, maxChars: 200, pasteCheckMs: 3_000, toWorking: false, takeMaxBytes: 16_384 },
  },
});

/**
 * Removed feature flags: their behavior is always on. A config that still carries one loads fine; the key
 * is dropped and named in one warning per process.
 */
export const REMOVED_FLAGS = [
  "sweepSnapshot", "sweepTask", "superviseTasks", "operations", "threadArchive", "ciFollowUp", "toodoReconcile",
  "claimDelivery", "branchCleanup", "eventSources", "schedules", "laneReports",
] as const;

let warnedRemovedFlags = false;
let warnedRemovedQuotaKeys = false;
let warnedRemovedPushKeys = false;

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const loaded = (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : {};
  const leftover = REMOVED_FLAGS.filter((key) => key in loaded);
  if (leftover.length && !warnedRemovedFlags) {
    warnedRemovedFlags = true;
    console.error(`CONFIG_FLAGS_REMOVED ${leftover.join(", ")} in ${path}: these flags were removed and their behavior is always on; the keys are ignored and can be deleted`);
  }
  const raw = Object.fromEntries(Object.entries(loaded).filter(([key]) => !(REMOVED_FLAGS as readonly string[]).includes(key))) as Partial<DoriConfig>;
  const rawGate = (raw.quotaGate ?? {}) as Record<string, unknown>;
  const oldGate = REMOVED_QUOTA_KEYS.filter((key) => key in rawGate);
  if (oldGate.length && !warnedRemovedQuotaKeys) {
    warnedRemovedQuotaKeys = true;
    console.error(`CONFIG_QUOTA_KEYS_REMOVED quotaGate.${oldGate.join(", quotaGate.")} in ${path}: the Claude gate now compares quota left with time left across every account (quotaGate.holdLanesHeadroomPct, briefHeadroomPct); the keys are ignored and can be deleted`);
  }
  const quotaGate = Object.fromEntries(Object.entries(rawGate).filter(([key]) => !(REMOVED_QUOTA_KEYS as readonly string[]).includes(key))) as Partial<QuotaGate>;
  const rawDelivery = (raw.delivery ?? {}) as Partial<DeliveryConfig>;
  const rawPush = (rawDelivery.push ?? {}) as Record<string, unknown>;
  const oldPush = REMOVED_PUSH_KEYS.filter((key) => key in rawPush);
  if (oldPush.length && !warnedRemovedPushKeys) {
    warnedRemovedPushKeys = true;
    console.error(`CONFIG_PUSH_KEYS_REMOVED delivery.push.${oldPush.join(", delivery.push.")} in ${path}: a burst becomes one push through the single outstanding push; the keys are ignored and can be deleted`);
  }
  const push = Object.fromEntries(Object.entries(rawPush).filter(([key]) => !(REMOVED_PUSH_KEYS as readonly string[]).includes(key))) as Partial<PushConfig>;
  const delivery: DeliveryConfig = { ...base.delivery, ...rawDelivery, push: { ...base.delivery.push, ...push } };
  const merged: DoriConfig = { ...base, ...raw, guard: { ...base.guard, ...raw.guard }, quotaGate: { ...base.quotaGate, ...quotaGate }, memoryCheck: { ...base.memoryCheck, ...raw.memoryCheck }, hooks: { ...base.hooks, ...raw.hooks }, delivery };
  return {
    ...merged,
    eventPolicy: resolveEventPolicy(raw.eventPolicy),
    memoryCheck: { ...merged.memoryCheck, repo: expandHome(merged.memoryCheck.repo, home) },
    stateDir: expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env.DORI_LEAD_PANE ?? merged.leadPane,
  };
};

/**
 * Persist a recreated lead pane into the config file that was loaded. Every other key is kept as
 * written, the file mode is preserved, and the rename happens only after the new bytes are on disk.
 * A missing file is left alone: nothing was loaded from it.
 */
export const saveLeadPane = (path: string, leadPane: string): boolean => {
  let real: string;
  try { real = realpathSync(path); } catch { return false; }
  const raw: unknown = JSON.parse(readFileSync(real, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError(`${path} is not a JSON object`);
  const mode = statSync(real).mode & 0o777;
  const tmp = `${real}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeFileSync(fd, `${JSON.stringify({ ...raw, leadPane }, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, real);
  return true;
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));

/**
 * The lead's model chain, first entry first. A string entry uses `leadThinking`; an object entry's own `thinking` wins.
 * Blank or malformed entries are skipped; nothing usable means one entry, `defaultModel`.
 */
export const leadModels = (config: DoriConfig): LeadModel[] => {
  const shared = config.leadThinking?.trim() || undefined;
  const raw: readonly unknown[] = Array.isArray(config.leadModel) ? config.leadModel : [config.leadModel];
  const chain = modelEntries(raw, shared);
  return chain.length ? chain : [{ model: config.defaultModel, ...(shared ? { thinking: shared } : {}) }];
};

/** The model id without a `:thinking` suffix, for comparing selectors. */
const bareModel = (model: string): string => model.trim().replace(/:[a-z]+$/i, "");

/** The configured `leadEmergencyModels`, flagged; malformed entries are skipped. */
export const emergencyModels = (config: DoriConfig): LeadModel[] =>
  modelEntries(Array.isArray(config.leadEmergencyModels) ? config.leadEmergencyModels : [], config.leadThinking?.trim() || undefined)
    .map((m) => ({ ...m, emergency: true as const }));

/** True when `model` is one of the lead-only emergency models (thinking suffix ignored). */
export const isEmergencyModel = (config: DoriConfig, model: string): boolean =>
  emergencyModels(config).some((m) => bareModel(m.model) === bareModel(model));

/**
 * The lead's full chain: `leadModels`, then the emergency models not already in it. The supervisor moves along this
 * chain only while the current entry is blocked on quota, and back to the first once that has quota again.
 */
export const leadChain = (config: DoriConfig): LeadModel[] => {
  const chain = leadModels(config);
  const seen = new Set(chain.map((m) => bareModel(m.model)));
  return [...chain, ...emergencyModels(config).filter((m) => !seen.has(bareModel(m.model)))];
};

const modelEntries = (raw: readonly unknown[], shared: string | undefined): LeadModel[] =>
  raw.flatMap((entry): LeadModel[] => {
    if (typeof entry === "string") return entry.trim() ? [{ model: entry.trim(), ...(shared ? { thinking: shared } : {}) }] : [];
    if (typeof entry !== "object" || entry === null || !("model" in entry) || typeof entry.model !== "string" || !entry.model.trim()) return [];
    const own = "thinking" in entry && typeof entry.thinking === "string" ? entry.thinking.trim() : "";
    const thinking = own || shared;
    return [{ model: entry.model.trim(), ...(thinking ? { thinking } : {}) }];
  });

/** The provider part of "provider/model", or undefined for a bare model name. */
export const providerOf = (model: string): string | undefined => {
  const at = model.indexOf("/");
  return at > 0 ? model.slice(0, at) : undefined;
};

/**
 * The lead's agent argv: `agentCommand` filled with entry `index` of `leadChain` (clamped to the chain). Its thinking
 * level replaces the template's `--thinking` value, or is inserted right after the `--model` pair when the template has
 * none. Lanes keep `agentCommand` and `defaultModel` untouched.
 */
export const leadCommand = (config: DoriConfig, prompt: string, index = 0): string[] => {
  const template = config.agentCommand;
  const chain = leadChain(config);
  const lead = chain[Math.min(Math.max(index, 0), chain.length - 1)] ?? { model: config.defaultModel };
  const argv = fill(template, { model: lead.model, prompt });
  const thinking = lead.thinking;
  if (!thinking) return argv;
  // fill maps element by element, so template indices are argv indices.
  const at = template.findIndex((part) => part === "--thinking" || part.startsWith("--thinking="));
  if (at >= 0) {
    if (template[at] === "--thinking") argv.splice(at + 1, 1, thinking);
    else argv[at] = `--thinking=${thinking}`;
    return argv;
  }
  const model = template.findIndex((part) => part === "--model" || part.startsWith("--model="));
  argv.splice(model < 0 ? 1 : template[model] === "--model" ? model + 2 : model + 1, 0, "--thinking", thinking);
  return argv;
};
