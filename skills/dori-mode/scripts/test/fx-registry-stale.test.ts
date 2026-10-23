import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { laneQuotaTick } from "../src/quota-stall.ts";
import { recoverLanes } from "../src/recover.ts";
import { type Lane, Registry, statusOf } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World, withSqliteStore } from "./fakes.ts";

// D4: every load-modify-save goes through the lane lock onto the fresh lane, so a field another process wrote between
// the caller's load and its save (an objection, a pause, a claim, a quota mark) survives, and no stale write happens.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "race-lane", title: "race", thread: "chat:1/2", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const objection = { at: new Date(T0).toISOString(), reasons: ["written elsewhere"] };

let state: ReturnType<typeof withState>;
let world: World;
let errors: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  state = withState();
  withSqliteStore(state.dir);
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent_status: "idle" }];
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
});
afterEach(() => {
  spy.mockRestore();
  state.done();
});

const deps = (ms: number, run?: Runner) => ({
  ...depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"], threadDone: ["notify", "{thread}", "{text}"] } }),
  ...(run ? { run } : {}),
});
/** A real independent process writing this lane while the caller holds a stale copy. */
const elsewhere = async (fields: Partial<Lane>) => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { Registry } from "./src/registry.ts";
    await new Registry(process.argv[1]).patch(process.argv[2], JSON.parse(process.argv[3]));
  `, state.dir, lane.key, JSON.stringify(fields)], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`registry writer exited ${code}: ${err}`);
};
const stored = async (): Promise<Lane> => (await new Registry(state.dir).read(lane.key)) as Lane;
/** fakeRunner that runs `during` once, before the first command matching `when` is answered (by `answer`, else the fake). */
const racing = (when: (argv: readonly string[]) => boolean, during: () => Promise<unknown>, answer?: (argv: readonly string[]) => Ran | undefined): Runner => {
  const base = fakeRunner(world);
  let fired = false;
  return async (argv, opts) => {
    if (!fired && when(argv)) { fired = true; await during(); }
    return answer?.(argv) ?? base(argv, opts);
  };
};
const staleWrites = () => errors.filter((e) => e.includes("REGISTRY_STALE_WRITE"));

test("done-flow: claim, objection and close from a stale lane keep the fields written since it was loaded", async () => {
  await deps(T0).registry.write(lane);
  const stale = await stored();
  await elsewhere({ lastQuotaStall: "stalled elsewhere", lastProgressPost: "todo 3" });

  await claimDone(deps(T0), stale, "merged acme/app#1");
  expect(await stored()).toMatchObject({ status: "done-claimed", lastQuotaStall: "stalled elsewhere", lastProgressPost: "todo 3" });
  await objectDone(deps(T0 + MIN), stale, ["changelog missing"]);
  let after = await stored();
  expect(after).toMatchObject({ status: "not-done", lastQuotaStall: "stalled elsewhere", claim: { evidence: "merged acme/app#1" } });
  expect(after.history?.map((h) => h.status)).toEqual(["done-claimed", "not-done"]);
  expect((await closeLane(deps(T0 + 2 * MIN), stale, "closed by lead")).closed).toBe(true);
  after = await stored();
  expect(statusOf(after)).toBe("closed");
  expect(after).toMatchObject({ lastQuotaStall: "stalled elsewhere", objection: { reasons: ["changelog missing"] } });
  expect(after.history?.map((h) => h.status)).toEqual(["done-claimed", "not-done", "closed"]);
  expect(staleWrites()).toEqual([]);
});

test("done-flow: an objection written while the claim is being settled stands and the lane is not closed", async () => {
  await deps(T0).registry.write(lane);
  await claimDone(deps(T0), lane, "merged acme/app#1");
  await watchTick(deps(T0 + MIN));
  const run = racing((argv) => argv[0] === "gh", async () => objectDone(deps(T0 + 6 * MIN), await stored(), ["lead objected"]));
  const lines = await watchTick(deps(T0 + 6 * MIN, run));
  expect(lines).toEqual(["LANE_SETTLE_SKIPPED race-lane is now not-done; the done claim being settled was superseded, not closed"]);
  expect(await stored()).toMatchObject({ status: "not-done", objection: { reasons: ["lead objected"] } });
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "close")).toBe(false);
  expect(staleWrites()).toEqual([]);
});

test("pause: pause and resume from a stale lane keep an objection and quota mark written meanwhile", async () => {
  await deps(T0).registry.write(lane);
  const stale = await stored();
  await elsewhere({ objection, lastQuotaStall: "stalled elsewhere" });
  world.screens = ["❯ ", "Goal paused\n❯ "];
  expect((await pauseLane(deps(T0 + MIN), stale, "owner said wait")).code).toBe(0);
  expect(await stored()).toMatchObject({ status: "paused", pausedFrom: "working", objection, lastQuotaStall: "stalled elsewhere" });

  const stalePaused = await stored();
  await elsewhere({ lastProgressPost: "todo 4" });
  world.screens = ["❯ ", "Goal active\n❯ "];
  expect((await resumeLane(deps(T0 + 2 * MIN), stalePaused, "go")).code).toBe(0);
  expect(await stored()).toMatchObject({ status: "working", objection, lastQuotaStall: "stalled elsewhere", lastProgressPost: "todo 4", lastReplyAt: T0 + 2 * MIN });
  expect(staleWrites()).toEqual([]);
});

test("freshness: a pause written while the sweep nudges the lane stands; only the nudge time is saved", async () => {
  await deps(T0).registry.write(lane);
  const run = racing((argv) => argv[2] === "send-text" && String(argv[4]).startsWith("[LEAD] your work thread"), () => elsewhere({ status: "paused", pausedFrom: "working" }));
  const acts = await freshnessTick(deps(T0 + 20 * MIN, run), "/home/test");
  expect(acts.map((a) => a.kind)).toContain("nudged");
  expect(await stored()).toMatchObject({ status: "paused", pausedFrom: "working", lastNudgeAt: T0 + 20 * MIN });
  expect(staleWrites()).toEqual([]);
});

test("quota-stall: an objection written while omo auth check runs survives the stall mark", async () => {
  await deps(T0).registry.write(lane);
  world.screen = "Error: All Claude accounts for anthropic-subscription are currently blocked\n❯ ";
  const blocked = JSON.stringify({ accounts: [{ name: "a", blocked: true }] });
  const run = racing((argv) => argv[0] === "omo", () => elsewhere({ objection }), (argv) => (argv[0] === "omo" ? { code: 1, out: blocked, err: "" } : undefined));
  const lines = await laneQuotaTick(deps(T0, run));
  expect(lines[0]).toStartWith("LANE_QUOTA_STALL race-lane w:p7 ");
  expect(await stored()).toMatchObject({ objection, lastQuotaStall: expect.stringContaining("1/1 anthropic-subscription accounts blocked") });
  expect(staleWrites()).toEqual([]);
});

test("recover: an objection written while recovery checks quota survives the blocked mark", async () => {
  const recovering: Lane = { ...lane, pane: "old:p1", model: "provider/expected" };
  await deps(T0).registry.write(recovering);
  world.panes = [];
  world.prState = "OPEN";
  const blocked = JSON.stringify({ accounts: [{ name: "a", blocked: true }] });
  const run = racing((argv) => argv[0] === "omo", () => elsewhere({ objection }), (argv) => (argv[0] === "omo" ? { code: 1, out: blocked, err: "" } : undefined));
  expect(await recoverLanes(deps(T0, run), lane.key)).toEqual(["LANE_RECOVERY_BLOCKED race-lane old:p1 missing-pane: quota 1/1 provider accounts blocked; not relaunched"]);
  expect(await stored()).toMatchObject({ objection, recoveryPending: true, recoveryBlocked: "quota 1/1 provider accounts blocked" });
  expect(staleWrites()).toEqual([]);
});
