import { afterEach, beforeEach, expect, test } from "bun:test";

import { LEGACY_LANE_MCP, removeLegacyLaneMcp } from "../src/launch.ts";
import { claimDone, claimEventId, closeLane, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
/** The lane's pane is listed, so the close's pane-close operation has something to close (its read-back sees it gone after). */
const livePane = () => { world.panes = [{ pane_id: "w:p1", workspace_id: "w" }]; };
const closedVia = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");

beforeEach(async () => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after a claim is handed over the lane is closed, its thread marked done and its worktree removed", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual([]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
  expect(world.calls).toContainEqual(["notify", "chat:team/123", "Done: merged acme/app#1 abc123"]);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0));
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  livePane();
  await claimDone(at(T0), lane, "merged acme/app#1");
  // Handed over at T0+2: the window ends at T0+7, not five minutes after the restart.
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 7 * MIN + 1));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("delivery is confirmed by the pane's agent status moving to working, with exactly one Enter", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("delivered");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a screen that still shows the text never causes another Enter; no status change is unconfirmed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.stuckReads = 10;
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] stuck text still here")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a pane that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] queued while busy")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});

const KEPT_WT = "/data/repos/worktrees/demo/feat-x";
const closedKept = (paths: readonly string[] = [KEPT_WT], patch: Partial<Lane> = {}): Lane => ({
  ...lane, done: "merged acme/app#1", worktrees: [...paths], status: "closed", closedAt: new Date(T0).toISOString(),
  receipt: { cleanup: paths.map((p) => `worktree ${p} kept: fatal: '${p}' contains modified or untracked files`) }, ...patch,
});
const removals = () => world.calls.filter((c) => c.includes("worktree") && c.includes("remove"));

test("a closed lane's worktree its close had to keep is removed once clean, under worktreeRoot, with one digest line", async () => {
  await at(T0).registry.write(closedKept());
  world.dirty = "?? scratch.txt";
  expect(await watchTick(at(T0))).toEqual([]);
  world.dirty = "";
  expect(await watchTick(at(T0))).toEqual([`WORKTREE_CLEANED demo-lane ${KEPT_WT}`]);
  expect(removals()).toEqual([["git", "-C", "/repo", "worktree", "remove", KEPT_WT]]);
});

test("working, not-done and paused lanes keep their worktrees even after their PR merged", async () => {
  for (const status of ["working", "not-done", "paused"] as const) {
    await at(T0).registry.write({ ...lane, done: "merged acme/app#1", worktrees: [KEPT_WT], status });
    expect(await watchTick(at(T0))).toEqual([]);
  }
  expect(removals()).toHaveLength(0);
});

test("the root comes from config, a path outside it is never removed, and a failed removal is a LANE_WATCH_WARN", async () => {
  await at(T0).registry.write(closedKept(["/repo/.wt/other", "/data/repos/worktrees/../escape"]));
  expect(await watchTick(at(T0))).toEqual([]);
  const custom = depsFor(world, fakeClock(T0), state.dir, { worktreeRoot: "/repo/.wt" });
  const failing = { ...custom, run: async (argv: readonly string[]) => argv.includes("remove") ? { code: 128, out: "", err: "fatal: locked" } : custom.run(argv) };
  expect(await watchTick(failing)).toEqual(["LANE_WATCH_WARN demo-lane worktree /repo/.wt/other not removed: fatal: locked"]);
  expect(await watchTick(custom)).toEqual(["WORKTREE_CLEANED demo-lane /repo/.wt/other"]);
});

test("LANE_DONE_CLAIMED is handed over before the claim is marked announced, and a failed hand-over keeps it unannounced", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  const failing = async (): Promise<void> => { throw new Error("journal disk full"); };
  await expect(watchTick(at(T0 + MIN), failing)).rejects.toThrow("journal disk full");
  expect((await at(T0).registry.read("demo-lane"))?.claim?.emitted).toBe(false);
  const got: string[] = [];
  await watchTick(at(T0 + 2 * MIN), async (line) => { got.push(line); });
  expect(got).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.emitted).toBe(true);
});

test("one lane's failure is a LANE_WATCH_WARN line and the other lanes are still watched", async () => {
  await at(T0).registry.write({ ...lane, key: "a-broken", status: "done-claimed", claim: { at: new Date(T0 - 10 * MIN).toISOString(), evidence: "x", emitted: true }, done: "merged acme/app#1" });
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  const base = at(T0 + MIN);
  const registry = Object.assign(Object.create(base.registry) as typeof base.registry, {
    update: async (key: string, mutate: Parameters<typeof base.registry.update>[1]) => { if (key === "a-broken") throw new Error("registry write failed"); return base.registry.update(key, mutate); },
  });
  const lines = await watchTick({ ...base, registry });
  expect([...lines].sort()).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123", "LANE_WATCH_WARN a-broken registry write failed"]);
});

/** `received` is the supervisor's answer for journaled ids (absent: `dori watch`, no supervisor). */
const onDelivery = (ms: number, received?: (id: string) => boolean, urgentClaims = false): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, {
    hooks: { threadDone: ["notify", "{thread}", "{text}"] },
    ...(urgentClaims ? { eventPolicy: resolveEventPolicy({ kinds: { LANE_DONE_CLAIMED: "lead-urgent" } }) } : {}),
  }),
  ...(received ? { leadDelivered: received } : {}),
});

test("by default a claim is the supervisor's to settle: its window runs from the hand-over even while the lead never receives it", async () => {
  livePane();
  await claimDone(onDelivery(T0), lane, "merged acme/app#1 abc123");
  expect(sent(world).at(-1)).toContain("closes automatically at 12:05Z (5 minutes) once its Done signals read back live");
  const never = () => false;
  expect(await watchTick(onDelivery(T0 + MIN, never))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.deliveredAt).toBe(new Date(T0 + MIN).toISOString());
  expect(await watchTick(onDelivery(T0 + 5 * MIN, never))).toEqual([]);
  const lines = await watchTick(onDelivery(T0 + 6 * MIN + 1, never));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
});

test("with claims made urgent, a claim the lead receives 40 minutes late still gets the full window from that delivery", async () => {
  livePane();
  let received = false;
  const claimAt = new Date(T0).toISOString();
  const lead = (id: string) => received && id === claimEventId("demo-lane", claimAt);
  await claimDone(onDelivery(T0, undefined, true), lane, "merged acme/app#1 abc123");
  expect(sent(world).at(-1)).toContain("closes automatically 5 minutes after the lead receives this claim");
  const ids: (string | undefined)[] = [];
  expect(await watchTick(onDelivery(T0 + MIN, lead, true), async (_line, id) => { ids.push(id); })).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(ids).toEqual([`done-claim:demo-lane:${claimAt}`]);
  // Undelivered (the lead is down): the claim waits, however old.
  expect(await watchTick(onDelivery(T0 + 39 * MIN, lead, true))).toEqual([]);
  received = true;
  expect(await watchTick(onDelivery(T0 + 40 * MIN, lead, true))).toEqual([]);
  expect((await at(T0).registry.read("demo-lane"))?.claim?.deliveredAt).toBe(new Date(T0 + 40 * MIN).toISOString());
  expect(await watchTick(onDelivery(T0 + 44 * MIN, lead, true))).toEqual([]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(onDelivery(T0 + 45 * MIN + 1, lead, true));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
});

test("with no supervisor (dori watch) the window starts when the claim is handed over", async () => {
  await claimDone(onDelivery(T0), lane, "merged acme/app#1");
  expect(await watchTick(onDelivery(T0 + 20 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1"]);
  expect(await watchTick(onDelivery(T0 + 24 * MIN))).toEqual([]);
  expect((await watchTick(onDelivery(T0 + 25 * MIN)))[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("a claim announced by an older dori (no event id) keeps its window from the claim", async () => {
  await at(T0).registry.write({ ...lane, status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "merged acme/app#1", emitted: true } });
  expect((await watchTick(onDelivery(T0 + 5 * MIN + 1, () => false)))[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("an autoClose: machine lane claims and closes as LANE_AUTO_* lines with its window from the claim, never waiting for the lead", async () => {
  livePane();
  const machine: Lane = { ...lane, autoClose: "machine" };
  await at(T0).registry.write(machine);
  await claimDone(onDelivery(T0), machine, "merged acme/app#1");
  expect(sent(world).at(-1)).toContain("closes automatically at 12:05Z (5 minutes)");
  const ids: (string | undefined)[] = [];
  expect(await watchTick(onDelivery(T0 + MIN, () => false), async (_line, id) => { ids.push(id); })).toEqual(["LANE_AUTO_CLAIMED demo-lane w:p1 merged acme/app#1"]);
  expect(ids).toEqual([undefined]);
  const lines = await watchTick(onDelivery(T0 + 5 * MIN + 1, () => false));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("LANE_AUTO_CLOSED demo-lane ");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
});

test("removeLegacyLaneMcp deletes the old figma-off lane file, keeps a user's own file, and writes nothing", async () => {
  const cwd = `${state.dir}/lane-cwd`;
  expect(await removeLegacyLaneMcp(cwd)).toBe(false);
  expect(await Bun.file(`${cwd}/.omo/mcp.json`).exists()).toBe(false);
  await Bun.write(`${cwd}/.omo/mcp.json`, LEGACY_LANE_MCP);
  expect(await removeLegacyLaneMcp(cwd)).toBe(true);
  expect(await Bun.file(`${cwd}/.omo/mcp.json`).exists()).toBe(false);
  const own = `${state.dir}/own-cwd`;
  for (const text of ["{}", LEGACY_LANE_MCP.replace("false", "true")]) {
    await Bun.write(`${own}/.omo/mcp.json`, text);
    expect(await removeLegacyLaneMcp(own)).toBe(false);
    expect(await Bun.file(`${own}/.omo/mcp.json`).text()).toBe(text);
  }
});
