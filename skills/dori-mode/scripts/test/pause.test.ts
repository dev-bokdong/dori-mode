import { afterEach, beforeEach, expect, test } from "bun:test";

import { freshnessTick } from "../src/freshness.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

// Issue #11: telling Dori to wait must stick. One paused state silences the freshness sweep and pauses the goal,
// and the lane is marked paused only once the pane shows the goal paused.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent_status: "idle" }];
  // Escape stops a running turn, unless a test says otherwise.
  world.onEscapeStatus = "idle";
});
afterEach(() => state.done());

const working: Lane = { key: "waiting-lane", title: "wait", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
const stored = async (): Promise<Lane | null> => deps(T0).registry.read(working.key);
const paneSays = (...screens: string[]) => {
  world.screens = [...screens];
};
const paneStatus = (status: string) => {
  for (const pane of world.panes) pane.agent_status = status;
};
const escapes = () => world.calls.filter((c) => c[2] === "send-keys" && c[4] === "escape");
/** A sweep tick that finds the paused lane woken (a monitor event, a background result) and working. */
const wokenTick = async (at: number) => {
  paneStatus("working");
  return freshnessTick(deps(T0 + at * MIN), "/home/test");
};

test("a paused lane silent past the nudge and post times is neither nudged nor posted", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  world.screen = "[REPORT] waiting-lane | milestone | halfway\n❯ ";
  for (const at of [16, 21, 26, 120]) expect(await freshnessTick(deps(T0 + at * MIN), "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(world.calls.find((c) => c[0] === "notify")).toBeUndefined();
});

test("pause marks the lane paused only once the pane shows the goal paused, then stops the running turn", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  paneSays("❯ ", "❯ ", "Goal paused\nObjective: ship it\n❯ ");

  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");

  expect(r.code).toBe(0);
  expect(r.lines[0]).toBe("PAUSED waiting-lane goal paused, running turn interrupted");
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect(lane?.history?.at(-1)).toMatchObject({ status: "paused", note: "owner said wait" });
  expect(sent(world)).toEqual(["/goal pause"]);
  const goalAt = world.calls.findIndex((c) => c[2] === "send-text");
  const escAt = world.calls.findIndex((c) => c[2] === "send-keys" && c[4] === "escape");
  expect(escAt).toBeGreaterThan(goalAt);
  expect((await pauseLane(deps(T0 + 2 * MIN), lane as Lane, "again")).lines[0]).toBe("PAUSED waiting-lane already");
});

test("an unconfirmed goal pause leaves the lane working, interrupts nothing, and exits 3", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  world.screen = "still thinking\n❯ ";

  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");

  expect(r.code).toBe(3);
  expect(r.lines[0]).toBe("PAUSE_UNVERIFIED waiting-lane /goal pause unconfirmed; lane left working");
  expect(statusOf((await stored()) as Lane)).toBe("working");
  expect(escapes()).toEqual([]);
});

test("a lane with no goal pauses: nothing can auto-continue, and an idle pane gets no Escape", async () => {
  await deps(T0).registry.write(working);
  paneSays("❯ ", "cannot update goal: no goal exists\n❯ ");

  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");

  expect(r).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane goal paused"] });
  expect(escapes()).toEqual([]);
});

test("the no-goal reply with omo's Error: prefix confirms pause and resume, an unrelated error line does not (issue #23)", async () => {
  await deps(T0).registry.write(working);
  paneSays("❯ ", " Error: cannot update goal: no goal exists\n❯ ");
  const paused = await pauseLane(deps(T0 + MIN), working, "owner said wait");
  expect(paused).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane goal paused"] });

  paneSays("❯ ", " Error: cannot update goal: no goal exists\n❯ ");
  expect(await resumeLane(deps(T0 + 2 * MIN), paused.lane, "go")).toMatchObject({ code: 0, lines: ["RESUMED waiting-lane as working, goal resumed"] });

  world.screens = [];
  world.screen = "Error: something else failed\nError: Goal paused\n❯ ";
  const r = await pauseLane(deps(T0 + 3 * MIN), (await stored()) as Lane, "again");
  expect(r).toMatchObject({ code: 3, lines: ["PAUSE_UNVERIFIED waiting-lane /goal pause unconfirmed; lane left working"] });
});

test("a not-done lane can be paused, and resume restores not-done and restarts the quiet clock", async () => {
  const notDone: Lane = { ...working, status: "not-done" };
  await deps(T0).registry.write(notDone);
  paneSays("❯ ", "Goal paused\n❯ ");
  const paused = (await pauseLane(deps(T0 + MIN), notDone, "wait")).lane;
  expect(statusOf(paused)).toBe("paused");

  paneSays("Goal paused\n❯ ", "Goal active\n❯ ");
  const r = await resumeLane(deps(T0 + 90 * MIN), paused, "owner said go");

  expect(r).toMatchObject({ code: 0, lines: ["RESUMED waiting-lane as not-done, goal resumed"] });
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("not-done");
  expect(lane?.lastReplyAt).toBe(T0 + 90 * MIN);
  expect(sent(world)).toEqual(["/goal pause", "/goal resume"]);
});

test("an owner pause during a resume's goal command is not blocked by the lane lock: it wins and the goal is paused again", async () => {
  await deps(T0).registry.write({ ...working, status: "paused", history: [{ at: new Date(T0).toISOString(), status: "paused", note: "wait" }] });
  const d = deps(T0 + MIN);
  let owner: Awaited<ReturnType<typeof pauseLane>> | undefined;
  const run: Runner = async (argv, opts) => {
    const result = await d.run(argv, opts);
    if (argv[2] === "send-text" && argv[4] === "/goal resume") {
      world.screen += "\nGoal active\n";
      owner = await pauseLane({ ...d, run }, (await stored()) as Lane, "owner said wait");
    }
    if (argv[2] === "send-text" && argv[4] === "/goal pause") world.screen += "\nGoal paused\n";
    return result;
  };
  const r = await resumeLane({ ...d, run }, (await stored()) as Lane, "go");
  expect(owner?.code).toBe(0);
  expect(r.code).toBe(2);
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect(lane?.history?.at(-1)?.note).toBe("owner said wait");
  // The owner's pause stops the goal itself, and the resumer pauses it again on its commit.
  expect(owner?.lines).toEqual(["PAUSED waiting-lane already; a resume in flight was stopped, goal paused"]);
  expect(sent(world)).toEqual(["/goal resume", "/goal pause", "/goal pause"]);
});

test("an owner pause after a resumer died between /goal resume and its commit pauses the goal itself", async () => {
  // The crashed resume left its claim; its /goal resume already ran, so the goal is active while the lane reads paused.
  await deps(T0).registry.write({ ...working, status: "paused", resuming: "crashed-resume", history: [{ at: new Date(T0).toISOString(), status: "paused", note: "wait" }] } as Lane);
  paneSays("Goal active\n❯ ", "Goal active\n❯ ", "Goal active\nGoal paused\n❯ ");
  const r = await pauseLane(deps(T0 + MIN), (await stored()) as Lane, "owner said wait");
  expect(r).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane already; a resume in flight was stopped, goal paused"] });
  expect(sent(world)).toEqual(["/goal pause"]);
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect((lane as Lane & { resuming?: string }).resuming).toBeUndefined();
  // A plain repeat pause with no resume in flight stays a no-op on the pane.
  expect((await pauseLane(deps(T0 + 2 * MIN), lane as Lane, "again")).lines).toEqual(["PAUSED waiting-lane already"]);
  expect(sent(world)).toEqual(["/goal pause"]);
});

test("resume of a working lane restarts the quiet clock: no nudge until nudgeAfterMin after the resume", async () => {
  const paused: Lane = { ...working, status: "paused", history: [{ at: new Date(T0).toISOString(), status: "paused", note: "wait" }] };
  await deps(T0).registry.write(paused);
  paneSays("❯ ", "Goal active\n❯ ");
  await resumeLane(deps(T0 + 90 * MIN), paused, "go");
  expect(statusOf((await stored()) as Lane)).toBe("working");
  world.screens = [];
  expect(await freshnessTick(deps(T0 + 95 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 106 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
});

test("a lane paused mid-turn (Escape) and then woken stays paused: resume is dori resume only, whatever the screen shows", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  paneSays("❯ ", "Goal paused\n❯ ");
  await pauseLane(deps(T0 + MIN), working, "owner said wait");
  expect(escapes()).toHaveLength(1);
  // Woken afterwards (a background result), still running on two ticks, even with a goal line that reads active.
  world.screens = [];
  world.screen = "Goal active\nworking on the background result\n";
  expect(await wokenTick(5)).toEqual([]);
  const second = await wokenTick(10);
  expect(second.map((a) => a.kind)).toEqual(["working-while-paused"]);
  expect(await freshnessTick(deps(T0 + 15 * MIN), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 60 * MIN), "/home/test")).toEqual([]);
  const lane = await stored();
  expect(lane && statusOf(lane)).toBe("paused");
  expect(sent(world).filter((text) => text.startsWith("[LEAD]"))).toEqual([]);
});

test("one working tick between idle ones does not count as a resume", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  paneStatus("working");
  await freshnessTick(deps(T0 + 5 * MIN), "/home/test");
  paneStatus("idle");
  await freshnessTick(deps(T0 + 10 * MIN), "/home/test");
  paneStatus("working");
  expect(await freshnessTick(deps(T0 + 15 * MIN), "/home/test")).toEqual([]);
  expect(statusOf((await stored()) as Lane)).toBe("paused");
});

test("pause and resume refuse lanes in other states with exit 2, and a lane with no pane is unverified", async () => {
  const claimed: Lane = { ...working, status: "done-claimed" };
  expect(await pauseLane(deps(T0), claimed, "wait")).toMatchObject({ code: 2, lines: ["NOT_PAUSED waiting-lane is done-claimed, not working"] });
  expect(await resumeLane(deps(T0), working, "go")).toMatchObject({ code: 2, lines: ["NOT_RESUMED waiting-lane is working, not paused"] });
  const paneless: Lane = { ...working, pane: undefined };
  expect((await pauseLane(deps(T0), paneless, "wait")).code).toBe(3);
  expect(sent(world)).toEqual([]);
});

test("every wake of a paused lane is reported, across a resume and a second pause", async () => {
  await deps(T0).registry.write(working);
  paneSays("❯ ", "Goal paused\n❯ ");
  let lane = (await pauseLane(deps(T0 + MIN), working, "wait")).lane;
  await wokenTick(5);
  expect((await wokenTick(10)).map((a) => a.kind)).toEqual(["working-while-paused"]);
  paneStatus("idle");
  paneSays("❯ ", "Goal active\n❯ ");
  lane = (await resumeLane(deps(T0 + 11 * MIN), (await stored()) as Lane, "go")).lane;
  paneSays("❯ ", "Goal paused\n❯ ");
  await pauseLane(deps(T0 + 12 * MIN), lane, "wait again");
  world.screens = [];
  await wokenTick(15);
  expect((await wokenTick(20)).map((a) => a.kind)).toEqual(["working-while-paused"]);
});

test("a paused lane that goes idle and is woken again is reported again", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  // Escape does not stop it here, so it reads working on every tick: reported once per working stretch.
  world.onEscapeStatus = undefined;
  paneStatus("working");
  expect((await freshnessTick(deps(T0 + 5 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["working-while-paused"]);
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  paneStatus("idle");
  await freshnessTick(deps(T0 + 20 * MIN), "/home/test");
  paneStatus("working");
  expect((await freshnessTick(deps(T0 + 25 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["working-while-paused"]);
  expect(statusOf((await stored()) as Lane)).toBe("paused");
});


// Issue #232: a paused lane woken by a monitor it armed before the pause merged a PR while the sweep only reported it.
test("a paused lane woken by a background event is interrupted on every sweep and stays idle until resume", async () => {
  paneStatus("working");
  await deps(T0).registry.write(working);
  paneSays("❯ ", "Goal paused\n❯ ");
  expect((await pauseLane(deps(T0 + MIN), working, "owner said wait")).lines).toEqual(["PAUSED waiting-lane goal paused, running turn interrupted"]);
  world.screens = [];
  // A monitor event wakes the idle session: the next sweep stops the turn at once, without waiting for a second tick.
  expect(await wokenTick(3)).toEqual([]);
  expect(escapes()).toHaveLength(2);
  for (const at of [4, 5, 6]) {
    expect(await freshnessTick(deps(T0 + at * MIN), "/home/test")).toEqual([]);
    expect(world.panes[0]?.agent_status).toBe("idle");
  }
  // Woken again on the next tick as well: interrupted again and escalated to the lead.
  await wokenTick(7);
  const again = await wokenTick(8);
  expect(again).toEqual([{ kind: "working-while-paused", lane: "waiting-lane", detail: "paused lane was woken and is working; re-interrupted, its turn stopped; left paused (resume is dori resume only)" }]);
  expect(escapes()).toHaveLength(4);
  expect(world.panes[0]?.agent_status).toBe("idle");
  expect(statusOf((await stored()) as Lane)).toBe("paused");
  expect(sent(world)).toEqual(["/goal pause"]);
});

test("a paused lane whose turn Escape cannot stop is escalated on the first tick as PAUSE_UNVERIFIED", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  world.onEscapeStatus = undefined;
  paneStatus("working");
  expect(await freshnessTick(deps(T0 + 5 * MIN), "/home/test")).toEqual([{ kind: "working-while-paused", lane: "waiting-lane", detail: "paused lane was woken and is working; PAUSE_UNVERIFIED: Escape did not stop its turn; left paused (resume is dori resume only)" }]);
  expect(statusOf((await stored()) as Lane)).toBe("paused");
});

test("pause is unverified (exit 3) when Escape does not stop the running turn; the paused goal keeps the lane paused", async () => {
  world.onEscapeStatus = undefined;
  paneStatus("working");
  await deps(T0).registry.write(working);
  paneSays("❯ ", "Goal paused\n❯ ");
  const r = await pauseLane(deps(T0 + MIN), working, "owner said wait");
  expect(r).toMatchObject({ code: 3, lines: ["PAUSE_UNVERIFIED waiting-lane goal paused, but its running turn did not stop after Escape; lane left paused"] });
  expect(statusOf((await stored()) as Lane)).toBe("paused");
  // A retry stops the turn once Escape takes.
  world.onEscapeStatus = "idle";
  expect(await pauseLane(deps(T0 + 2 * MIN), (await stored()) as Lane, "again")).toMatchObject({ code: 0, lines: ["PAUSED waiting-lane already; its running turn was interrupted again"] });
  expect(world.panes[0]?.agent_status).toBe("idle");
  expect(sent(world)).toEqual(["/goal pause"]);
});
