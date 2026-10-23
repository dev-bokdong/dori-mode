import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { freshnessTick } from "../src/freshness.ts";
import { acquireSlot, releaseSlot } from "../src/heavy-slot.ts";
import { guardTick } from "../src/host-guard.ts";
import { adoptLane, launchLane, LaunchError } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "quiet-lane", title: "quiet", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("a lane silent past the nudge time is nudged once, then its last report is posted for it", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n❯ ";
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["pending-report"]);
  expect(world.calls.find((c) => c[0] === "notify")).toBeUndefined();
  const posted = await freshnessTick(deps(T0 + 26 * MIN), "/home/test");
  expect(posted.map((a) => a.kind)).toEqual(["posted"]);
  const call = world.calls.find((c) => c[0] === "notify");
  expect(call?.[1]).toBe("chat:team/9");
  expect(call?.[2]).toContain("tests green on ~/repo, PR open");
  expect(sent(world)).toHaveLength(1);
});

test("a stopped agent pane is reported once per hour and the lead pane is never reported", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }, { pane_id: "lead:p1", workspace_id: "lead" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T13", st)).toEqual(["DEAD_PANE w:p1"]);
});

test("a reworded stop message is not dead: with no alive status it is unrecognised, and repeated reads raise one alert", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "the agent process went away\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual(["UNRECOGNISED_PANE w:p1 dead-panes: no alive status and no dead marker for 3 ticks"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
});

test("a pane whose agent status says it is alive is never reported dead, whatever the screen shows", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  world.screen = "grep output: has stopped\n❯ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
});

test("a dead marker that does not hold to the next tick is never dead", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screens = ["omo has stopped\n$ ", "redrawing\n", "omo has stopped\n$ ", "redrawing\n"];
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  for (let i = 0; i < 4; i++) expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
});

test("an alive status resets the unrecognised count, so two unknown ticks on each side of it raise no alert", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "something else\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" };
  expect(await tick()).toEqual([]);
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w" };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
});

test("a posted [REPORT] line is saved: the same line on later ticks is stale, logged once, and never posted again", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastNudgeAt: T0 + MIN });
  world.screen = "[REPORT] quiet-lane | milestone | tests green\n❯ ";
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["pending-report"]);
  expect((await freshnessTick(deps(T0 + 26 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["posted"]);
  const lane = await deps(T0).registry.read("quiet-lane");
  await deps(T0).registry.write({ ...lane!, lastReplyAt: T0 + 30 * MIN, lastNudgeAt: T0 + 31 * MIN });
  expect((await freshnessTick(deps(T0 + 55 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["stale-report"]);
  expect(await freshnessTick(deps(T0 + 60 * MIN), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 65 * MIN), "/home/test")).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("a quiet lane with no [REPORT] line logs NO-REPORT once, not on every tick", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastNudgeAt: T0 + MIN });
  world.screen = "just thinking\n❯ ";
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["no-report"]);
  expect(await freshnessTick(deps(T0 + 26 * MIN), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 31 * MIN), "/home/test")).toEqual([]);
});

test("launch reports STARTUP_OK only on a ready agent status after the screen scan; a blank pane is unconfirmed, a known failure is an error", async () => {
  const brief = join(state.dir, "brief.md");
  const run = async (status: string | undefined, screen: string, key: string) => {
    writeFileSync(brief, "# brief\n");
    world = newWorld();
    world.screen = screen;
    const base = depsFor(world, fakeClock(T0), state.dir);
    const inner = base.run;
    const deps = { ...base, run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w:p9", workspace_id: "w", ...(status ? { agent: "pi", agent_status: status } : {}) }] } }), err: "" };
      return inner(argv);
    } };
    return (await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3", cwd: state.dir })).startup;
  };
  expect(await run("idle", "❯ ", "ok-lane")).toBe("STARTUP_OK ok-lane w:p9");
  expect(await run(undefined, "", "blank-lane")).toStartWith("STARTUP_UNCONFIRMED blank-lane w:p9");
  expect(await run(undefined, "Error: provider refused the key\n$ ", "worded-lane")).toStartWith("STARTUP_UNCONFIRMED worded-lane w:p9");
  expect(await run("blocked", "No API key found\n❯ ", "err-lane")).toBe("STARTUP_ERROR err-lane w:p9: No API key");
  // An idle agent that printed a failure and stopped at its prompt never started the work.
  expect(await run("idle", "No API key found\n❯ ", "idle-err-lane")).toBe("STARTUP_ERROR idle-err-lane w:p9: No API key");
  // A working agent has started its task, whatever older screen text says.
  expect(await run("working", "No API key found\n❯ ", "live-lane")).toBe("STARTUP_OK live-lane w:p9");
  expect(await run("blocked", "❯ ", "blocked-lane")).toStartWith("STARTUP_UNCONFIRMED blocked-lane w:p9");
  expect(await run("done", "❯ ", "done-lane")).toStartWith("STARTUP_UNCONFIRMED done-lane w:p9");
});

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot({ ...base, alive: (pid) => pid !== 999999, clock: { ...clock, sleep: async () => { polls++; } } }, "test");
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { polls++; if (polls > 2) throw new Error("stop"); } };
  await expect(acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1)).rejects.toThrow("stop");
});

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" })).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" });
  expect(ok.thread).toBe("none");
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" })).rejects.toThrow("already registered");
});

test("the session id is read from --session, then a child's environment, then the session file made at start", async () => {
  const info = JSON.stringify({ result: { process_info: { shell_pid: 10 } } });
  const fake = (extra: Record<string, string>) => async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.startsWith("herdr pane process-info")) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };
  const table = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin" }, { pid: 12, ppid: 11, cmd: "bun /x/mcp/cli.js mcp" }];
  const flagged = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" }];
  expect((await resolveSession("w:p1", "/repo", flagged, { run: fake({}), sessionsDir: "/s" })).via).toBe("argv");
  expect((await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww -o command= -p 12": "bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf X=1" }), sessionsDir: "/s" })).id).toBe("01a11440-ee81-7f90-b2ed-dcc7d51a0adf");
  const listDir = () => ["2026-01-01T09-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl", "2026-01-01T12-00-02-113Z_01a11440-ee81-7f90-b2ed-dcc7d51a0adf.jsonl"];
  const byStart = await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww": "bun mcp X=1", "ps -o lstart=": "Thu Jan  1 12:00:01 2026 GMT" }), sessionsDir: "/s", listDir });
  expect(byStart).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "start-time", pid: 11 });
});
