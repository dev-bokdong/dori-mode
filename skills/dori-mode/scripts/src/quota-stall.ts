import { type ArgvTemplate, type DoriConfig, fill, providerOf } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { screenLines } from "./launch.ts";
import { passthroughView, type SweepView } from "./sweep-view.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import type { RecoveryEnqueue } from "./recover.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Runner } from "./run.ts";
import { Waits } from "./waits.ts";

/** Lane record fields this sweep keeps (the registry stores whatever the record carries). */
export type QuotaLane = Lane & {
  /** When the stalled provider's quota resets (epoch ms), read from omo auth check or the pane; absent when unknown. */
  readonly quotaResetAt?: number;
  /** The quota sweep paused this lane itself; only such a lane is resumed when the stall clears. */
  readonly quotaAutoPaused?: boolean;
  /** Persisted before the goal command; replayed until the external transition is confirmed. */
  readonly quotaPending?: "pausing" | "resuming";
  /** The wait registered to fire at the reset time. */
  readonly quotaWait?: string;
  /** A screen quota hit whose omo auth check output could not be read (reported once per distinct detail). */
  readonly lastQuotaUnknown?: string;
  /** When this stall stretch was marked: with the pause outcome it makes the stable id of its LANE_QUOTA_STALL. */
  readonly quotaStallAt?: number;
};

/** The history note of a pause made by this sweep; a lane paused by anyone else is never resumed here. */
export const QUOTA_PAUSE_NOTE = "auto-paused on quota stall";

/** Lines of a pane's recent screen searched for a quota failure. */
export const QUOTA_SCREEN_LINES = 40;

/** omo's own message when every account of a provider is out (e.g. "All Claude accounts for anthropic-subscription are currently blocked"). */
const ALL_BLOCKED = /\baccounts? for \S+ (?:is|are) (?:currently |all )?blocked\b/i;
/** After an "Error:" prefix these words are a quota failure. */
const QUOTA_WORDS = /usage limit|rate limit|quota|insufficient_quota|\b429\b/i;
/**
 * Without a prefix a quota failure is a limit phrase anywhere in the line that ends its clause (end of line or
 * punctuation, or a reset/retry tail), so prose that merely names the wording ("handle rate limit exceeded errors") is not one.
 */
const QUOTA_LINE = /(?:\byou(?:'ve| have) (?:hit|reached|exceeded|used up) (?:your |the |a )?(?:[\w-]+ )?(?:(?:usage|rate) )?limit\b|\b(?:(?:usage|rate|session|\d+-hour|weekly|daily) limit|quota) (?:has been |was |is )?(?:reached|exceeded|hit|exhausted)\b|\binsufficient_quota\b|\b429\b[\s:-]*too many requests\b)(?=\s*$|\s*[.!:;)\u2219\u00b7|-]|\s+(?:for|on|until|please|try|retry|resets?|wait|\())/i;

/**
 * The last quota failure line on a screen, or undefined. Tips, recalled-memory/Kibitzer blocks and echoed briefs are
 * skipped as for startup failures. A screen line alone never makes a stall: the provider's accounts decide.
 */
export const quotaScreenHit = (screen: string): string | undefined => {
  let hit: string | undefined;
  for (const line of screenLines(screen)) {
    const error = /^(?:error|fatal)\b[:\s-]*/i.exec(line);
    if (ALL_BLOCKED.test(line) || QUOTA_LINE.test(line) || (error && QUOTA_WORDS.test(line.slice(error[0].length)))) hit = line.trim();
  }
  return hit?.replace(/\s+/g, " ").slice(0, 160);
};

/** `unknown`: the check could not be read, so blocked is not known; `resetAt`: the earliest reset of a blocked account. */
export type ProviderQuota = { readonly blocked: boolean; readonly detail: string; readonly unknown?: boolean; readonly resetAt?: number };

/** A timestamp an account may carry: epoch ms or seconds, or a date string. */
const timeOf = (value: unknown): number | undefined => {
  const ms = typeof value === "number" ? (value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
const RESET_FIELDS = ["blockedUntil", "blocked_until", "resetAt", "reset_at", "resetsAt", "resets_at", "until"] as const;

const UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };
/** A reset time printed on the pane: an ISO time after "reset", or "try again in 2h 30m" style durations from `now`. */
export const paneResetAt = (screen: string, now: number): number | undefined => {
  let at: number | undefined;
  for (const line of screenLines(screen)) {
    const iso = /\b(?:resets?|reset at|until|try again at|available at)\b[^\n]*?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/i.exec(line);
    const isoAt = iso?.[1] ? Date.parse(iso[1].replace(" ", "T")) : NaN;
    if (Number.isFinite(isoAt)) { at = isoAt; continue; }
    const rel = /\b(?:try again|retry|resets?|available)\s+(?:in|after)\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(line);
    if (!rel?.[1]) continue;
    let ms = 0;
    for (const part of rel[1].matchAll(/(\d+)\s*([hms])/gi)) ms += Number(part[1]) * (UNITS[(part[2] ?? "").toLowerCase()] ?? 0);
    if (ms > 0) at = now + ms;
  }
  return at;
};

/**
 * Runs `quotaCheck` for one provider and reads its JSON account list. Blocked only when the provider has accounts and
 * every one of them is blocked: one blocked account next to a healthy one is omo's own fallback, not a stall. The exit
 * code and `status` are not used (omo reports not_ready for a provider that still lists usable accounts). A template
 * asking for credentials is refused and never run.
 */
export const providerQuota = async (run: Runner, template: ArgvTemplate, provider: string): Promise<ProviderQuota> => {
  if (template.some((part) => part === "--credentials" || part.startsWith("--credentials="))) return { blocked: false, unknown: true, detail: "quotaCheck asks for --credentials; not run" };
  const r = await run(fill(template, { provider }), { timeoutMs: 15_000 });
  let parsed: unknown;
  try { parsed = JSON.parse(r.out); } catch { parsed = undefined; }
  const list: unknown = typeof parsed === "object" && parsed !== null && "accounts" in parsed ? parsed.accounts : undefined;
  // Unreadable is not "not blocked": the caller reports it as unknown.
  if (!Array.isArray(list)) return { blocked: false, unknown: true, detail: `${provider} quota check unreadable (exit ${r.code})` };
  const blockedAccounts = list.filter((a: unknown): a is Record<string, unknown> => typeof a === "object" && a !== null && "blocked" in a && a.blocked === true);
  const resets = blockedAccounts.flatMap((a) => { const at = RESET_FIELDS.map((f) => timeOf(a[f])).find((t) => t !== undefined); return at === undefined ? [] : [at]; });
  return {
    blocked: list.length > 0 && blockedAccounts.length === list.length, detail: `${blockedAccounts.length}/${list.length} ${provider} accounts blocked`,
    ...(resets.length ? { resetAt: Math.min(...resets) } : {}),
  };
};

/**
 * omo's provider name (as `omo auth check --provider` spells it) for a bare model name, by model family. Bare Claude
 * models spend the Claude subscription (as in claude-quota.ts), whose accounts omo keeps under anthropic-subscription.
 */
const MODEL_FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/^claude-/i, "anthropic-subscription"],
  [/^(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/i, "openai"],
  [/^gemini-/i, "google"],
  [/^grok-/i, "xai"],
  [/^(?:mistral|codestral|devstral|magistral)-/i, "mistral"],
  [/^deepseek-/i, "deepseek"],
];

/** The provider whose accounts back `model`: its "provider/" prefix, else inferred from a well-known model family. */
export const modelProvider = (model: string): string | undefined => {
  const bare = model.trim();
  return providerOf(bare) ?? MODEL_FAMILIES.find(([family]) => family.test(bare))?.[1];
};

/** A quota stall reason for this screen and model, or undefined: a screen hit AND all of the model's provider accounts blocked. */
export const quotaStall = async (run: Runner, config: DoriConfig, screen: string, model: string, cache = new Map<string, Promise<ProviderQuota>>()): Promise<string | undefined> => {
  const hit = quotaScreenHit(screen);
  const provider = modelProvider(model);
  if (!hit || !provider) return undefined;
  let check = cache.get(provider);
  if (!check) { check = providerQuota(run, config.quotaCheck, provider); cache.set(provider, check); }
  const quota = await check;
  return quota.blocked ? `${quota.detail}: ${hit}` : undefined;
};

/** The wait that fires at a lane's quota reset (wait keys are at most 61 characters). */
export const quotaWaitKey = (key: string): string => `quota-${key}`.slice(0, 61);

/** Paused by this sweep and not re-paused by anyone since: the last history entry is this sweep's pause. */
const autoPaused = (lane: QuotaLane): boolean => {
  const last = lane.history?.at(-1);
  return Boolean(lane.quotaAutoPaused) && statusOf(lane) === "paused" && last?.status === "paused" && last.note.startsWith(QUOTA_PAUSE_NOTE);
};

const CLEARED: Partial<QuotaLane> = { lastQuotaStall: undefined, quotaResetAt: undefined, quotaAutoPaused: undefined, quotaPending: undefined, quotaWait: undefined, lastQuotaUnknown: undefined, quotaStallAt: undefined };

const cancelWait = (deps: FlowDeps, lane: QuotaLane): void => {
  if (!lane.quotaWait) return;
  try { new Waits(deps.config.stateDir).cancel(lane.quotaWait); }
  catch (e) { console.error(`LANE_QUOTA_WAIT_ERROR ${lane.key} cancel ${lane.quotaWait}: ${e instanceof Error ? e.message : String(e)}`); }
};

/** A wait whose signal turns true at `resetAt`, so the lead is woken at the reset even if this sweep is not. */
const registerResetWait = (deps: FlowDeps, lane: QuotaLane, resetAt: number): string => {
  const key = quotaWaitKey(lane.key);
  const waits = new Waits(deps.config.stateDir);
  waits.cancel(key);
  waits.register({
    key, until: `command ["sh","-c","[ $(date +%s) -ge ${Math.ceil(resetAt / 1000)} ]"]`,
    note: `lane ${lane.key} quota reset; the quota sweep resumes it once its provider has quota (else dori resume ${lane.key})`,
    cwd: lane.cwd ?? deps.config.defaultCwd, ...(lane.thread !== "none" ? { thread: lane.thread } : {}),
  }, deps.clock.now());
  return key;
};

/** The stall ended: one LANE_QUOTA_CLEARED, and a lane this sweep paused is resumed (never one paused by the owner/lead). */
const clearStall = async (deps: FlowDeps, lane: QuotaLane, detail: string): Promise<string> => {
  const head = `LANE_QUOTA_CLEARED ${lane.key} ${lane.pane ?? "-"} ${detail}`;
  let resume = false;
  const prepared = await deps.registry.update(lane.key, (current: QuotaLane | null) => {
    if (!current || !autoPaused(current)) return undefined;
    resume = true;
    return { ...current, quotaPending: "resuming" };
  });
  if (!prepared) return head;
  const resumed = resume ? await resumeLane(deps, prepared, `quota cleared: ${detail}`, autoPaused) : undefined;
  if (!resumed || resumed.code === 0 || resumed.code === 2) {
    // Keep the transition and wait identity until the external resume is confirmed (or ownership was taken).
    cancelWait(deps, prepared);
    await deps.registry.patch<QuotaLane>(lane.key, CLEARED);
  }
  if (!resumed) return head;
  return `${head}; ${resumed.code === 0 ? "auto-resumed" : `resume failed (${resumed.lines.join("; ")}), dori resume ${lane.key}`}`;
};

/**
 * Carries out (or replays) a persisted pause intent, including after a crash between the goal/status change and the
 * bookkeeping. The LANE_QUOTA_STALL line is handed to `enqueue` (stable id per stretch and outcome, so a replay cannot
 * repeat it) before the intent is cleared, or returned when there is no durable enqueue. A pause that cannot happen
 * (the lane left working, or someone else paused it) ends the intent; only an unconfirmed goal pause is retried.
 */
const finishPause = async (deps: FlowDeps, lane: QuotaLane, enqueue?: RecoveryEnqueue): Promise<string | undefined> => {
  const paused = await pauseLane(deps, lane, `${QUOTA_PAUSE_NOTE}: ${lane.lastQuotaStall}`, true);
  let waitText = "";
  if (lane.quotaResetAt !== undefined && paused.code === 0) {
    try { waitText = ` | wait ${registerResetWait(deps, lane, lane.quotaResetAt)}`; }
    catch (e) { waitText = ` | wait not registered: ${e instanceof Error ? e.message : String(e)}`; }
  }
  const line = `LANE_QUOTA_STALL ${lane.key} ${lane.pane} reset=${lane.quotaResetAt !== undefined ? new Date(lane.quotaResetAt).toISOString() : "unknown"} ${lane.lastQuotaStall} | ${paused.lines.join("; ")}${waitText}`;
  if (enqueue) await enqueue(line, `lane-quota-stall:${lane.key}:${lane.quotaStallAt ?? lane.lastQuotaStall}:${paused.code}`);
  let ended = false;
  await deps.registry.patch<QuotaLane>(lane.key, (current) => {
    if (paused.code === 3) return undefined;
    if (paused.code === 0 && autoPaused(current)) return { quotaPending: undefined };
    ended = true;
    return CLEARED;
  });
  if (ended) cancelWait(deps, { ...lane, quotaWait: quotaWaitKey(lane.key) });
  return enqueue ? undefined : line;
};

/**
 * One urgent `LANE_QUOTA_STALL <key> <pane> reset=<iso|unknown> <reason> | <pause result>[ | wait <key>]` per stall
 * stretch for each working local lane. The lane is paused (its goal too, so nothing spins on the dead provider), the
 * reset time is stored and a wait fires at it. When the provider has quota again, `LANE_QUOTA_CLEARED` is sent and a
 * lane this sweep paused is resumed. A quota check that cannot be read is `LANE_QUOTA_UNKNOWN`, never "not blocked".
 * A lane's model is never changed here; the lead decides. Remote lanes are skipped: the check reads this host's accounts.
 * A model with no provider prefix is checked under the provider its family implies; when none can be inferred, a screen
 * hit is `LANE_QUOTA_UNKNOWN` once per stretch. Only this sweep's own fields are written, onto the fresh lane.
 */
export const laneQuotaTick = async (deps: FlowDeps, enqueue?: RecoveryEnqueue, view: SweepView = passthroughView(deps.run)): Promise<string[]> => {
  const out: string[] = [];
  const cache = new Map<string, Promise<ProviderQuota>>();
  const quotaOf = (provider: string): Promise<ProviderQuota> => {
    let check = cache.get(provider);
    if (!check) { check = providerQuota(deps.run, deps.config.quotaCheck, provider); cache.set(provider, check); }
    return check;
  };
  for (const found of await deps.registry.open()) {
    const lane: QuotaLane = found;
    if (!lane.pane || lane.machine) continue;
    if (lane.quotaPending === "pausing" && lane.quotaAutoPaused) {
      // The quota may be back by the replay: then nothing is paused any more, and an auto-paused lane is resumed.
      const replayProvider = modelProvider(lane.model ?? deps.config.defaultModel);
      const now = replayProvider ? await quotaOf(replayProvider) : undefined;
      if (now && !now.blocked && !now.unknown) out.push(await clearStall(deps, lane, now.detail));
      else {
        const line = await finishPause(deps, lane, enqueue);
        if (line) out.push(line);
      }
      continue;
    }
    if (lane.quotaPending === "resuming" && statusOf(lane) === "working") {
      out.push(await clearStall(deps, lane, "resume confirmed"));
      continue;
    }
    const model = lane.model ?? deps.config.defaultModel;
    const provider = modelProvider(model);
    if (statusOf(lane) === "paused") {
      // Only this sweep's own pause is watched: the screen still shows the old error, so the accounts decide.
      if (!autoPaused(lane) || !provider) continue;
      const quota = await quotaOf(provider);
      if (quota.unknown) console.error(`LANE_QUOTA_UNKNOWN ${lane.key} ${quota.detail}; left paused`);
      if (!quota.blocked && !quota.unknown) out.push(await clearStall(deps, lane, quota.detail));
      continue;
    }
    if (statusOf(lane) !== "working") continue;
    const screen = await view.screen(lane, QUOTA_SCREEN_LINES);
    const hit = quotaScreenHit(screen);
    const quota: ProviderQuota | undefined = !hit ? undefined
      : provider ? await quotaOf(provider)
      : { blocked: false, unknown: true, detail: `no provider known for model ${model}` };
    if (quota?.unknown) {
      console.error(`LANE_QUOTA_UNKNOWN ${lane.key} ${quota.detail}: ${hit}`);
      if (lane.lastQuotaUnknown !== quota.detail) {
        await deps.registry.patch<QuotaLane>(lane.key, { lastQuotaUnknown: quota.detail });
        out.push(`LANE_QUOTA_UNKNOWN ${lane.key} ${lane.pane} ${quota.detail}: ${hit}`);
      }
      continue;
    }
    if (!quota?.blocked) {
      if (lane.lastQuotaStall) out.push(await clearStall(deps, lane, quota?.detail ?? "no quota failure on the pane"));
      else if (lane.lastQuotaUnknown || lane.quotaAutoPaused) await deps.registry.patch<QuotaLane>(lane.key, CLEARED);
      continue;
    }
    if (lane.lastQuotaStall) continue;
    const stall = `${quota.detail}: ${hit}`;
    const resetAt = quota.resetAt ?? paneResetAt(screen, deps.clock.now());
    const marking: Partial<QuotaLane> = { ...CLEARED, lastQuotaStall: stall, quotaAutoPaused: true, quotaPending: "pausing", quotaStallAt: deps.clock.now(),
      ...(resetAt !== undefined ? { quotaResetAt: resetAt, quotaWait: quotaWaitKey(lane.key) } : {}) };
    const marked = await deps.registry.patch<QuotaLane>(lane.key, (current) => statusOf(current) === "working" ? marking : undefined);
    if (marked?.quotaPending === "pausing" && marked.quotaAutoPaused) {
      const line = await finishPause(deps, marked, enqueue);
      if (line) out.push(line);
    }
  }
  return out;
};
