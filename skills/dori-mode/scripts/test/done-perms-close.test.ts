import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { callerLane, claimDone, closeLane, laneActRefusal, laneSendRefusal, unpushedWork, watchTick } from "../src/done-flow.ts";
import { lastReportLine } from "../src/freshness.ts";
import { launchLane } from "../src/launch.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World, WT, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closes = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");
const removes = () => world.calls.filter((c) => c[0] === "git" && c.includes("worktree") && c.includes("remove"));
const notified = () => world.calls.filter((c) => c[0] === "notify");

beforeEach(async () => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  // The lane's pane is listed, so a close's pane-close operation has something to close.
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

// Item 1: untracked files count as dirty work.
test("the dirty check lists untracked files, and an untracked file blocks the automatic close", async () => {
  world.dirty = "?? notes/new-file.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  const status = world.calls.find((c) => c[0] === "git" && c.includes("status"));
  expect(status).toContain("--untracked-files=normal");
  expect(status).not.toContain("--untracked-files=no");
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closes()).toHaveLength(0);
});

test("in a real worktree an untracked file is unpushed work and a gitignored file is not", async () => {
  const git = async (...args: string[]) => {
    const r = await run(["git", ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  };
  const origin = join(state.dir, "origin.git");
  const repo = join(state.dir, "repo");
  await git("init", "-q", "--bare", origin);
  await git("clone", "-q", origin, repo);
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  await git("-C", repo, "add", ".gitignore");
  await git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  await git("-C", repo, "push", "-q", "origin", "HEAD");
  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "out.js"), "ignored");
  const d = { ...depsFor(world, fakeClock(T0), state.dir, { defaultCwd: repo }), run, exists: undefined };
  const real: Lane = { ...lane, cwd: repo, worktrees: [repo] };
  expect(await unpushedWork(d, real)).toEqual([]);
  writeFileSync(join(repo, "draft.md"), "not committed");
  expect(await unpushedWork(d, real)).toEqual([`unpushed work in ${repo}`]);
});

// Item 2: manual close checks unpushed work, and removes the worktree before the pane closes.
test("dori close refuses unpushed work unless forced, and leaves pane, worktree and registry alone", async () => {
  world.aheadCount = "2";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toBe(`REFUSED demo-lane: unpushed work in ${WT} (commit and push it, or dori close --force)`);
  expect(closes()).toHaveLength(0);
  expect(removes()).toHaveLength(0);
  expect(notified()).toHaveLength(0);
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).toBe("working");
  const forced = await closeLane(at(T0), lane, "manual", { force: true });
  expect(forced.closed).toBe(true);
  expect(closes()).toEqual([["herdr", "pane", "close", "w:p1"]]);
});

test("the worktree is removed before the pane closes, and a failed removal keeps the pane and the lane open", async () => {
  const ok = await closeLane(at(T0), lane, "manual");
  expect(ok.closed).toBe(true);
  const order = world.calls.map((c) => (c.includes("remove") ? "remove" : c[2] === "close" ? "close" : "")).filter(Boolean);
  expect(order).toEqual(["remove", "close"]);
});

test("a failed worktree removal refuses the close and keeps the pane, the thread and the lane open", async () => {
  const base = at(T0);
  const failing = { ...base, run: async (argv: readonly string[]) => (argv.includes("remove") ? { code: 128, out: "", err: "fatal: locked" } : base.run(argv)) };
  const r = await closeLane(failing, lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith(`REFUSED demo-lane: worktree ${WT} not removed: fatal: locked`);
  expect(closes()).toHaveLength(0);
  expect(notified()).toHaveLength(0);
  expect(statusOf((await base.registry.read("demo-lane")) ?? lane)).toBe("working");
  expect((await closeLane(failing, lane, "manual", { force: true })).closed).toBe(true);
  expect(closes()).toEqual([["herdr", "pane", "close", "w:p1"]]);
});

// Item 3: a shared thread is marked done only by the last open lane in it.
test("closing a lane keeps its thread open while another open lane works in it, and marks it done once none does", async () => {
  await at(T0).registry.write({ ...lane, key: "sibling-lane", pane: "w:p2", cwd: "/repo2" });
  const first = await closeLane(at(T0), lane, "Done: first");
  expect(first.closed).toBe(true);
  expect(notified()).toHaveLength(0);
  expect(first.lines.at(-1)).toContain("thread kept open: lane sibling-lane still works in it");
  const sibling = (await at(T0).registry.read("sibling-lane")) ?? lane;
  const second = await closeLane(at(T0), sibling, "Done: second");
  expect(second.closed).toBe(true);
  expect(notified()).toEqual([["notify", "discord:111/222", "Done: second"]]);
});

// Item 4: lane identity and permissions.
test("callerLane is DORI_LANE_KEY, else the open lane registered for HERDR_PANE_ID; the lead pane and no env mean the lead", async () => {
  const d = at(T0);
  expect(await callerLane(d, {})).toBeUndefined();
  expect(await callerLane(d, { DORI_LANE_KEY: "demo-lane" })).toBe("demo-lane");
  expect(await callerLane(d, { HERDR_PANE_ID: "w:p1" })).toBe("demo-lane");
  expect(await callerLane(d, { HERDR_PANE_ID: "lead:p1" })).toBeUndefined();
  expect(await callerLane(d, { HERDR_PANE_ID: "w:unknown" })).toBeUndefined();
});

test("a lane may act only on its own key and send only into its own thread; the lead may do both anywhere", () => {
  expect(laneActRefusal(undefined, "close", "other-lane")).toBeUndefined();
  expect(laneActRefusal("demo-lane", "close", "demo-lane")).toBeUndefined();
  expect(laneActRefusal("demo-lane", "close", "other-lane")).toStartWith("LANE_PERMISSION_DENIED lane demo-lane may not close lane other-lane");
  expect(laneSendRefusal(undefined, null, "discord", { to: "999" })).toBeUndefined();
  expect(laneSendRefusal("demo-lane", lane, "discord", { to: "222" })).toBeUndefined();
  expect(laneSendRefusal("demo-lane", lane, "discord", { to: "111" })).toStartWith("LANE_PERMISSION_DENIED");
  expect(laneSendRefusal("demo-lane", lane, "discord", { to: "333" })).toStartWith("LANE_PERMISSION_DENIED");
  expect(laneSendRefusal("demo-lane", lane, "slack", { to: "222" })).toStartWith("LANE_PERMISSION_DENIED");
  expect(laneSendRefusal("demo-lane", { ...lane, thread: "none" }, "discord", { to: "222" })).toStartWith("LANE_PERMISSION_DENIED");
  expect(laneSendRefusal("demo-lane", null, "discord", { to: "222" })).toStartWith("LANE_PERMISSION_DENIED");
  const slackLane = { ...lane, thread: "slack:C1/1700.1" };
  expect(laneSendRefusal("demo-lane", slackLane, "slack", { to: "C1", thread: "1700.1" })).toBeUndefined();
  expect(laneSendRefusal("demo-lane", slackLane, "slack", { to: "C1" })).toStartWith("LANE_PERMISSION_DENIED");
});

const cli = async (args: string[], env: Record<string, string>) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: state.dir, TMPDIR: process.env.TMPDIR ?? state.dir, DORI_CONFIG: join(state.dir, "no-config.json"), DORI_STATE_DIR: state.dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("the dori CLI inside a lane refuses close/pause/claim-done on another lane and sends outside its thread", async () => {
  const d = at(T0);
  await d.registry.write({ ...lane, key: "other-lane", pane: undefined, thread: "discord:111/333" });
  const inLane = { DORI_LANE_KEY: "demo-lane" };
  for (const args of [["close", "other-lane"], ["pause", "other-lane"], ["resume", "other-lane"], ["claim-done", "other-lane", "--evidence", "x"]]) {
    const r = await cli(args, inLane);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`LANE_PERMISSION_DENIED lane demo-lane may not ${args[0]} lane other-lane`);
  }
  const send = await cli(["send", "discord", "--to", "discord:111/333", "--text", "hi from Dori"], inLane);
  expect(send.code).toBe(1);
  expect(send.err).toContain("LANE_PERMISSION_DENIED lane demo-lane may send only to its own work thread (discord:111/222)");
  expect(statusOf((await d.registry.read("other-lane")) ?? lane)).toBe("working");
});

test("the dori CLI inside a lane claims its own lane when no key is given", async () => {
  await at(T0).registry.write({ ...lane, pane: undefined });
  const r = await cli(["claim-done", "--evidence", "merged acme/app#1"], { DORI_LANE_KEY: "demo-lane" });
  expect(r.code).toBe(0);
  expect(r.out).toStartWith("LANE_DONE_CLAIMED demo-lane - merged acme/app#1");
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).toBe("done-claimed");
});

test("a local lane is launched with DORI_LANE_KEY in its command", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "do the thing\n");
  const base = at(T0);
  const d = {
    ...base,
    run: async (argv: readonly string[]) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
        : base.run(argv),
  };
  await launchLane(d, { key: "env-lane", title: "t", brief, done: "merged acme/app#1", cwd: join(state.dir, "nogit") });
  const command = world.calls.find((c) => c[0] === "herdr" && c[1] === "pane" && c[2] === "run")?.[4] ?? "";
  expect(command).toStartWith("DORI_LANE_KEY=env-lane ");
});

// Item 5: the remote [REPORT] matcher is anchored to a whole line.
test("lastReportLine reads only a whole [REPORT] line, never one inside command output or prose", () => {
  const key = "remote-lane";
  expect(lastReportLine("[REPORT] remote-lane | done | closed acme/app#3\n❯ ", key)).toBe("[REPORT] remote-lane | done | closed acme/app#3");
  expect(lastReportLine("  ● [REPORT] remote-lane | done | closed acme/app#3", key)).toBe("[REPORT] remote-lane | done | closed acme/app#3");
  for (const screen of [
    "docs/notes.md:12: [REPORT] remote-lane | done | closed acme/app#3",
    "INFO watcher saw [REPORT] remote-lane | done | closed acme/app#3",
    "│ [REPORT] remote-lane | done | closed acme/app#3 │",
    "  ⎿  [REPORT] remote-lane | done | closed acme/app#3",
    "echo '[REPORT] remote-lane | done | closed acme/app#3'",
    "[REPORT] remote-lane-2 | done | closed acme/app#3",
    "[REPORT] remote-lane | finished | closed acme/app#3",
  ]) expect(lastReportLine(screen, key)).toBeNull();
});

test("a remote lane whose screen shows a [REPORT] shape inside command output is not claimed", async () => {
  const remote: Lane = { ...lane, key: "remote-lane", machine: "box", cwd: undefined };
  await at(T0).registry.write(remote);
  const local = at(T0);
  const d = { ...local, run: (argv: readonly string[]) => local.run(argv[1] === "--machine" ? [argv[0] ?? "", ...argv.slice(3)] : argv) };
  world.screen = "$ grep -rn REPORT docs\ndocs/a.md:3:[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
  expect(await watchTick(d)).toEqual([]);
  expect(statusOf((await at(T0).registry.read("remote-lane")) ?? remote)).toBe("working");
  world.screen = "[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
  await watchTick(d);
  expect(statusOf((await at(T0).registry.read("remote-lane")) ?? remote)).toBe("done-claimed");
});
