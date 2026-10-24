/**
 * The event policy table (design 1.7): every event kind is delivered by class. `lead-urgent` wakes the lead,
 * `lead-digest` waits for the next urgent delivery (or `digestMaxDelayMin`), `owner-only` is posted to the owner's main
 * channel and never reaches the lead, `engine-only` is journaled for the engine and the counts only.
 *
 * A kind is the event line's first word, optionally followed by more words that must match the line's next words in
 * order; `*` matches any one word. `HOST_GUARD ALERT` matches `HOST_GUARD ALERT load 40`, `GH_PR * merged` matches
 * `GH_PR acme/app#7 merged ...`. The most specific matching kind wins (more words, then fewer `*`); a line no kind
 * matches gets `default`. Kinds are open-ended: a new event source needs only a config entry, or none at all.
 */
export const EVENT_CLASSES = ["lead-urgent", "lead-digest", "owner-only", "engine-only"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export type EventPolicy = {
  /** The class of a line no kind matches. */
  readonly default: EventClass;
  readonly kinds: Readonly<Record<string, EventClass>>;
};

const URGENT_KINDS = [
  "INBOUND", "INBOUND_EDIT", "INBOUND_DELETE", "VISITOR", "LANE_NOT_DONE", "LANE_REPORT",
  "DEAD_PANE", "UNRECOGNISED_PANE", "NO-REPORT", "NO-PROGRESS",
  "HOST_GUARD ALERT", "HOST_GUARD CLEAR", "LAUNCH_READY", "WORKING-WHILE-PAUSED",
  "WAIT_DONE", "WAIT_TIMEOUT", "SUPERVISOR_STUCK", "LANE_QUOTA_STALL", "ACK_MISSING", "UNHANDLED", "UNREPORTED",
  "LANE_QUOTA_CLEARED", "LANE_QUOTA_UNKNOWN", "LANE_RECOVERY_EXHAUSTED", "LANE_RECOVERY_BLOCKED",
  "LEAD_QUOTA_EXHAUSTED", "LEAD_QUOTA_CLEARED", "QUOTA_GATE_UNKNOWN", "WAIT_FAILED", "WAITS_CORRUPT",
  "LEAD_EMERGENCY_APPROVAL", "TASK_STALLED", "OPERATION_AMBIGUOUS", "OPERATION_FAILED",
  // CI follow-up: a lane that did not confirm its message in time, and a conflict no merge lane could take.
  "LANE_MESSAGE_UNCONFIRMED", "CI_CONFLICT",
  // A merged lane PR whose merge the supervisor could not read back.
  "MERGE_UNVERIFIED",
  "GH_PR * closed", "GH_PR * review", "GH_PR * comment",
  "GH_ISSUE * opened", "GH_ISSUE * reopened",
  // A move into brief/blocked changes what the lead may do now; ok/hold-lanes changes stay digest.
  "CLAUDE_QUOTA brief", "CLAUDE_QUOTA blocked",
] as const;

/**
 * Kinds that stay digest whatever `default` says. The lane hears about its PR first (CI follow-up messages it and merges
 * or opens a merge lane), and a lane's milestone and progress reports wait for the next urgent delivery. The supervisor
 * settles the rest itself: a done claim is re-checked live and closed (or objected to, LANE_NOT_DONE, which is urgent),
 * and a merged lane PR has its merge read back (MERGE_VERIFIED, or urgent MERGE_UNVERIFIED) and its lane closed.
 */
const DIGEST_KINDS = [
  "GH_PR * checks_failing", "GH_PR * conflicting", "GH_PR * merged", "LANE_REPORT * milestone", "LANE_REPORT * progress",
  "LANE_DONE_CLAIMED", "LANE_CLOSED", "MERGE_VERIFIED",
] as const;

/** The actionable kinds wake the lead, every other line is digest. */
export const DEFAULT_EVENT_POLICY: EventPolicy = {
  default: "lead-digest",
  kinds: Object.fromEntries([...URGENT_KINDS.map((kind) => [kind, "lead-urgent"]), ...DIGEST_KINDS.map((kind) => [kind, "lead-digest"])]),
};

/** Owner tracking reads these from the lead's journal: they may only be lead classes. */
const LEAD_ONLY_KINDS = ["INBOUND", "INBOUND_EDIT", "INBOUND_DELETE"];

export class EventPolicyError extends Error {}

const isClass = (value: unknown): value is EventClass => typeof value === "string" && (EVENT_CLASSES as readonly string[]).includes(value);

/**
 * The policy from a config's `eventPolicy` (absent: the default). Its `kinds` are laid over the default table, so a
 * config names only the kinds it changes. Throws EventPolicyError on a value that is not a class or a malformed kind.
 */
export const resolveEventPolicy = (raw: unknown): EventPolicy => {
  if (raw === undefined) return DEFAULT_EVENT_POLICY;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new EventPolicyError("eventPolicy must be an object");
  const { default: fallback, kinds } = raw as { default?: unknown; kinds?: unknown };
  if (fallback !== undefined && !isClass(fallback)) throw new EventPolicyError(`eventPolicy.default must be one of ${EVENT_CLASSES.join(", ")}`);
  if (kinds !== undefined && (typeof kinds !== "object" || kinds === null || Array.isArray(kinds))) throw new EventPolicyError("eventPolicy.kinds must be an object");
  const merged: Record<string, EventClass> = { ...DEFAULT_EVENT_POLICY.kinds };
  for (const [kind, value] of Object.entries(kinds ?? {})) {
    if (!isClass(value)) throw new EventPolicyError(`eventPolicy.kinds["${kind}"] must be one of ${EVENT_CLASSES.join(", ")}`);
    const words = kind.split(" ");
    if (!kind || words.some((word) => !word) || words[0] === "*") throw new EventPolicyError(`eventPolicy.kinds["${kind}"]: a kind is words separated by single spaces, starting with the event name`);
    if (LEAD_ONLY_KINDS.includes(words[0] as string) && !value.startsWith("lead-")) {
      throw new EventPolicyError(`eventPolicy.kinds["${kind}"]: owner messages must reach the lead (lead-urgent or lead-digest)`);
    }
    merged[kind] = value;
  }
  return { default: fallback ?? DEFAULT_EVENT_POLICY.default, kinds: merged };
};

type Entry = { readonly kind: string; readonly words: readonly string[]; readonly cls: EventClass };
const compiled = new WeakMap<EventPolicy, Map<string, readonly Entry[]>>();

/** Kinds by first word, most specific first. */
const index = (policy: EventPolicy): Map<string, readonly Entry[]> => {
  const hit = compiled.get(policy);
  if (hit) return hit;
  const map = new Map<string, Entry[]>();
  for (const [kind, cls] of Object.entries(policy.kinds)) {
    const words = kind.split(" ");
    const list = map.get(words[0] as string) ?? [];
    list.push({ kind, words, cls });
    map.set(words[0] as string, list);
  }
  const wild = (e: Entry) => e.words.filter((w) => w === "*").length;
  for (const list of map.values()) list.sort((a, b) => b.words.length - a.words.length || wild(a) - wild(b) || a.kind.localeCompare(b.kind));
  compiled.set(policy, map);
  return map;
};

const match = (line: string, policy: EventPolicy): Entry | undefined => {
  const words = line.split(" ");
  return index(policy).get(words[0] as string)?.find((e) => e.words.every((w, i) => i < words.length && (w === "*" || w === words[i])));
};

/** The kind a line counts under: the matching table entry, else its first word. */
export const eventKind = (line: string, policy: EventPolicy = DEFAULT_EVENT_POLICY): string =>
  match(line, policy)?.kind ?? (line.split(" ", 1)[0] || "(empty)");

export const eventClass = (line: string, policy: EventPolicy = DEFAULT_EVENT_POLICY): EventClass => match(line, policy)?.cls ?? policy.default;

/** Lead classes are journaled for the lead; owner-only and engine-only never reach it. */
export const forLead = (cls: EventClass): boolean => cls === "lead-urgent" || cls === "lead-digest";
