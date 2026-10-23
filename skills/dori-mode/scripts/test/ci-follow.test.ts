import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CiFollowUp, type CiIo, ciMessageId, laneDown, mergeLaneKey, rebaseMessageId } from "../src/ci-follow.ts";
import { loadConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { eventClass } from "../src/event-policy.ts";
import type { OpenPull } from "../src/github-events.ts";
import { briefIssue, LaunchError } from "../src/launch.ts";
import { ackLaneMessage, LaneMessageError } from "../src/lane-messages.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, TEST_STORE, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/b.md", done: "merged acme/app#7", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const claimedLane: Lane = { ...lane, status: "done-claimed", claim: { at: new Date(T0 + MIN).toISOString(), evidence: "PR green", emitted: true } };
const pull = (patch: Partial<OpenPull> = {}): OpenPull => ({ repo: "acme/app", number: 7, sha: SHA, branch: "feat", url: "https://github.com/acme/app/pull/7", conflicting: false, checks: "failing", ...patch });
const idle = { pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "idle" };

type Gh = { view: Record<string, unknown>; viewCode: number; mergeCode: number; merges: string[][]; issue: string; closes: string[][] };
const greenView = (patch: Record<string, unknown> = {}) => ({
  state: "OPEN", baseRefName: "dev", headRefOid: SHA, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: null,
  commits: [{ oid: SHA, committedDate: new Date(T0).toISOString() }], ...patch,
});

/** herdr and git from fakes.ts; `gh pr view` / `gh pr merge` from a PR whose merge flips it to MERGED. */
const runner = (w: World, gh: Gh): Runner => {
  const base = fakeRunner(w);
  return async (argv, opts): Promise<Ran> => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
      w.calls.push([...argv]);
      return gh.viewCode === 0 ? { code: 0, out: JSON.stringify(gh.view), err: "" } : { code: gh.viewCode, out: "", err: "HTTP 502" };
    }
    if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "view") return { code: 0, out: JSON.stringify({ state: gh.issue }), err: "" };
    if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "close") {
      gh.closes.push([...argv]);
      gh.issue = "CLOSED";
      return { code: 0, out: "", err: "" };
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      w.calls.push([...argv]);
      gh.merges.push([...argv]);
      if (gh.mergeCode !== 0) return { code: gh.mergeCode, out: "", err: "Pull request is not mergeable" };
      gh.view = { ...gh.view, state: "MERGED", mergeCommit: { oid: "m3rge5ha" } };
      return { code: 0, out: "", err: "" };
    }
    return base(argv, opts);
  };
};

let state: ReturnType<typeof withState>;
let world: World;
let gh: Gh;
let clock: ReturnType<typeof fakeClock>;
let deps: FlowDeps;
let events: [string, string][];
let launches: string[];
let open: CiFollowUp[];
const emit = (id: string, line: string): void => { events.push([id, line]); };
const lines = (kind: string): string[] => [...new Map(events.filter(([, l]) => l.startsWith(kind))).values()];
const io = (patch: Partial<CiIo> = {}): CiIo => ({ launch: async () => ({ ok: false, detail: "no launch in this test" }), ...patch });
const follow = (patch: Partial<CiIo> = {}): CiFollowUp => {
  const ci = new CiFollowUp(deps, io(patch));
  open.push(ci);
  return ci;
};

beforeEach(async () => {
  state = withState();
  if (TEST_STORE === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  world = newWorld();
  world.panes = [{ ...idle }];
  gh = { view: greenView(), viewCode: 0, mergeCode: 0, merges: [], issue: "OPEN", closes: [] };
  clock = fakeClock(T0);
  deps = { ...depsFor(world, clock, state.dir, {}), run: runner(world, gh) };
  await deps.registry.update(lane.key, () => claimedLane);
  events = [];
  launches = [];
  open = [];
});
afterEach(() => { for (const ci of open) ci.close(); state.done(); });

test("failing CI on a lane PR is one lane message with an ID, typed once into the idle agent pane and confirmed by that lane's ack", async () => {
  const ci = follow();
  const id = ciMessageId(pull());
  await ci.tick([pull()], emit);
  await ci.tick([pull()], emit);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain(`dori report ack ${id}`);
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "send-keys")).toHaveLength(1);
  expect(ci.messages.get(id)).toMatchObject({ lane: "demo-lane", state: "delivered" });

  expect(() => ackLaneMessage(ci.messages, "other-lane", id, clock.now())).toThrow(LaneMessageError);
  expect(ackLaneMessage(ci.messages, "demo-lane", id, clock.now())).toMatchObject({ state: "acked" });
  clock.at += 30 * MIN;
  await ci.tick([pull()], emit);
  expect(sent(world)).toHaveLength(1);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")).toEqual([]);
});

test("a delivered message the lane never confirms reaches the lead once, after ciConfirmMin", async () => {
  const ci = follow();
  await ci.tick([pull()], emit);
  clock.at += 19 * MIN;
  await ci.tick([pull()], emit);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")).toEqual([]);
  clock.at += 2 * MIN;
  await ci.tick([pull()], emit);
  await ci.tick([pull()], emit);
  expect(events.filter(([, l]) => l.startsWith("LANE_MESSAGE_UNCONFIRMED"))).toHaveLength(1);
  expect(lines("LANE_MESSAGE_UNCONFIRMED")[0]).toContain("delivered but not confirmed");
  expect(sent(world)).toHaveLength(1);
});

for (const [name, setup, reason] of [
  ["busy", () => { world.panes = [{ ...idle, agent_status: "working" }]; }, "busy (working)"],
  ["paused", async () => { await deps.registry.update(lane.key, () => ({ ...lane, status: "paused" })); }, "lane paused"],
  ["missing", () => { world.panes = []; }, "pane w:p1 missing"],
] as const) {
  test(`a ${name} pane keeps the message queued, untyped, and wakes the lead once after the deadline`, async () => {
    await setup();
    const ci = follow();
    const id = ciMessageId(pull());
    await ci.tick([pull()], emit);
    expect(sent(world)).toEqual([]);
    expect(ci.messages.get(id)).toMatchObject({ state: "queued", blocked: expect.stringContaining(reason) });
    clock.at += 21 * MIN;
    await ci.tick([pull()], emit);
    await ci.tick([pull()], emit);
    expect(events.filter(([, l]) => l.startsWith("LANE_MESSAGE_UNCONFIRMED"))).toHaveLength(1);
    expect(lines("LANE_MESSAGE_UNCONFIRMED")[0]).toContain(`demo-lane ${id} not delivered: `);
    expect(sent(world)).toEqual([]);
  });
}

test("a new head SHA supersedes the queued message for the old one", async () => {
  world.panes = [{ ...idle, agent_status: "working" }];
  const ci = follow();
  await ci.tick([pull()], emit);
  const moved = pull({ sha: "1234567890abcdef1234567890abcdef12345678" });
  await ci.tick([moved], emit);
  expect(ci.messages.get(ciMessageId(pull()))?.state).toBe("superseded");
  expect(ci.messages.get(ciMessageId(moved))?.state).toBe("queued");
});

test("a delivered message whose PR went green is superseded and never reaches the lead", async () => {
  const ci = follow();
  await ci.tick([pull()], emit);
  expect(ci.messages.get(ciMessageId(pull()))?.state).toBe("delivered");
  gh.view = greenView({ baseRefName: "main" });
  await ci.tick([pull({ checks: "green" })], emit);
  clock.at += 30 * MIN;
  await ci.tick([pull({ checks: "green" })], emit);
  expect(ci.messages.get(ciMessageId(pull()))?.state).toBe("superseded");
  expect(lines("LANE_MESSAGE_UNCONFIRMED")).toEqual([]);
});

test("a green, clean lane PR into dev is merged once with --match-head-commit and no --admin; a second poll and a restart merge nothing", async () => {
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([["gh", "pr", "merge", "7", "-R", "acme/app", "--merge", "--match-head-commit", SHA]]);
  expect(lines("CI_MERGED")).toEqual(["CI_MERGED acme/app#7 into dev lane=demo-lane head=abcdef1 merge=m3rge5ha https://github.com/acme/app/pull/7"]);
  gh.view = greenView();
  await open[0]?.tick([pull({ checks: "green" })], emit);
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toHaveLength(1);
});

test("a green lane PR is not merged while its lane has no done claim or pushed after claiming; the first poll after a valid claim merges it", async () => {
  const ci = follow();
  const green = pull({ checks: "green" });
  await deps.registry.update(lane.key, () => lane);
  await ci.tick([green], emit);
  expect(gh.merges).toEqual([]);

  // Claimed, then pushed: the head commit is newer than the claim.
  await deps.registry.update(lane.key, () => claimedLane);
  gh.view = greenView({ commits: [{ oid: SHA, committedDate: new Date(T0 + 2 * MIN).toISOString() }] });
  await ci.tick([green], emit);
  expect(gh.merges).toEqual([]);

  // The lane claims again after its last push: merged on the next poll.
  await deps.registry.update(lane.key, () => ({ ...claimedLane, claim: { at: new Date(T0 + 3 * MIN).toISOString(), evidence: "again", emitted: true } }));
  await ci.tick([green], emit);
  expect(gh.merges).toHaveLength(1);
});

test("a PR with no lane is not merged", async () => {
  await follow().tick([pull({ number: 99, branch: "other", checks: "green" })], emit);
  expect(gh.merges).toEqual([]);
});

test("a merge a crash left attempted is settled by read-back: merged verifies without merging, unreadable is ambiguous and never merges", async () => {
  const id = `demo-lane/merge/acme/app#7@${SHA}`;
  const attempted = { id, lane: "demo-lane", action: "merge", target: `acme/app#7@${SHA}`, state: "attempted" as const, detail: "attempted", attempts: 1, at: T0, updatedAt: T0 };
  const ci = follow();
  ci.ops.put(attempted);
  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  await ci.tick([pull({ checks: "green" })], emit);
  expect(ci.ops.get(id)?.state).toBe("verified");
  expect(lines("CI_MERGED")[0]).toContain("merge=m3rge5ha");

  ci.ops.put(attempted);
  gh.view = greenView();
  gh.viewCode = 1;
  await ci.tick([pull({ checks: "green" })], emit);
  gh.viewCode = 0;
  await ci.tick([pull({ checks: "green" })], emit);
  expect(ci.ops.get(id)?.state).toBe("ambiguous");
  expect(gh.merges).toEqual([]);
});

test("never merges into main; into dev a green, claimed PR merges with no other gate, an old config's ciToodoWorkspaces ignored", async () => {
  gh.view = greenView({ baseRefName: "main" });
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toEqual([]);

  deps = { ...deps, config: Object.assign({}, deps.config, { ciToodoWorkspaces: { "Acme/App": 3 } }) };
  gh.view = greenView();
  await follow().tick([pull({ checks: "green" })], emit);
  expect(gh.merges).toHaveLength(1);
  expect(lines("CI_MERGE_SKIPPED")).toEqual([]);
});

const recordLaunch: CiIo["launch"] = async (d, request) => {
  launches.push(request.key);
  await d.registry.update(request.key, () => ({ ...lane, key: request.key, done: `merged acme/app#${request.pull.number}`, openedAt: new Date(clock.now()).toISOString() }));
  return { ok: true, detail: "STARTUP_OK" };
};

test("a conflicting PR whose lane is live gets one rebase message and no merge lane; once the lane's agent is gone a merge lane starts and the message is superseded", async () => {
  const conflicting = pull({ conflicting: true, checks: "green" });
  const id = rebaseMessageId(conflicting);
  const ci = follow({ launch: recordLaunch });
  await ci.tick([conflicting], emit);
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain("rebase your branch onto origin/dev yourself");
  expect(sent(world)[0]).toContain(`dori report ack ${id}`);
  expect(ci.messages.get(id)).toMatchObject({ lane: "demo-lane", state: "delivered" });

  // A busy agent is still live: it gets no merge lane beside it.
  world.panes = [{ ...idle, agent_status: "working" }];
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([]);
  expect(lines("CI_MERGE_LANE")).toEqual([]);
  expect(lines("CI_CONFLICT")).toEqual([]);

  world.panes = [];
  await ci.tick([conflicting], emit);
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([mergeLaneKey(conflicting)]);
  expect(events.filter(([, l]) => l.startsWith("CI_MERGE_LANE")).map(([id]) => id)).toEqual([`ci-merge-lane:acme/app#7@${SHA}`, `ci-merge-lane:acme/app#7@${SHA}`]);
  expect(events.find(([, l]) => l.startsWith("CI_MERGE_LANE"))?.[1]).toContain("(lane demo-lane: pane w:p1 missing, head abcdef1)");
  expect(ci.messages.get(id)?.state).toBe("superseded");
});

for (const [name, setup, reason] of [
  ["paused", async () => { await deps.registry.update(lane.key, () => ({ ...claimedLane, status: "paused" })); }, "lane paused"],
  ["agentless", () => { world.panes = [{ pane_id: "w:p1", workspace_id: "w" }]; }, "pane w:p1 runs no agent"],
  ["missing", () => { world.panes = []; }, "pane w:p1 missing"],
] as const) {
  test(`a conflicting PR whose lane is ${name} gets a merge lane and no rebase message`, async () => {
    await setup();
    const conflicting = pull({ conflicting: true, checks: "green" });
    const ci = follow({ launch: recordLaunch });
    await ci.tick([conflicting], emit);
    expect(launches).toEqual(["merge-app-7"]);
    expect(lines("CI_MERGE_LANE")[0]).toContain(`(lane demo-lane: ${reason}, head abcdef1)`);
    expect(ci.messages.get(rebaseMessageId(conflicting))).toBeUndefined();
  });
}

test("laneDown: a closed lane is down; an unreadable pane list counts as live", () => {
  expect(laneDown({ ...lane, closedAt: new Date(T0).toISOString() }, [idle])).toBe("lane closed");
  expect(laneDown(lane, [idle])).toBeUndefined();
  expect(laneDown(lane, new Error("herdr down"))).toBeUndefined();
});

test("a conflicting lane PR gets one merge lane through an operation; when none can start the lead hears CI_CONFLICT and nothing is retried", async () => {
  world.panes = [];
  const launch: CiIo["launch"] = async (d, request) => {
    launches.push(request.key);
    await d.registry.update(request.key, () => ({ ...lane, key: request.key, done: "merged acme/app#7", openedAt: new Date(clock.now()).toISOString() }));
    return { ok: true, detail: "STARTUP_OK" };
  };
  const conflicting = pull({ conflicting: true, checks: "green" });
  const ci = follow({ launch });
  await ci.tick([conflicting], emit);
  await ci.tick([conflicting], emit);
  expect(launches).toEqual([mergeLaneKey(conflicting)]);
  expect(lines("CI_MERGE_LANE")[0]).toStartWith("CI_MERGE_LANE merge-app-7 ");
  expect(gh.merges).toEqual([]);

  const other = pull({ number: 8, conflicting: true, checks: "green" });
  await deps.registry.update("lane-eight", () => ({ ...lane, key: "lane-eight", pane: "w:p8", done: "merged acme/app#8" }));
  const refused = follow({ launch: async (_d, request) => { launches.push(request.key); return { ok: false, detail: "HOLD load 160 >= 150" }; } });
  await refused.tick([other], emit);
  await refused.tick([other], emit);
  expect(launches).toEqual(["merge-app-7", "merge-app-8"]);
  expect(events.filter(([, l]) => l.startsWith("CI_CONFLICT"))).toHaveLength(1);
  expect(lines("CI_CONFLICT")).toEqual([expect.stringContaining("CI_CONFLICT acme/app#8 lane=lane-eight head=abcdef1 conflicts with dev and no merge lane could start: HOLD load 160 >= 150")]);
});

test("a brief's issue: line binds the lane to a GitHub issue; a malformed one refuses the launch", () => {
  expect(briefIssue("# Task\nissue: acme/app#5\n")).toBe("acme/app#5");
  expect(briefIssue("- `issue: acme/app#5`")).toBe("acme/app#5");
  expect(briefIssue("Background: the issue: see below")).toBeUndefined();
  expect(() => briefIssue("issue: #5")).toThrow(LaunchError);
});

test("an issue-bound lane's issue is closed with one comment once its PR is merged into dev, even after the lane closed; later polls and a restart close nothing more", async () => {
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#5" }));
  const ci = follow();
  await ci.tick([pull({ checks: "pending" })], emit);
  expect(gh.closes).toEqual([]);

  // The lane closes at its green PR; the lead merges afterwards.
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#5", closedAt: new Date(T0 + 2 * MIN).toISOString() }));
  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  const merged = [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }];
  await ci.tick([], emit, merged);
  await ci.tick([], emit, merged);
  await follow().tick([], emit, merged);
  expect(gh.closes).toEqual([["gh", "issue", "close", "5", "-R", "acme/app", "--comment", "Closed by dori: acme/app#7 (lane demo-lane) is merged into dev as m3rge5ha. https://github.com/acme/app/pull/7"]]);
  expect(lines("CI_ISSUE_CLOSED")).toEqual(["CI_ISSUE_CLOSED acme/app#5 lane=demo-lane after acme/app#7 merged into dev merge=m3rge5ha https://github.com/acme/app/pull/7"]);
  expect(eventClass(lines("CI_ISSUE_CLOSED")[0] ?? "", deps.config.eventPolicy)).toBe("lead-digest");
});

test("an issue is not closed for a PR merged into main, nor commented on when someone already closed it", async () => {
  await deps.registry.update(lane.key, () => ({ ...claimedLane, ghIssue: "acme/app#5" }));
  const ci = follow();
  await ci.tick([pull({ checks: "pending" })], emit);
  const merged = [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }];
  gh.view = greenView({ state: "MERGED", baseRefName: "main", mergeCommit: { oid: "m41n" } });
  await ci.tick([], emit, merged);
  expect(gh.closes).toEqual([]);

  gh.view = greenView({ state: "MERGED", mergeCommit: { oid: "m3rge5ha" } });
  gh.issue = "CLOSED";
  await follow().tick([], emit, merged);
  expect(gh.closes).toEqual([]);
  expect(lines("CI_ISSUE_CLOSED")).toEqual([]);
  expect(open[1]?.ops.get("demo-lane/close-issue/acme/app#5@acme/app#7")?.state).toBe("verified");
});

test("GH_PR checks_failing and conflicting are digest by default, unless eventPolicy names them", async () => {
  const file = join(state.dir, "config.json");
  writeFileSync(file, JSON.stringify({}));
  const plain = await loadConfig(file, "/home/test");
  expect(eventClass("GH_PR acme/app#7 checks_failing sha=x u", plain.eventPolicy)).toBe("lead-digest");
  expect(eventClass("GH_PR acme/app#7 conflicting sha=x u", plain.eventPolicy)).toBe("lead-digest");

  writeFileSync(file, JSON.stringify({ eventPolicy: { kinds: { "GH_PR * conflicting": "lead-urgent" } } }));
  const on = await loadConfig(file, "/home/test");
  expect(eventClass("GH_PR acme/app#7 checks_failing sha=x u", on.eventPolicy)).toBe("lead-digest");
  expect(eventClass("GH_PR acme/app#7 conflicting sha=x u", on.eventPolicy)).toBe("lead-urgent");
  expect(eventClass("LANE_MESSAGE_UNCONFIRMED demo-lane ci-app-7-abcdef1 x", on.eventPolicy)).toBe("lead-urgent");
  expect(eventClass("CI_CONFLICT acme/app#7 x", on.eventPolicy)).toBe("lead-urgent");
});
