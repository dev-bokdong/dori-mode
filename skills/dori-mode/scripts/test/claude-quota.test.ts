import { afterEach, expect, test } from "bun:test";

import { claudeQuotaTick, claudeUsage, gateLine, gateVerdict, launchQuotaHold, quotaReport, readQuotaState, writeQuotaState, type QuotaResult, type QuotaState, type UsageLookup } from "../src/claude-quota.ts";
import { defaultConfig } from "../src/config.ts";
import { fakeClock, withState } from "./fakes.ts";

const NOW = Date.parse("2026-10-22T03:00:00.000Z");
const RESET_5H = Date.parse("2026-10-22T06:10:00.000Z"); // 15:10 KST
const RESET_7D = Date.parse("2026-10-23T13:00:00.000Z"); // 10-23 22:00 KST
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const claude = (fiveLeft: number, weekLeft: number, extra: Partial<QuotaResult> = {}): QuotaResult => ({
  kind: "success", provider: "claude-sdk-oauth",
  windows: [{ label: "Five-hour", remainingPercent: fiveLeft, resetAt: new Date(RESET_5H) }, { label: "Weekly", remainingPercent: weekLeft, resetAt: new Date(RESET_7D) }],
  ...extra,
});
const openai: QuotaResult = { kind: "success", provider: "openai-codex", windows: [{ label: "Weekly", remainingPercent: 1 }] };
const lookupOf = (...results: QuotaResult[]): UsageLookup => async () => ({ results, text: "pi-quota text" });
const config = () => {
  const state = withState();
  cleanups.push(state.done);
  return { ...defaultConfig("/home/test"), stateDir: state.dir };
};

test("Claude usage keeps every Claude account that answered; other providers and failed reads are ignored", () => {
  const results = [openai, { kind: "unavailable", provider: "anthropic" }, claude(10, 50, { account: "a" }), claude(60, 80, { account: "b" })];
  expect(claudeUsage(results, NOW)).toEqual({ at: NOW, accounts: [
    { name: "a", fiveHour: { usedPct: 90, resetAt: RESET_5H }, weekly: { usedPct: 50, resetAt: RESET_7D } },
    { name: "b", fiveHour: { usedPct: 40, resetAt: RESET_5H }, weekly: { usedPct: 20, resetAt: RESET_7D } },
  ] });
  expect(claudeUsage([openai], NOW)).toBeUndefined();
});

const MIN = 60_000;
/** One account's window: `left` percent of quota left, resetting in `inMin` minutes (undefined: unknown). */
const win = (left: number, inMin?: number) => ({ usedPct: 100 - left, ...(inMin !== undefined ? { resetAt: NOW + inMin * MIN } : {}) });
const verdict = (...accounts: { name: string; fiveHour?: ReturnType<typeof win>; weekly?: ReturnType<typeof win> }[]) =>
  gateVerdict({ at: NOW, accounts }, defaultConfig().quotaGate);

test("a window's headroom is quota left over time left: 20% left with 1h of the 5h window to run is 100%, on pace", () => {
  expect(verdict({ name: "a", fiveHour: win(20, 60) })).toEqual({
    mode: "ok", reasons: [], holdsLanes: false, headroomPct: 100, holdLanesPct: 50, briefPct: 25,
    accounts: [{ name: "a", headroomPct: 100, windows: [{ window: "5h", leftPct: 20, timeLeftPct: 20, headroomPct: 100, resetAt: NOW + 60 * MIN }] }],
  });
  // The same 20% with half the window to run is 40%: lanes wait until the reset.
  expect(verdict({ name: "a", fiveHour: win(20, 150) })).toMatchObject({
    mode: "hold-lanes", holdsLanes: true, headroomPct: 40, resetAt: NOW + 150 * MIN, reasons: ["Claude headroom 40% < 50% (a 40% by 5h)"],
  });
  expect(verdict({ name: "a", fiveHour: win(10, 150) })).toMatchObject({ mode: "brief", headroomPct: 20, reasons: ["Claude headroom 20% < 25% (a 20% by 5h)"] });
  // The 7d window runs on its own length: 30% left with 1 of 7 days to run is 210%.
  expect(Math.round(verdict({ name: "a", weekly: win(30, 24 * 60) }).headroomPct)).toBe(210);
});

test("near a reset the last quota stays usable: 10% left with 10 minutes to run is not held", () => {
  expect(verdict({ name: "a", fiveHour: win(10, 10) })).toMatchObject({ mode: "ok", holdsLanes: false, headroomPct: 300 });
  // Capped at 1000%, also for a reset already past at read time.
  expect(verdict({ name: "a", fiveHour: win(5, 1) }).headroomPct).toBe(1000);
  expect(verdict({ name: "a", fiveHour: win(5, -2) }).accounts[0]?.windows[0]).toMatchObject({ timeLeftPct: 0, headroomPct: 1000 });
  // A window used up stays blocked until it resets, however near that is.
  expect(verdict({ name: "a", fiveHour: win(0, 5) })).toMatchObject({ mode: "blocked", headroomPct: 0, resetAt: NOW + 5 * MIN });
  // An unknown reset time counts as a full window to run.
  expect(verdict({ name: "a", fiveHour: win(30) })).toMatchObject({ mode: "hold-lanes", headroomPct: 30 });
  expect(verdict({ name: "a", fiveHour: win(30) }).resetAt).toBeUndefined();
});

test("two accounts add up, each counted by its tightest window", () => {
  // 100% (20:20) plus 20% (10% left, half the window to run): 120%, ok, though the second alone would be brief.
  expect(verdict({ name: "a", fiveHour: win(20, 60) }, { name: "b", fiveHour: win(10, 150) })).toMatchObject({ mode: "ok", headroomPct: 120 });
  expect(verdict({ name: "b", fiveHour: win(10, 150) }).mode).toBe("brief");
  // a is fresh on 5h but nearly out on 7d, b the other way round: each gives only its tight window (10% each).
  const v = verdict(
    { name: "a", fiveHour: win(100, 300), weekly: win(5, 3.5 * 24 * 60) },
    { name: "b", fiveHour: win(5, 150), weekly: win(100, 7 * 24 * 60) },
  );
  expect(v).toMatchObject({ mode: "brief", headroomPct: 20, reasons: ["Claude headroom 20% < 25% (a 10% by 7d, b 10% by 5h)"] });
  expect(v.accounts.map((a) => a.headroomPct)).toEqual([10, 10]);
  // It clears when the first account's tight windows have reset (b's 5h, before a's 7d).
  expect(v.resetAt).toBe(NOW + 150 * MIN);
});

test("an account with a window used up adds nothing; blocked only once every account has one", () => {
  expect(verdict({ name: "a", fiveHour: win(0, 30), weekly: win(80, 3 * 24 * 60) }, { name: "b", fiveHour: win(30, 150) }))
    .toMatchObject({ mode: "ok", headroomPct: 60, accounts: [{ name: "a", headroomPct: 0 }, { name: "b", headroomPct: 60 }] });
  expect(verdict({ name: "a", fiveHour: win(0, 30) }, { name: "b", fiveHour: win(10, 150) })).toMatchObject({ mode: "brief", headroomPct: 20 });
  expect(verdict({ name: "a", fiveHour: win(0, 30) }, { name: "b", fiveHour: win(50, 150), weekly: win(0, 2 * 24 * 60) })).toEqual(expect.objectContaining({
    mode: "blocked", holdsLanes: true, headroomPct: 0, resetAt: NOW + 30 * MIN,
    reasons: ["every Claude account has a window used up (a 0% by 5h, b 0% by 7d)"],
  }));
});

test("a launch on a Claude model is held with the headroom reason and KST reset; other models and unreadable usage go ahead", async () => {
  const c = config();
  const warned: string[] = [];
  const warn = (line: string) => { warned.push(line); };
  // 15% left with 190 of 300 minutes to run: 24%.
  expect(await launchQuotaHold(c, lookupOf(claude(15, 50)), "anthropic-subscription/claude-opus-5-5", NOW, warn))
    .toBe("quota brief: Claude headroom 24% < 25% (claude-sdk-oauth 24% by 5h), resets 10-22 15:10 KST");
  expect(readQuotaState(c.stateDir)).toMatchObject({ mode: "brief", holdsLanes: true });
  expect(await launchQuotaHold(c, lookupOf(claude(15, 50)), "chatgpt-subscription/gpt-6-astra", NOW, warn)).toBeUndefined();
  // The second account lifts the same first account over the line.
  expect(await launchQuotaHold(c, lookupOf(claude(15, 50, { account: "a" }), claude(90, 90, { account: "b" })), "anthropic-subscription/claude-opus-5-5", NOW, warn)).toBeUndefined();
  expect(readQuotaState(c.stateDir)).toMatchObject({ mode: "ok", holdsLanes: false });
  expect(warned).toEqual([]);
  expect(await launchQuotaHold(c, async () => { throw new Error("offline"); }, "anthropic-subscription/claude-opus-5-5", NOW, warn)).toBeUndefined();
  expect(await launchQuotaHold(c, lookupOf(openai), "claude-opus-5-5", NOW, warn)).toBeUndefined();
  expect(warned).toEqual([
    "QUOTA_WARN Claude usage unreadable (offline); launch not gated",
    "QUOTA unknown | no Claude subscription usage reported; launch not gated",
  ]);
});

test("a state file from the fixed-percent gate is ignored until the next read", () => {
  const c = config();
  writeQuotaState(c.stateDir, { mode: "brief", usage: { at: NOW, fiveHour: { usedPct: 93 } } } as unknown as QuotaState);
  expect(readQuotaState(c.stateDir)).toBeUndefined();
});

test("the Discord /quota reply is pi-quota's own block with no QUOTA line, with or without a Claude account", async () => {
  const c = config();
  for (const results of [[claude(15, 50)], [openai]]) {
    const report = quotaReport(lookupOf(...results), () => c.quotaGate, c.stateDir, () => NOW);
    expect(await report(AbortSignal.timeout(5_000))).toBe("pi-quota text");
  }
});

test("the dori quota line names every account with each window's quota left, time left and headroom", () => {
  const v = gateVerdict(claudeUsage([claude(15, 50, { account: "a" }), claude(90, 90, { account: "b" })], NOW) ?? { at: NOW, accounts: [] }, defaultConfig().quotaGate);
  expect(gateLine(v)).toBe("QUOTA ok | Claude headroom 166% (hold-lanes < 50%, brief < 25%)"
    + " | a 24%: 5h 15% left / 63% time = 24% (resets 10-22 15:10 KST), 7d 50% left / 20% time = 247% (resets 10-23 22:00 KST)"
    + " | b 142%: 5h 90% left / 63% time = 142% (resets 10-22 15:10 KST), 7d 90% left / 20% time = 445% (resets 10-23 22:00 KST)");
});

test("the usage sweep reads every pollMin and queues one CLAUDE_QUOTA line per mode change; a quiet first ok", async () => {
  const c = config();
  const clock = fakeClock(NOW);
  let left = [90, 90];
  const lookup: UsageLookup = async () => ({ results: [claude(left[0] ?? 0, left[1] ?? 0)], text: "" });
  const last: { at: number } = { at: -Infinity };
  const tick = () => claudeQuotaTick({ config: c, clock }, lookup, last);
  expect(await tick()).toEqual([]);
  left = [5, 90];
  expect(await tick()).toEqual([]);
  clock.at += c.quotaGate.pollMin * 60_000;
  const [line, ...more] = await tick();
  expect(more).toEqual([]);
  expect(line).toStartWith("CLAUDE_QUOTA brief | Claude headroom 8% (hold-lanes < 50%, brief < 25%); clears 10-22 15:10 KST | claude-sdk-oauth 8%: 5h 5% left / 62% time = 8%");
  expect(line).toEndWith("; answer briefly or decline new work with the reset time; no new lanes");
  clock.at += c.quotaGate.pollMin * 60_000;
  expect(await tick()).toEqual([]);
  left = [70, 90];
  clock.at += c.quotaGate.pollMin * 60_000;
  expect(await tick()).toEqual([expect.stringMatching(/^CLAUDE_QUOTA ok \| .*; normal work; held lanes may launch again$/)]);
});
