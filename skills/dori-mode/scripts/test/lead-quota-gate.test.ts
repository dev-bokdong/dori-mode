import { afterEach, expect, test } from "bun:test";

import { claudeQuotaTick, readGate, type QuotaResult, type UsageLookup } from "../src/claude-quota.ts";
import { defaultConfig } from "../src/config.ts";
import { eventPriority, Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const NOW = Date.parse("2026-10-22T03:00:00.000Z");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = (): string => {
  const s = withState();
  cleanups.push(s.done);
  return s.dir;
};
const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = original; }
};
const claude = (labels: readonly string[], left = 50, account?: string): QuotaResult => ({
  kind: "success", provider: "anthropic", ...(account ? { account } : {}),
  windows: labels.map((label) => ({ label, remainingPercent: left })),
});

test("CLAUDE_QUOTA moves into brief or blocked wake the lead at once; ok and hold-lanes stay digest", () => {
  expect(eventPriority("CLAUDE_QUOTA blocked | Claude 5h 100% (resets 10-22 15:10 KST), 7d 40%; the subscription window is used up")).toBe("urgent");
  expect(eventPriority("CLAUDE_QUOTA brief | Claude 5h 95%, 7d 10%; answer briefly")).toBe("urgent");
  expect(eventPriority("CLAUDE_QUOTA hold-lanes | Claude 5h 85%, 7d 10%; no new lanes")).toBe("digest");
  expect(eventPriority("CLAUDE_QUOTA ok | Claude 5h 5%, 7d 10%; normal work")).toBe("digest");
});

test("lane-quota, lead-quota, gate and wait-failure events are urgent", () => {
  for (const line of [
    "LANE_QUOTA_CLEARED k w:p1 0/2 a accounts blocked; auto-resumed",
    "LANE_QUOTA_UNKNOWN k w:p1 a quota check unreadable (exit 1): Usage limit reached",
    "LANE_RECOVERY_EXHAUSTED k w:p1 dead after 3 recovery attempts",
    "LANE_RECOVERY_BLOCKED k w:p1 dead: claude subscription blocked; not relaunched",
    "LEAD_QUOTA_EXHAUSTED a/x reset=unknown every lead model is blocked on quota (a/x): hit",
    "LEAD_QUOTA_CLEARED a/x the lead has a model with quota again after 30 min",
    "QUOTA_GATE_UNKNOWN Claude usage unreadable (offline); the Claude quota gate is off",
    "WAIT_FAILED release ci green (30 checks in a row failed; no --timeout set)",
    "WAITS_CORRUPT waits.json did not parse and was moved to /x; every wait in it is dropped, register them again",
  ]) expect(eventPriority(line)).toBe("urgent");
});

test("an unreadable gate stays fail-open but reports QUOTA_GATE_UNKNOWN once per episode, for each kind of unknown", async () => {
  const config = { ...defaultConfig("/home/test"), stateDir: state() };
  const clock = fakeClock(NOW);
  let lookup: UsageLookup = async () => { throw new Error("offline"); };
  const last: { at: number; unknown?: string } = { at: -Infinity };
  const tick = async () => {
    const lines = await quiet(() => claudeQuotaTick({ config, clock }, (signal) => lookup(signal), last));
    clock.at += config.quotaGate.pollMin * 60_000;
    return lines;
  };
  expect(await tick()).toEqual(["QUOTA_GATE_UNKNOWN Claude usage unreadable (offline); the Claude quota gate is off (fail-open): lanes launch ungated until usage reads again"]);
  expect(await tick()).toEqual([]);
  lookup = async () => ({ results: [claude(["Five-hour", "Weekly"])], text: "" });
  expect(await tick()).toEqual([]);
  expect(last.unknown).toBeUndefined();
  lookup = async () => ({ results: [claude(["Session", "Opus window"])], text: "" });
  expect(await tick()).toEqual([expect.stringMatching(/^QUOTA_GATE_UNKNOWN pi-quota window labels not recognised \(Session, Opus window\); /)]);
  expect(await tick()).toEqual([]);
  lookup = async () => ({ results: [claude(["Five-hour"])], text: "" });
  await tick();
  lookup = async () => ({ results: [], text: "" });
  expect(await tick()).toEqual([expect.stringMatching(/^QUOTA_GATE_UNKNOWN no Claude subscription usage reported; /)]);
});

test("no configured model on the Claude subscription: an unknown gate is not reported", async () => {
  const config = { ...defaultConfig("/home/test"), stateDir: state(), defaultModel: "openai-codex/gpt-6" };
  const last = { at: -Infinity };
  expect(await quiet(() => claudeQuotaTick({ config, clock: fakeClock(NOW) }, async () => { throw new Error("offline"); }, last))).toEqual([]);
});

test("QUOTA_GATE_UNKNOWN reaches the owner's channel when enqueued, with home paths scrubbed", async () => {
  const dir = state();
  const announced: string[] = [];
  const supervisor = new Supervisor(depsFor(newWorld(), fakeClock(NOW), dir), { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("sweep:1", "QUOTA_GATE_UNKNOWN Claude usage unreadable (offline); the Claude quota gate is off (fail-open)");
  supervisor.enqueue("sweep:2", "CLAUDE_QUOTA ok | Claude 5h 5%");
  await supervisor.reactionsSettled();
  expect(announced).toEqual(["Dori warning: QUOTA_GATE_UNKNOWN Claude usage unreadable (offline); the Claude quota gate is off (fail-open)"]);
});

test("the gate reads every Claude account and adds their headroom; the lead's gate is the same read", async () => {
  const gate = defaultConfig("/home/test").quotaGate;
  const lookup = (...results: QuotaResult[]): UsageLookup => async () => ({ results, text: "" });
  const signal = AbortSignal.timeout(5_000);
  // No reset times: each window counts its quota left over a full window.
  const both = (await readGate(lookup(claude(["Five-hour", "Weekly"], 90, "light"), claude(["Five-hour", "Weekly"], 5, "heavy")), gate, state(), NOW, signal)).claude;
  expect(both?.usage.accounts.map((a) => a.name)).toEqual(["light", "heavy"]);
  expect(both?.verdict).toMatchObject({ mode: "ok", headroomPct: 95 });
  expect((await readGate(lookup(claude(["Five-hour", "Weekly"], 5, "heavy")), gate, state(), NOW, signal)).claude?.verdict.mode).toBe("brief");
});
