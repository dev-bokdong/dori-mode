import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { DEFAULT_EVENT_POLICY, eventClass, eventKind, EventPolicyError, resolveEventPolicy } from "../src/event-policy.ts";
import { eventPriority } from "../src/supervise.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

/** The hard-coded classifier this table replaced (supervise-delivery.ts before 1.7), kept verbatim as the reference. */
const LEGACY_URGENT = [
  "INBOUND", "INBOUND_EDIT", "INBOUND_DELETE", "VISITOR", "LANE_DONE_CLAIMED", "LANE_NOT_DONE", "LANE_CLOSED", "LANE_REPORT",
  "DEAD_PANE", "UNRECOGNISED_PANE", "NO-REPORT", "NO-PROGRESS",
  "HOST_GUARD ALERT", "HOST_GUARD CLEAR", "LAUNCH_READY", "WORKING-WHILE-PAUSED",
  "WAIT_DONE", "WAIT_TIMEOUT", "SUPERVISOR_STUCK", "LANE_QUOTA_STALL", "ACK_MISSING", "UNHANDLED",
  "LANE_QUOTA_CLEARED", "LANE_QUOTA_UNKNOWN", "LANE_RECOVERY_EXHAUSTED", "LANE_RECOVERY_BLOCKED",
  "LEAD_QUOTA_EXHAUSTED", "LEAD_QUOTA_CLEARED", "QUOTA_GATE_UNKNOWN", "WAIT_FAILED", "WAITS_CORRUPT",
  "LEAD_EMERGENCY_APPROVAL", "TASK_STALLED",
];
const legacyPriority = (line: string): "urgent" | "digest" =>
  LEGACY_URGENT.some((prefix) => line === prefix || line.startsWith(`${prefix} `)) ||
  /^GH_PR \S+ (checks_failing|merged|closed|review|comment|conflicting)(?: |$)/.test(line) ||
  /^GH_ISSUE \S+ (opened|reopened) /.test(line) ||
  /^CLAUDE_QUOTA (brief|blocked)(?: |$)/.test(line) ? "urgent" : "digest";

const corpus = [
  ...LEGACY_URGENT.flatMap((kind) => [kind, `${kind} detail here`, `${kind}X detail`, `${kind}_MORE detail`]),
  ...["checks_failing", "merged", "closed", "review", "comment", "conflicting", "opened", "updated", "checks_green", "merged_x"]
    .flatMap((kind) => [`GH_PR acme/app#7 ${kind} sha=abc https://github.com/acme/app/pull/7`, `GH_PR acme/app#7 ${kind}`]),
  "GH_PR merged", "GH_PR acme/app#7", "GH_ISSUE acme/app#3 opened author=a https://x", "GH_ISSUE acme/app#3 reopened author=a https://x",
  "GH_ISSUE acme/app#3 closed author=a https://x", "GH_ISSUE_UNTRUSTED acme/app#3 opened author=b https://x",
  "CLAUDE_QUOTA ok | 5h 4%", "CLAUDE_QUOTA hold-lanes | 5h 81%", "CLAUDE_QUOTA brief | 5h 91%", "CLAUDE_QUOTA blocked", "CLAUDE_QUOTA briefly",
  "HOST_GUARD", "HOST_GUARD WARN x", "HOST_GUARD ALERTS x", "SWEEP_WARN watch boom", "MEMORY_CHECK stale", "PROGRESS lane x", "NUDGED lane",
  "OWNER_QUARANTINED 2 1:2,3", "COMPUTE_READY", "", " INBOUND leading space", "inbound lower case", "NEW_SOURCE_KIND something",
];

test("the default table classifies every line as the hard-coded list did, except the PR states CI follow-up hands to the lane", () => {
  const differ = corpus.filter((line) => eventPriority(line) !== legacyPriority(line));
  // CI follow-up messages the lane about failing checks and conflicts first, so for the lead they are digest.
  expect(differ).toEqual(corpus.filter((line) => /^GH_PR \S+ (checks_failing|conflicting)(?: |$)/.test(line)));
  expect(differ.every((line) => eventPriority(line) === "digest")).toBe(true);
  expect(corpus.filter((line) => eventPriority(line) === "urgent").length).toBeGreaterThan(LEGACY_URGENT.length);
});

test("a kind is the most specific matching entry, else the line's first word", () => {
  expect(eventKind("GH_PR acme/app#7 merged sha=1")).toBe("GH_PR * merged");
  expect(eventKind("GH_PR acme/app#7 opened")).toBe("GH_PR");
  expect(eventKind("HOST_GUARD ALERT load")).toBe("HOST_GUARD ALERT");
  expect(eventKind("INBOUND 1 2 hi")).toBe("INBOUND");
  expect(eventKind("")).toBe("(empty)");
  const policy = resolveEventPolicy({ kinds: { "GH_PR acme/app#7 merged": "engine-only", "GH_PR * merged": "lead-digest" } });
  expect(eventKind("GH_PR acme/app#7 merged", policy)).toBe("GH_PR acme/app#7 merged");
  expect(eventClass("GH_PR acme/app#7 merged", policy)).toBe("engine-only");
  expect(eventClass("GH_PR other/x#1 merged", policy)).toBe("lead-digest");
});

test("a config file changes a kind's class and the default with no code change", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify({ eventPolicy: { default: "lead-urgent", kinds: { "GH_PR * opened": "lead-urgent", LANE_REPORT: "owner-only", NUDGED: "engine-only" } } }));
  const policy = (await loadConfig(path, state.dir)).eventPolicy;
  expect(eventPriority("GH_PR acme/app#7 opened", policy)).toBe("urgent");
  expect(eventClass("LANE_REPORT lane question", policy)).toBe("owner-only");
  expect(eventClass("NUDGED lane", policy)).toBe("engine-only");
  // Unknown kinds take the configured default; kinds the file does not name keep the default table.
  expect(eventClass("NEW_SOURCE_KIND x", policy)).toBe("lead-urgent");
  expect(eventClass("INBOUND 1 2 hi", policy)).toBe("lead-urgent");
  writeFileSync(path, "{}");
  expect((await loadConfig(path, state.dir)).eventPolicy).toBe(DEFAULT_EVENT_POLICY);
});

test.each([
  [{ default: "urgent" }, "eventPolicy.default"],
  [{ kinds: { NUDGED: "loud" } }, "NUDGED"],
  [{ kinds: { "* merged": "lead-urgent" } }, "* merged"],
  [{ kinds: { "GH_PR  merged": "lead-urgent" } }, "GH_PR  merged"],
  [{ kinds: { INBOUND: "engine-only" } }, "owner messages must reach the lead"],
  [{ kinds: ["INBOUND"] }, "eventPolicy.kinds"],
  ["lead-urgent", "eventPolicy must be an object"],
])("a malformed eventPolicy %j is refused", (raw, message) => {
  expect(() => resolveEventPolicy(raw)).toThrow(EventPolicyError);
  expect(() => resolveEventPolicy(raw)).toThrow(message);
});
