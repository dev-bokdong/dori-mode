import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { leadChain, type DoriConfig, type QuotaGate } from "./config.ts";
import type { Clock } from "./run.ts";

/** The subset of pi-quota's ProviderResult this module reads. */
export type QuotaResult = {
  readonly kind: string;
  readonly provider: string;
  readonly account?: string;
  readonly windows?: readonly { readonly label: string; readonly remainingPercent: number; readonly resetAt?: Date | string }[];
};

/** Percent used (0-100) and the reset time (epoch ms) of one Claude window. */
export type ClaudeWindow = { readonly usedPct: number; readonly resetAt?: number };

/** One Claude account's windows; absent windows were not reported. */
export type ClaudeAccount = { readonly name: string; readonly fiveHour?: ClaudeWindow; readonly weekly?: ClaudeWindow };

/** Claude subscription usage of every account that answered (see claudeUsage). */
export type ClaudeUsage = { readonly at: number; readonly accounts: readonly ClaudeAccount[] };

/** ok: work as usual. hold-lanes: no new lanes. brief: the lead also answers briefly or declines. blocked: every account has a window used up. */
export type GateMode = "ok" | "hold-lanes" | "brief" | "blocked";

/** One window's pace: quota left against time left until its reset, both in percent of the window. */
export type WindowHeadroom = {
  readonly window: "5h" | "7d";
  readonly leftPct: number;
  /** Percent of the window's length still to run; absent when the reset time is unknown (counted as 100%). */
  readonly timeLeftPct?: number;
  /** leftPct / timeLeftPct in whole percent (what the gate decides on), capped at MAX_HEADROOM_PCT: 100 is on pace. */
  readonly headroomPct: number;
  readonly resetAt?: number;
};

/** One account's headroom: its tightest window, since that window stops the account first. */
export type AccountHeadroom = { readonly name: string; readonly headroomPct: number; readonly windows: readonly WindowHeadroom[] };

export type GateVerdict = {
  readonly mode: GateMode;
  /** Why the gate is not ok, e.g. "Claude headroom 30% < 50% (default 10% by 5h, login-2 20% by 7d)". */
  readonly reasons: readonly string[];
  /** When the gate clears (epoch ms), if known: the first account whose windows under the hold line have all reset. */
  readonly resetAt?: number;
  /** New lanes wait: every mode but ok. */
  readonly holdsLanes: boolean;
  /** The sum of every account's headroom, in percent of one account on pace. */
  readonly headroomPct: number;
  readonly holdLanesPct: number;
  readonly briefPct: number;
  readonly accounts: readonly AccountHeadroom[];
};

const CLAUDE_PROVIDERS = new Set(["anthropic", "claude-sdk-oauth"]);

const windowOf = (w: NonNullable<QuotaResult["windows"]>[number]): ClaudeWindow => {
  const usedPct = Math.round(Math.min(100, Math.max(0, 100 - (Number.isFinite(w.remainingPercent) ? w.remainingPercent : 0))));
  const reset = w.resetAt === undefined ? NaN : new Date(w.resetAt).getTime();
  return { usedPct, ...(Number.isFinite(reset) ? { resetAt: reset } : {}) };
};

const FIVE_HOUR = /five|5\s*h/i;
const WEEKLY = /week|7\s*d/i;

/** Labels of successful Claude accounts none of whose windows is a recognised 5h/7d window (pi-quota renamed them). */
export const unrecognizedClaudeLabels = (results: readonly QuotaResult[]): string[] =>
  results.filter((r) => r.kind === "success" && CLAUDE_PROVIDERS.has(r.provider) && !(r.windows ?? []).some((w) => FIVE_HOUR.test(w.label) || WEEKLY.test(w.label)))
    .flatMap((r) => (r.windows ?? []).map((w) => w.label));

/**
 * Claude usage from pi-quota results: every anthropic or claude-sdk-oauth account that answered with a 5h or 7d
 * window, since omo may put a lane on any of them. Undefined when no Claude account answered.
 */
export const claudeUsage = (results: readonly QuotaResult[], at: number): ClaudeUsage | undefined => {
  const accounts: ClaudeAccount[] = [];
  for (const r of results) {
    if (r.kind !== "success" || !CLAUDE_PROVIDERS.has(r.provider)) continue;
    let fiveHour: ClaudeWindow | undefined;
    let weekly: ClaudeWindow | undefined;
    for (const w of r.windows ?? []) {
      if (FIVE_HOUR.test(w.label)) fiveHour = windowOf(w);
      else if (WEEKLY.test(w.label) && !weekly) weekly = windowOf(w);
    }
    if (!fiveHour && !weekly) continue;
    accounts.push({ name: r.account || r.provider, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) });
  }
  return accounts.length ? { at, accounts } : undefined;
};

const WINDOW_MS = { "5h": 5 * 3_600_000, "7d": 7 * 86_400_000 } as const;
/** One window's headroom never counts above this (a window about to reset with quota left). */
export const MAX_HEADROOM_PCT = 1000;

const windowHeadroom = (window: "5h" | "7d", w: ClaudeWindow, at: number): WindowHeadroom => {
  const left = (100 - w.usedPct) / 100;
  // A reset already past counts as no time left: the window is fresh by now. An unknown reset counts as a full window.
  const time = w.resetAt === undefined ? 1 : Math.min(1, Math.max(0, (w.resetAt - at) / WINDOW_MS[window]));
  const ratio = left <= 0 ? 0 : left >= time * (MAX_HEADROOM_PCT / 100) ? MAX_HEADROOM_PCT / 100 : left / time;
  return {
    window, leftPct: 100 - w.usedPct, ...(w.resetAt !== undefined ? { timeLeftPct: Math.round(time * 100) } : {}),
    headroomPct: Math.round(ratio * 100), ...(w.resetAt !== undefined ? { resetAt: w.resetAt } : {}),
  };
};

const pctText = (n: number): string => `${Math.round(n)}%`;

/**
 * The gate for this usage. Each window's headroom is its quota left over its time left (20% left with 20% of the
 * window to run is 100%, on pace); an account counts by its tightest window, and the accounts add up. blocked at 0
 * (every account has a window used up), brief under `briefHeadroomPct`, hold-lanes under `holdLanesHeadroomPct`.
 */
export const gateVerdict = (usage: ClaudeUsage, gate: QuotaGate): GateVerdict => {
  const accounts: AccountHeadroom[] = usage.accounts.map((a) => {
    const windows = [
      ...(a.fiveHour ? [windowHeadroom("5h", a.fiveHour, usage.at)] : []),
      ...(a.weekly ? [windowHeadroom("7d", a.weekly, usage.at)] : []),
    ];
    return { name: a.name, headroomPct: Math.min(...windows.map((w) => w.headroomPct)), windows };
  });
  const headroomPct = accounts.reduce((sum, a) => sum + a.headroomPct, 0);
  const mode: GateMode = headroomPct <= 0 ? "blocked" : headroomPct < gate.briefHeadroomPct ? "brief" : headroomPct < gate.holdLanesHeadroomPct ? "hold-lanes" : "ok";
  let resetAt: number | undefined;
  const reasons: string[] = [];
  if (mode !== "ok") {
    const tight = (a: AccountHeadroom) => a.windows.filter((w) => w.headroomPct < gate.holdLanesHeadroomPct);
    const by = accounts.map((a) => `${a.name} ${pctText(a.headroomPct)} by ${tight(a).map((w) => w.window).join("+")}`).join(", ");
    reasons.push(mode === "blocked" ? `every Claude account has a window used up (${by})` : `Claude headroom ${pctText(headroomPct)} < ${mode === "brief" ? gate.briefHeadroomPct : gate.holdLanesHeadroomPct}% (${by})`);
    for (const a of accounts) {
      const resets = tight(a).map((w) => w.resetAt);
      if (resets.every((r) => r !== undefined)) resetAt = Math.min(resetAt ?? Infinity, Math.max(...resets as number[]));
    }
  }
  return {
    mode, reasons, ...(resetAt !== undefined ? { resetAt } : {}), holdsLanes: mode !== "ok",
    headroomPct, holdLanesPct: gate.holdLanesHeadroomPct, briefPct: gate.briefHeadroomPct, accounts,
  };
};

/** "headroom 315% (hold-lanes < 50%, brief < 25%)". */
export const headroomNote = (v: GateVerdict): string =>
  `headroom ${pctText(v.headroomPct)} (hold-lanes < ${v.holdLanesPct}%, brief < ${v.briefPct}%)`;

/** Models that spend the Claude subscription, so the gate applies to them; other providers (GPT, emergency) are not gated. */
export const usesClaudeSubscription = (model: string): boolean =>
  /^(?:anthropic-subscription|anthropic|claude-sdk-oauth)\//.test(model) || /^claude-/.test(model);

const KST_MS = 9 * 3_600_000;
const two = (n: number): string => String(n).padStart(2, "0");
/** "MM-DD HH:MM" in KST, the owner's time zone. */
export const kst = (ms: number): string => {
  const d = new Date(ms + KST_MS);
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

/** "5h 18% left / 7% time = 245% (resets 10-23 17:09 KST)". */
const windowText = (w: WindowHeadroom): string =>
  `${w.window} ${w.leftPct}% left / ${w.timeLeftPct ?? "?"}% time = ${pctText(w.headroomPct)}${w.resetAt !== undefined ? ` (resets ${kst(w.resetAt)} KST)` : ""}`;

/** "default 245%: 5h 18% left / 7% time = 245% (resets ...), 7d ...". */
export const accountText = (a: AccountHeadroom): string => `${a.name} ${pctText(a.headroomPct)}: ${a.windows.map(windowText).join(", ")}`;

/**
 * One line: "QUOTA ok | Claude headroom 315% (hold-lanes < 50%, brief < 25%) | default 245%: 5h ... | login-2 70%: ...",
 * with the time the gate clears when it is not ok.
 */
export const gateLine = (v: GateVerdict): string =>
  `QUOTA ${v.mode} | Claude ${headroomNote(v)}${v.mode !== "ok" && v.resetAt !== undefined ? `; clears ${kst(v.resetAt)} KST` : ""} | ${v.accounts.map(accountText).join(" | ")}`;

/** The HOLD reason a launch prints, e.g. "Claude headroom 30% < 50% (default 10% by 5h), resets 10-22 15:10 KST". */
export const holdReason = (v: GateVerdict): string =>
  `${v.reasons.join(", ")}${v.resetAt !== undefined ? `, resets ${kst(v.resetAt)} KST` : ""}`;

/** What the supervisor last read, kept in `<stateDir>/claude-quota.json` for status and LAUNCH_READY. */
export type QuotaState = {
  readonly usage: ClaudeUsage;
  readonly mode: GateMode;
  /** Whether new lanes wait (absent in files written before it: every mode but ok holds). */
  readonly holdsLanes?: boolean;
};

/** Whether a cached state holds new lanes. */
export const stateHoldsLanes = (s: QuotaState): boolean => s.holdsLanes ?? s.mode !== "ok";

const stateFile = (stateDir: string): string => join(stateDir, "claude-quota.json");

export const readQuotaState = (stateDir: string): QuotaState | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile(stateDir), "utf8"));
    // A file from before the headroom gate (one account's windows, no `accounts`) is ignored until the next read.
    if (typeof raw !== "object" || raw === null || !("usage" in raw) || !("mode" in raw)) return undefined;
    const usage: unknown = raw.usage;
    if (typeof usage !== "object" || usage === null || !("accounts" in usage) || !Array.isArray(usage.accounts)) return undefined;
    return raw as QuotaState;
  } catch { return undefined; }
};

export const writeQuotaState = (stateDir: string, state: QuotaState): void => {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${stateFile(stateDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, stateFile(stateDir));
};

/** A Claude usage read: pi-quota's results plus its formatted text. */
export type UsageLookup = (signal: AbortSignal) => Promise<{ readonly results: readonly QuotaResult[]; readonly text: string }>;

/** pi-quota through senpi's native auth storage (omo's accounts, no session or model turn). */
export const lookupQuotaResults = (agentDir = join(homedir(), ".omo", "agent")): UsageLookup => async (signal) => {
  const { ModelRuntime, ModelRegistry } = await import("@code-yeongyu/senpi");
  const { lookupQuota } = await import("pi-quota");
  signal.throwIfAborted();
  const runtime = await ModelRuntime.create({
    agentDir,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    signal,
  });
  return lookupQuota(new ModelRegistry(runtime, runtime.authStorage), signal);
};

/** pi-quota's text, and the Claude usage with its verdict when a Claude account answered. */
export type GateRead = { readonly text: string; readonly claude?: { readonly usage: ClaudeUsage; readonly verdict: GateVerdict }; readonly results?: readonly QuotaResult[] };

/** One fresh read; the state file is refreshed when Claude usage was reported. */
export const readGate = async (lookup: UsageLookup, gate: QuotaGate, stateDir: string, now: number, signal: AbortSignal): Promise<GateRead> => {
  const { results, text } = await lookup(signal);
  const usage = claudeUsage(results, now);
  if (!usage) return { text, results };
  const verdict = gateVerdict(usage, gate);
  writeQuotaState(stateDir, { usage, mode: verdict.mode, holdsLanes: verdict.holdsLanes });
  return { text, claude: { usage, verdict } };
};

/** What the lead does in each mode; carried on CLAUDE_QUOTA lines. */
export const MODE_HINT: Record<GateMode, string> = {
  ok: "normal work; held lanes may launch again",
  "hold-lanes": "no new lanes (dori launch holds); answer as usual",
  brief: "answer briefly or decline new work with the reset time; no new lanes",
  blocked: "every Claude account has a subscription window used up; decline new work until the reset (the supervisor moves the lead to an emergency model only once it is blocked)",
};

/** A cached state older than this is not used to hold work. */
const staleMs = (gate: QuotaGate): number => Math.max(3 * gate.pollMin, 15) * 60_000;

/** The cached mode, when the supervisor's last read is fresh enough to act on. */
export const cachedMode = (config: DoriConfig, now: number): QuotaState | undefined => {
  const state = readQuotaState(config.stateDir);
  return state && now - state.usage.at <= staleMs(config.quotaGate) ? state : undefined;
};

/** Any lead or default model spends the Claude subscription, so an unreadable gate matters. */
const gated = (config: DoriConfig): boolean =>
  usesClaudeSubscription(config.defaultModel) || leadChain(config).some((m) => usesClaudeSubscription(m.model));

/**
 * The supervisor's usage sweep: one read every `quotaGate.pollMin` minutes, cached for status and LAUNCH_READY.
 * A mode change becomes one `CLAUDE_QUOTA <mode> | ...` line; the first read is quiet while it is ok.
 * The gate stays fail-open when usage cannot be read, no Claude account answers, or pi-quota's window labels are not
 * recognised, but one `QUOTA_GATE_UNKNOWN <detail>` line is returned per such episode (`last.unknown`), when a
 * configured model uses the Claude subscription. A good read ends the episode.
 */
export const claudeQuotaTick = async (deps: { readonly config: DoriConfig; readonly clock: Clock }, lookup: UsageLookup, last: { at: number; mode?: GateMode; unknown?: string }): Promise<string[]> => {
  const { config } = deps;
  const now = deps.clock.now();
  if (now - last.at < config.quotaGate.pollMin * 60_000) return [];
  last.at = now;
  // Other readers (dori quota, launch, /quota) also write the state file, so the last announced mode lives here.
  const before = last.mode ?? readQuotaState(config.stateDir)?.mode;
  let read: GateRead | undefined;
  let unknown: string | undefined;
  try {
    read = await readGate(lookup, config.quotaGate, config.stateDir, now, AbortSignal.timeout(30_000));
    if (!read.claude) {
      const labels = unrecognizedClaudeLabels(read.results ?? []);
      unknown = labels.length ? `pi-quota window labels not recognised (${labels.join(", ")})` : "no Claude subscription usage reported";
    }
  } catch (e) {
    unknown = `Claude usage unreadable (${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160)})`;
  }
  if (!read?.claude) {
    console.error(`QUOTA_GATE_UNKNOWN ${unknown}; lanes are not gated`);
    if (last.unknown !== undefined || !gated(config)) return [];
    last.unknown = unknown ?? "unknown";
    return [`QUOTA_GATE_UNKNOWN ${last.unknown}; the Claude quota gate is off (fail-open): lanes launch ungated until usage reads again`];
  }
  last.unknown = undefined;
  const { verdict } = read.claude;
  last.mode = verdict.mode;
  if (verdict.mode === before || (before === undefined && verdict.mode === "ok")) return [];
  return [`CLAUDE_${gateLine(verdict)}; ${MODE_HINT[verdict.mode]}`];
};

export const NO_CLAUDE = "QUOTA unknown | no Claude subscription usage reported";

/**
 * The quota HOLD reason for launching a lane on `model`, or undefined to go ahead. Only Claude subscription models are
 * gated. A usage read that fails or reports no Claude account never holds work; `warn` says so.
 */
export const launchQuotaHold = async (config: DoriConfig, lookup: UsageLookup, model: string, now: number, warn: (line: string) => void): Promise<string | undefined> => {
  if (!usesClaudeSubscription(model)) return undefined;
  let read: GateRead;
  try { read = await readGate(lookup, config.quotaGate, config.stateDir, now, AbortSignal.timeout(20_000)); }
  catch (e) { warn(`QUOTA_WARN Claude usage unreadable (${e instanceof Error ? e.message : String(e)}); launch not gated`); return undefined; }
  if (!read.claude) { warn(`${NO_CLAUDE}; launch not gated`); return undefined; }
  const { verdict } = read.claude;
  return verdict.holdsLanes ? `quota ${verdict.mode}: ${holdReason(verdict)}` : undefined;
};

/** The `/quota` text: pi-quota's own usage block only (it already shows reset times); no QUOTA line. */
export const quotaReport = (lookup: UsageLookup, gate: () => QuotaGate, stateDir: string, now: () => number) => async (signal: AbortSignal): Promise<string> => {
  const read = await readGate(lookup, gate(), stateDir, now(), signal);
  return read.text;
};
