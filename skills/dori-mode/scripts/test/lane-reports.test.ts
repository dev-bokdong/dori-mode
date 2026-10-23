import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { eventClass } from "../src/event-policy.ts";
import { JsonLaneReports, type LaneReportStore, leadPaneViolationTick, routeReports, SqliteLaneReports } from "../src/lane-reports.ts";
import { footer, launchLane } from "../src/launch.ts";
import { watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// The CLI cases spawn `bun src/cli.ts`; a loaded full run on a small host needs more than bun's default 5 s per test.
setDefaultTimeout(30_000);

const T0 = Date.parse("2026-01-01T12:00:00Z");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const stateDir = (): string => {
  const state = withState();
  cleanups.push(state.done);
  return state.dir;
};

/** Both stores, whichever store the suite runs on: rows must behave the same on each. */
const STORES: readonly (readonly [string, (dir: string) => LaneReportStore])[] = [
  ["json", (dir) => new JsonLaneReports(dir)],
  ["sqlite", (dir) => {
    new SqliteStore(join(dir, SQLITE_FILE), { create: true }).close();
    return new SqliteLaneReports(join(dir, SQLITE_FILE));
  }],
];

const lane = (dir: string, patch: Partial<Lane> = {}): Lane => ({
  key: "local-lane", title: "t", thread: "discord:1/2", pane: "w:p7", brief: join(dir, "brief.md"), done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(), ...patch,
});

test.each(STORES)("%s store: seq counts up per lane, ids carry (lane, generation, seq), and a consumed row leaves pending", (_name, open) => {
  const store = open(stateDir());
  cleanups.push(() => { store.close(); });
  const a1 = store.append({ lane: "lane-a", generation: 0, kind: "progress", text: "step 1", at: T0 });
  const b1 = store.append({ lane: "lane-b", generation: 0, kind: "question", text: "which base?", evidence: "PR #4", at: T0 + 1 });
  const a2 = store.append({ lane: "lane-a", generation: 0, kind: "blocked", text: "CI down", at: T0 + 2 });
  expect([a1.seq, b1.seq, a2.seq]).toEqual([1, 1, 2]);
  expect([a1.id, b1.id, a2.id]).toEqual(["lane-a:0:1", "lane-b:0:1", "lane-a:0:2"]);
  expect(store.pending().map((r) => r.id)).toEqual(["lane-a:0:1", "lane-b:0:1", "lane-a:0:2"]);
  store.consume("lane-a:0:1", T0 + 3, "thread");
  // A second consume of the same row keeps the first route.
  store.consume("lane-a:0:1", T0 + 4, "journal");
  expect(store.pending().map((r) => r.id)).toEqual(["lane-b:0:1", "lane-a:0:2"]);
  expect(store.list({ lane: "lane-a" })).toEqual([
    { id: "lane-a:0:1", lane: "lane-a", generation: 0, seq: 1, kind: "progress", text: "step 1", at: T0, consumedAt: T0 + 3, route: "thread" },
    { id: "lane-a:0:2", lane: "lane-a", generation: 0, seq: 2, kind: "blocked", text: "CI down", at: T0 + 2 },
  ]);
  expect(store.list({ lane: "lane-b" })[0]?.evidence).toBe("PR #4");
});

test.each(STORES)("%s store: rows written by another connection (a lane's CLI) are read by the supervisor's", (_name, open) => {
  const dir = stateDir();
  const supervisor = open(dir);
  const cli = open(dir);
  cleanups.push(() => { supervisor.close(); cli.close(); });
  cli.append({ lane: "lane-a", generation: 0, kind: "question", text: "q1", at: T0 });
  cli.append({ lane: "lane-a", generation: 0, kind: "question", text: "q2", at: T0 });
  expect(supervisor.pending().map((r) => r.seq)).toEqual([1, 2]);
});

test("routing: progress posts to the lane's thread, done is the lane's claim, a closed lane's row is dropped; each row once", async () => {
  const dir = stateDir();
  const world = newWorld();
  const posts: (readonly string[])[] = [];
  const base = depsFor(world, fakeClock(T0), dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const deps = { ...base, run: async (argv: readonly string[]) => { if (argv[0] === "notify") posts.push(argv); return base.run(argv); } };
  await deps.registry.write(lane(dir));
  await deps.registry.write(lane(dir, { key: "gone-lane", closedAt: new Date(T0).toISOString() }));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "tests green in /home/test/repo", at: T0 });
  store.append({ lane: "gone-lane", generation: 0, kind: "question", text: "still there?", at: T0 });
  store.append({ lane: "local-lane", generation: 0, kind: "done", text: "merged", evidence: "merged acme/app#3 abc123", at: T0 + 1 });
  const journal: [string, string][] = [];
  const enqueue = (id: string, line: string) => { journal.push([id, line]); };
  expect(await routeReports(deps, store, enqueue, "/home/test")).toEqual([
    "LANE_REPORT_ROUTED gone-lane:0:1 question dropped",
    "LANE_REPORT_ROUTED local-lane:0:1 progress thread",
    "LANE_REPORT_ROUTED local-lane:0:2 done claim",
  ]);
  expect(posts).toEqual([["notify", "discord:1/2", "tests green in ~/repo"]]);
  expect(journal).toEqual([]);
  const claimed = await deps.registry.read("local-lane");
  expect(claimed && statusOf(claimed)).toBe("done-claimed");
  expect(claimed?.claim?.evidence).toBe("merged acme/app#3 abc123");
  expect(await routeReports(deps, store, enqueue, "/home/test")).toEqual([]);
  expect(posts).toHaveLength(1);
});

test("routing: progress with no thread hook, or a failing one, reaches the lead as a digest LANE_REPORT instead of being lost", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir, { hooks: { threadReply: ["false-hook", "{text}"] } });
  await deps.registry.write(lane(dir));
  const store = new JsonLaneReports(dir);
  store.append({ lane: "local-lane", generation: 0, kind: "progress", text: "half way", at: T0 });
  const journal: [string, string][] = [];
  await routeReports(deps, store, (id, line) => { journal.push([id, line]); });
  expect(journal).toEqual([["lane-report:local-lane:0:1", "LANE_REPORT local-lane progress half way (thread post failed: unexpected false-hook half way)"]]);
  expect(store.list()[0]?.route).toBe("journal");
});

test("milestone and progress reports are digest unless eventPolicy names them, question and blocked stay urgent", async () => {
  const dir = stateDir();
  const file = join(dir, "config.json");
  await Bun.write(file, JSON.stringify({}));
  const plain = await loadConfig(file, "/home/test");
  expect(eventClass("LANE_REPORT demo milestone tests green", plain.eventPolicy)).toBe("lead-digest");
  expect(eventClass("LANE_REPORT demo progress half way", plain.eventPolicy)).toBe("lead-digest");

  await Bun.write(file, JSON.stringify({ eventPolicy: { kinds: { "LANE_REPORT * progress": "engine-only" } } }));
  const on = await loadConfig(file, "/home/test");
  expect(eventClass("LANE_REPORT demo milestone tests green", on.eventPolicy)).toBe("lead-digest");
  expect(eventClass("LANE_REPORT demo progress half way", on.eventPolicy)).toBe("engine-only");
  expect(eventClass("LANE_REPORT demo question which base?", on.eventPolicy)).toBe("lead-urgent");
  expect(eventClass("LANE_REPORT demo blocked CI down", on.eventPolicy)).toBe("lead-urgent");
  expect(eventClass("GH_PR acme/app#7 checks_failing sha=x u", on.eventPolicy)).toBe("lead-digest");
});

const cli = async (dir: string, args: string[], env: Record<string, string> = {}, config: Record<string, unknown> = {}) => {
  await Bun.write(join(dir, "config.json"), JSON.stringify(config));
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "report", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("dori report: a lane writes a row for its own key only", async () => {
  const dir = stateDir();
  const deps = depsFor(newWorld(), fakeClock(T0), dir);
  await deps.registry.write(lane(dir));
  await deps.registry.write(lane(dir, { key: "other-lane", pane: "w:p8" }));
  const inLane = { DORI_LANE_KEY: "local-lane" };

  const ok = await cli(dir, ["local-lane", "question", "--text", "which base\nbranch?", "--evidence", "PR #4"], inLane);
  expect(ok).toMatchObject({ code: 0, out: "LANE_REPORTED local-lane:0:1 question\n" });
  expect(new JsonLaneReports(dir).list()).toMatchObject([{ lane: "local-lane", seq: 1, kind: "question", text: "which base branch?", evidence: "PR #4" }]);

  const denied = await cli(dir, ["other-lane", "blocked", "--text", "x"], inLane);
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("LANE_PERMISSION_DENIED lane local-lane may not report lane other-lane");

  const badKind = await cli(dir, ["local-lane", "finished", "--text", "x"], inLane);
  expect(badKind.code).toBe(1);
  expect(badKind.err).toContain("usage: dori report <key> <progress|question|blocked|milestone|done>");

  expect(new JsonLaneReports(dir).list()).toHaveLength(1);
});

/** Launches a local lane through the fakes (herdr tab create answers with pane w:p9). */
const launchLocal = async (dir: string, key = "cli-lane") => {
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), dir, { leadPane: "w:lead" });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
      : base.run(argv),
  };
  const brief = join(dir, `${key}.md`);
  await Bun.write(brief, "do the thing\n");
  const { lane: launched } = await launchLane(deps, { key, title: "t", brief, done: "merged acme/app#1", thread: `discord:1/${key}`, cwd: join(dir, "nogit") });
  return { lane: launched, brief: await Bun.file(brief).text() };
};

test("footer: a new local lane is told to use dori report and never the lead's pane; a lane without reportVia keeps the [REPORT] footer", async () => {
  const dir = stateDir();
  const on = await launchLocal(dir);
  expect(on.lane.reportVia).toBe("cli");
  expect(on.brief).toContain('dori report cli-lane <milestone|progress|question|blocked> --text "<what, with links>"');
  expect(on.brief).toContain('When done: dori report cli-lane done --text "<one line>" --evidence "<merge SHA, closed issue, version>"');
  expect(on.brief).not.toContain("w:lead");
  expect(on.brief).not.toContain("[REPORT] cli-lane |");
  // A lane registered by an older dori (no reportVia) keeps the [REPORT] footer it was launched on.
  const old = footer({ ...on.lane, key: "old-lane", reportVia: undefined }, "w:lead");
  expect(old).toContain("[REPORT] old-lane | <milestone|blocker|question|done> | <what, with links>, sent to pane w:lead as an argv array");
  expect(old).toContain('When done: dori claim-done old-lane --evidence');
  // A remote lane has no dori on its machine: it keeps printing [REPORT] lines in its own pane.
  const remote = footer({ ...on.lane, machine: "m1", reportVia: undefined }, "w:lead");
  expect(remote).toContain("[REPORT] cli-lane | done |");
});

test("lead-pane violations: each distinct [REPORT] line of a dori-report lane in the lead's pane is counted once; old-footer lanes are not counted", async () => {
  const dir = stateDir();
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), dir, { leadPane: "w:lead" });
  await deps.registry.write(lane(dir, { key: "cli-lane", reportVia: "cli" }));
  await deps.registry.write(lane(dir, { key: "old-lane", pane: "w:p8" }));
  const emitted: string[] = [];
  const emit = async (line: string) => { emitted.push(line); };
  world.screen = [
    "> [REPORT] cli-lane | milestone | tests green, PR #9",
    "> [REPORT] old-lane | milestone | typed here by design",
    "  [REPORT] cli-lane | <milestone|progress> | <what, with links>",
  ].join("\n");
  await leadPaneViolationTick(deps, emit);
  // The same screen on the next round is the same line: not counted again.
  await leadPaneViolationTick(deps, emit);
  expect(emitted).toEqual(["LANE_PANE_VIOLATION cli-lane 1 [REPORT] cli-lane | milestone | tests green, PR #9"]);
  world.screen += "\n> [REPORT] cli-lane | question | which base?";
  await leadPaneViolationTick(deps, emit);
  expect(emitted.at(-1)).toBe("LANE_PANE_VIOLATION cli-lane 2 [REPORT] cli-lane | question | which base?");
  expect((await deps.registry.read("cli-lane"))?.leadPaneViolations).toBe(2);
  expect((await deps.registry.read("old-lane"))?.leadPaneViolations).toBeUndefined();
  expect(eventClass("LANE_PANE_VIOLATION cli-lane 2 x", deps.config.eventPolicy)).toBe("lead-digest");

  // No dori-report lane open: the lead's pane is not read at all.
  const quiet = depsFor(newWorld(), fakeClock(T0), stateDir(), { leadPane: "w:lead" });
  await quiet.registry.write(lane(dir, { key: "old-lane" }));
  const before = world.calls.length;
  await leadPaneViolationTick(quiet, emit);
  expect(world.calls.length).toBe(before);
});

test("a dori-report lane's row is routed and counts as hearing from it, and an old-footer remote lane's [REPORT] line is still read", async () => {
  const dir = stateDir();
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), dir);
  // The remote lane's herdr calls carry --machine; the fake herdr answers them like local ones.
  const deps = { ...base, run: (argv: readonly string[]) => base.run(argv[1] === "--machine" ? [argv[0] ?? "", ...argv.slice(3)] : argv) };
  await deps.registry.write(lane(dir, { key: "cli-lane", reportVia: "cli" }));
  await deps.registry.write(lane(dir, { key: "old-lane", pane: "w:p8" }));
  await deps.registry.write(lane(dir, { key: "remote-lane", pane: "w:p5", machine: "m1" }));

  const ok = await cli(dir, ["cli-lane", "question", "--text", "which base?"], { DORI_LANE_KEY: "cli-lane" });
  expect(ok).toMatchObject({ code: 0, out: "LANE_REPORTED cli-lane:0:1 question\n" });

  // The supervisor routes the row, and the question wakes the lead.
  const journal: [string, string][] = [];
  expect(await routeReports(deps, new JsonLaneReports(dir), (id, line) => { journal.push([id, line]); })).toEqual(["LANE_REPORT_ROUTED cli-lane:0:1 question journal"]);
  expect(journal).toEqual([["lane-report:cli-lane:0:1", "LANE_REPORT cli-lane question which base?"]]);
  expect(eventClass("LANE_REPORT cli-lane question which base?", deps.config.eventPolicy)).toBe("lead-urgent");
  // Being routed is being heard: freshness counts from it.
  expect((await deps.registry.read("cli-lane"))?.lastReplyAt).toBe(T0);

  // Pane [REPORT] lines are still parsed: a remote lane's question on its own screen reaches the lead.
  world.screen = "[REPORT] remote-lane | question | need the deploy key\n❯ ";
  const pushed: string[] = [];
  await watchTick(deps, async (line) => { pushed.push(line); });
  expect(pushed).toContain("LANE_REPORT remote-lane question need the deploy key");
});
