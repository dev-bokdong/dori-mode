import { afterEach, beforeEach, expect, test } from "bun:test";

import { freshnessTick } from "../src/freshness.ts";
import { pauseLane } from "../src/pause.ts";
import { laneQuotaTick, paneResetAt, providerQuota, QUOTA_PAUSE_NOTE, type QuotaLane, quotaScreenHit, quotaWaitKey } from "../src/quota-stall.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { Waits } from "../src/waits.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const BLOCKED_LINE = "Error: All Claude accounts for anthropic-subscription are currently blocked";
const RESET = Date.parse("2026-10-22T09:30:00.000Z");
const accounts = (...blocked: boolean[]) => JSON.stringify({ status: "not_ready", accounts: blocked.map((b, i) => ({ name: `a${i}`, blocked: b, ...(b ? { blockedUntil: new Date(RESET + i * 60_000).toISOString() } : {}) })) });

let state: ReturnType<typeof withState>;
let world: World;
let auth: Record<string, string>;
beforeEach(() => { state = withState(); world = newWorld(); auth = {}; });
afterEach(() => state.done());

/** fakeRunner plus omo auth check, and a pane whose goal commands print omo's confirmation lines. */
const runner = (): Runner => {
  const base = fakeRunner(world);
  return async (argv, opts) => {
    if (argv[0] === "omo" && argv[1] === "auth") {
      world.calls.push([...argv]);
      return { code: 1, out: auth[argv[argv.indexOf("--provider") + 1] ?? ""] ?? "", err: "" };
    }
    if (argv[0] === "herdr" && argv[2] === "send-text" && argv[4] === "/goal pause") world.screen += "\nGoal paused\n";
    if (argv[0] === "herdr" && argv[2] === "send-text" && argv[4] === "/goal resume") world.screen += "\nGoal active\n";
    return base(argv, opts);
  };
};
const clock = fakeClock(Date.parse("2026-10-22T07:00:00.000Z"));
const deps = () => ({ ...depsFor(world, clock, state.dir), run: runner() });
const lane: Lane = { key: "quota-lane", title: "q", thread: "chat:1/2", pane: "w:p7", brief: "/b.md", done: "merged a/b#1", cwd: "/repo", openedAt: new Date(0).toISOString() };
const read = async (d: ReturnType<typeof deps>) => (await d.registry.read("quota-lane")) as QuotaLane;

test("items 1+3: a stall pauses the lane, stores the reset from omo auth check, registers a wait at it and names it in the event", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true, true);
  const [event, ...rest] = await laneQuotaTick(d);
  expect(rest).toEqual([]);
  expect(event).toBe(`LANE_QUOTA_STALL quota-lane w:p7 reset=2026-10-22T09:30:00.000Z 2/2 anthropic-subscription accounts blocked: ${BLOCKED_LINE} | PAUSED quota-lane goal paused | wait quota-quota-lane`);
  const stored = await read(d);
  expect(statusOf(stored)).toBe("paused");
  expect(stored).toMatchObject({ quotaAutoPaused: true, quotaResetAt: RESET, quotaWait: "quota-quota-lane", lastQuotaStall: `2/2 anthropic-subscription accounts blocked: ${BLOCKED_LINE}` });
  expect(stored.history?.at(-1)?.note.startsWith(QUOTA_PAUSE_NOTE)).toBe(true);
  const waits = new Waits(state.dir).list();
  expect(waits.map((w) => [w.key, w.until, w.thread, w.cwd])).toEqual([[quotaWaitKey("quota-lane"), `command ["sh","-c","[ $(date +%s) -ge ${RESET / 1000} ]"]`, "chat:1/2", "/repo"]]);
  // Still blocked: the paused lane stays paused and quiet.
  expect(await laneQuotaTick(d)).toEqual([]);
  expect(statusOf(await read(d))).toBe("paused");
});

test("item 3: the reset time falls back to the pane text, and is 'unknown' (no wait) when neither has it", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = "Error: usage limit reached. Try again in 2h 30m\n❯ ";
  auth["anthropic-subscription"] = JSON.stringify({ accounts: [{ name: "a", blocked: true }] });
  const [event] = await laneQuotaTick(d);
  expect(event).toStartWith(`LANE_QUOTA_STALL quota-lane w:p7 reset=${new Date(clock.now() + 150 * 60_000).toISOString()} `);
  expect((await read(d)).quotaResetAt).toBe(clock.now() + 150 * 60_000);
  await d.registry.write(lane);
  new Waits(state.dir).cancel(quotaWaitKey("quota-lane"));
  world.screen = `${BLOCKED_LINE}\n❯ `;
  const [unknown] = await laneQuotaTick(d);
  expect(unknown).toStartWith("LANE_QUOTA_STALL quota-lane w:p7 reset=unknown ");
  expect(unknown).not.toContain("| wait");
  expect(new Waits(state.dir).list()).toEqual([]);
});

test("item 2: when the provider has quota again LANE_QUOTA_CLEARED is sent, the auto-paused lane resumed and its wait cancelled", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true, true);
  await laneQuotaTick(d);
  auth["anthropic-subscription"] = accounts(true, false);
  expect(await laneQuotaTick(d)).toEqual(["LANE_QUOTA_CLEARED quota-lane w:p7 1/2 anthropic-subscription accounts blocked; auto-resumed"]);
  const stored = await read(d);
  expect(statusOf(stored)).toBe("working");
  expect(stored.lastQuotaStall).toBeUndefined();
  expect(stored.quotaAutoPaused).toBeUndefined();
  expect(stored.quotaResetAt).toBeUndefined();
  expect(new Waits(state.dir).list()).toEqual([]);
  expect(await laneQuotaTick(d)).toEqual([]);
});

test("item 2: a lane the owner/lead paused is never resumed by the quota sweep", async () => {
  const d = deps();
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true, true);
  await d.registry.write(lane);
  await laneQuotaTick(d);
  await pauseLane(d, await read(d), "owner said wait");
  expect((await read(d)).quotaAutoPaused).toBeUndefined();
  expect((await read(d)).history?.at(-1)?.note).toBe("owner said wait");
  auth["anthropic-subscription"] = accounts(true, false);
  expect(await laneQuotaTick(d)).toEqual([]);
  expect(statusOf(await read(d))).toBe("paused");
  expect(world.calls.some((c) => c[4] === "/goal resume")).toBe(false);
});

test("an owner pause during quota inspection prevents a stale sweep resume", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true);
  await laneQuotaTick(d);
  auth["anthropic-subscription"] = accounts(false);
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "omo") await pauseLane(d, await read(d), "owner said wait");
    return d.run(argv, opts);
  };
  await laneQuotaTick({ ...d, run });
  expect(statusOf(await read(d))).toBe("paused");
  expect(world.calls.some((c) => c[4] === "/goal resume")).toBe(false);
});

test.each(["stall saved", "pause sent", "pause saved", "unconfirmed pause"] as const)(
  "reconciles pausing after %s", async (point) => {
    const d = deps();
    await d.registry.write(lane);
    world.screen = `${BLOCKED_LINE}\n❯ `;
    auth["anthropic-subscription"] = accounts(true);
    const update = d.registry.update.bind(d.registry);
    let armed = true;
    d.registry.update = async (key, mutate) => {
      const stored = await update(key, mutate);
      if (armed && ((point === "stall saved" && stored?.lastQuotaStall && statusOf(stored) === "working") ||
        (point === "pause saved" && stored && statusOf(stored) === "paused"))) {
        armed = false;
        throw new Error(`crash: ${point}`);
      }
      return stored;
    };
    const run: Runner = async (argv, opts) => {
      if (point === "unconfirmed pause" && argv[4] === "/goal pause") return fakeRunner(world)(argv, opts);
      const result = await d.run(argv, opts);
      if (armed && point === "pause sent" && argv[4] === "/goal pause") {
        armed = false;
        throw new Error("crash: pause sent");
      }
      return result;
    };
    if (point === "unconfirmed pause") await laneQuotaTick({ ...d, run });
    else await expect(laneQuotaTick({ ...d, run })).rejects.toThrow("crash:");
    const restarted = deps();
    // The replay reports the stall: a crash before the event must not leave the lead unaware of the pause.
    expect((await laneQuotaTick(restarted)).filter((line) => line.startsWith("LANE_QUOTA_STALL quota-lane "))).toHaveLength(1);
    expect(statusOf(await read(restarted))).toBe("paused");
    expect((await read(restarted)).quotaAutoPaused).toBe(true);
    expect(new Waits(state.dir).list()).toHaveLength(1);
    auth["anthropic-subscription"] = accounts(false);
    await laneQuotaTick(restarted);
    expect(statusOf(await read(restarted))).toBe("working");
    expect((await read(restarted)).lastQuotaStall).toBeUndefined();
  },
);

test.each(["resume prepared", "resume sent", "resume saved"] as const)(
  "reconciles resuming after %s", async (point) => {
    const d = deps();
    await d.registry.write(lane);
    world.screen = `${BLOCKED_LINE}\n❯ `;
    auth["anthropic-subscription"] = accounts(true);
    await laneQuotaTick(d);
    auth["anthropic-subscription"] = accounts(false);
    const update = d.registry.update.bind(d.registry);
    let armed = true;
    d.registry.update = async (key, mutate) => {
      const stored: QuotaLane | null = await update(key, mutate);
      if (armed && stored && ((point === "resume prepared" && (stored.quotaPending === "resuming" || !stored.lastQuotaStall)) ||
        (point === "resume saved" && statusOf(stored) === "working"))) {
        armed = false;
        throw new Error(`crash: ${point}`);
      }
      return stored;
    };
    const run: Runner = async (argv, opts) => {
      const result = await d.run(argv, opts);
      if (armed && point === "resume sent" && argv[4] === "/goal resume") {
        armed = false;
        throw new Error("crash: resume sent");
      }
      return result;
    };
    await expect(laneQuotaTick({ ...d, run })).rejects.toThrow("crash:");
    if (point === "resume saved") expect((await read(d)).lastQuotaStall).toBeDefined();
    const restarted = deps();
    await laneQuotaTick(restarted);
    expect(statusOf(await read(restarted))).toBe("working");
    expect((await read(restarted)).lastQuotaStall).toBeUndefined();
    expect((await read(restarted)).quotaAutoPaused).toBeUndefined();
    expect((await read(restarted)).quotaPending).toBeUndefined();
    expect(new Waits(state.dir).list()).toEqual([]);
  },
);

test("a pending quota pause ends when the lane can no longer be paused, instead of resending /goal pause forever", async () => {
  const d = deps();
  auth["anthropic-subscription"] = accounts(true);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  await d.registry.write({ ...lane, status: "done-claimed", lastQuotaStall: "stall", quotaAutoPaused: true, quotaPending: "pausing" } as QuotaLane);
  const first = await laneQuotaTick(d);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain("NOT_PAUSED quota-lane");
  expect((await read(d)).quotaPending).toBeUndefined();
  expect(await laneQuotaTick(d)).toEqual([]);
  expect(world.calls.some((c) => c[4] === "/goal pause")).toBe(false);
});

test("a pending quota pause is dropped when the provider has quota again by the replay", async () => {
  const d = deps();
  auth["anthropic-subscription"] = accounts(false);
  await d.registry.write({ ...lane, lastQuotaStall: "stall", quotaAutoPaused: true, quotaPending: "pausing" } as QuotaLane);
  expect(await laneQuotaTick(d)).toEqual([expect.stringMatching(/^LANE_QUOTA_CLEARED quota-lane /)]);
  expect(statusOf(await read(d))).toBe("working");
  expect((await read(d)).quotaPending).toBeUndefined();
  expect(world.calls.some((c) => c[4] === "/goal pause")).toBe(false);
});

test("with a durable enqueue the stall is journaled under a stable id before the pause bookkeeping ends", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true);
  const got: [string, string, string | undefined][] = [];
  const enqueue = async (line: string, id: string) => { got.push([line, id, (await read(d)).quotaPending]); };
  expect(await laneQuotaTick(d, enqueue)).toEqual([]);
  expect(got).toHaveLength(1);
  expect(got[0]?.[0]).toMatch(/^LANE_QUOTA_STALL quota-lane /);
  expect(got[0]?.[2]).toBe("pausing");
  expect((await read(d)).quotaPending).toBeUndefined();
});

test("an unconfirmed quota resume is retried on the next tick", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true);
  await laneQuotaTick(d);
  auth["anthropic-subscription"] = accounts(false);
  await laneQuotaTick({ ...d, run: async (argv, opts) =>
    argv[4] === "/goal resume" ? fakeRunner(world)(argv, opts) : d.run(argv, opts) });
  expect(statusOf(await read(d))).toBe("paused");
  await laneQuotaTick(deps());
  expect(statusOf(await read(d))).toBe("working");
});

test("item 2: a stalled lane whose pause was not confirmed is cleared without a resume", async () => {
  const d = deps();
  await d.registry.write({ ...lane, lastQuotaStall: "old stall" });
  world.screen = "all good now\n❯ ";
  expect(await laneQuotaTick(d)).toEqual(["LANE_QUOTA_CLEARED quota-lane w:p7 no quota failure on the pane"]);
  expect(world.calls.some((c) => c[2] === "send-text")).toBe(false);
});

test("item 4: freshness never nudges or posts for a lane stalled on quota", async () => {
  const d = deps();
  const quiet = { ...lane, openedAt: new Date(60_000).toISOString() };
  const later = { ...d, clock: fakeClock(3 * 3_600_000) };
  await d.registry.write({ ...quiet, lastQuotaStall: "2/2 blocked: x" });
  expect(await freshnessTick(later, "/home/test")).toEqual([]);
  expect(world.calls.some((c) => c[2] === "send-text")).toBe(false);
  await d.registry.write(quiet);
  expect((await freshnessTick(later, "/home/test")).map((act) => act.kind)).toEqual(["nudged"]);
});

test("item 8: unreadable omo auth check output is unknown, logged and reported once, never 'not blocked'", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = "omo: something went wrong";
  const q = await providerQuota(runner(), d.config.quotaCheck, "anthropic-subscription");
  expect(q).toEqual({ blocked: false, unknown: true, detail: "anthropic-subscription quota check unreadable (exit 1)" });
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: string) => { logged.push(line); };
  try {
    expect(await laneQuotaTick(d)).toEqual([`LANE_QUOTA_UNKNOWN quota-lane w:p7 anthropic-subscription quota check unreadable (exit 1): ${BLOCKED_LINE}`]);
    expect(await laneQuotaTick(d)).toEqual([]);
  } finally { console.error = error; }
  expect(logged).toHaveLength(2);
  expect((await read(d)).lastQuotaUnknown).toBe("anthropic-subscription quota check unreadable (exit 1)");
  expect(statusOf(await read(d))).toBe("working");
  // A readable answer again clears the note.
  auth["anthropic-subscription"] = accounts(false);
  expect(await laneQuotaTick(d)).toEqual([]);
  expect((await read(d)).lastQuotaUnknown).toBeUndefined();
});

test("item 8: the relaxed detector finds reworded limit messages mid-line", () => {
  for (const line of [
    "Claude usage limit reached. Your limit will reset at 3pm",
    "✗ 5-hour limit reached ∙ resets 2am",
    "You've hit your usage limit · upgrade or wait",
    "API Error: quota exceeded for this account",
    "anthropic: rate limit has been exceeded. Try again later",
    "429 Too Many Requests",
    "request failed: insufficient_quota",
    "Weekly limit reached",
  ]) expect(quotaScreenHit(`${line}\n❯ `)).toBe(line.replace(/^✗ /, ""));
});

test("item 8: ordinary prose that names the wording is not a quota failure", () => {
  for (const line of [
    "I added quota stall detection; the rate limit wording is in the docs.",
    "Next: handle rate limit exceeded errors in the client",
    "tests cover the quota exceeded case and the usage limit reached handler",
    "Fix: detect `rate limit exceeded` responses",
    "The rate limiter keeps a quota of 5 per user",
    "if the usage limit reached flag is set we back off",
    "see https://example.com/docs/429-errors",
  ]) expect(quotaScreenHit(`${line}\n❯ `)).toBeUndefined();
});

test("item 3: reset times are read from ISO and relative pane wording only", () => {
  expect(paneResetAt("Usage limit reached, resets at 2026-10-22T10:00:00Z\n", 0)).toBe(Date.parse("2026-10-22T10:00:00Z"));
  expect(paneResetAt("rate limit exceeded; retry in 45 minutes\n", 1000)).toBe(1000 + 45 * 60_000);
  expect(paneResetAt("Usage limit reached\n", 0)).toBeUndefined();
});
