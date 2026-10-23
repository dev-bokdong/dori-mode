import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane, watchTick } from "../src/done-flow.ts";
import { openOperations, plan, settleOperation } from "../src/operations.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { run as realRun, type Runner } from "../src/run.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, TEST_STORE, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

// beforeEach and every close run real git subprocesses (init, clone, push, worktree add/remove, update-ref); on a CI runner
// shared with `bun test --parallel` workers that took >5 s. Nothing but the awaited process marks "git is done", so there is
// no event to wait on: the budget only bounds a hang, it does not pace the test.
setDefaultTimeout(30_000);

let state: ReturnType<typeof withState>;
let world: World;
let repo: string;
let wt: string;
let mergedHead: string;
/** What `gh pr list --state merged --head <branch>` answers: the PRs merged from a worktree's branch. */
let mergedFromBranch: object[];

const git = async (...args: string[]): Promise<string> => {
  const r = await realRun(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};
const commit = async (dir: string, file: string): Promise<string> => {
  writeFileSync(join(dir, file), file);
  await git("-C", dir, "add", file);
  await git("-C", dir, "commit", "-q", "-m", file);
  return git("-C", dir, "rev-parse", "HEAD");
};
const localTip = async (): Promise<string | undefined> => {
  const r = await realRun(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/feat-x"]);
  return r.code === 0 ? r.out.trim() : undefined;
};
const remoteTip = async (): Promise<string> => (await git("-C", repo, "ls-remote", "origin", "refs/heads/feat-x")).split(/\s+/)[0] ?? "";

/** git runs for real; gh answers that acme/app#7 merged feat-x at `mergedHead` into main; herdr is the fake. */
const runner = (): Runner => {
  const fake = depsFor(world, fakeClock(T0), state.dir).run;
  return async (argv, opts) => {
    if (argv[0] === "git" || argv[0] === "bash") { world.calls.push([...argv]); return realRun(argv, opts); }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") {
      world.calls.push([...argv]);
      return { code: 0, err: "", out: JSON.stringify(mergedFromBranch) };
    }
    if (argv[0] === "gh" && argv[1] === "pr") {
      world.calls.push([...argv]);
      return { code: 0, err: "", out: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "f".repeat(40) }, headRefName: "feat-x", headRefOid: mergedHead, baseRefName: "main", isCrossRepository: false }) };
    }
    return fake(argv, opts);
  };
};
const deps = (patch: Parameters<typeof depsFor>[3] = {}) =>
  ({ ...depsFor(world, fakeClock(T0), state.dir, { defaultCwd: repo, worktreeRoot: state.dir, ...patch }), run: runner(), exists: undefined });
const lane = (): Lane => ({ key: "demo-lane", title: "demo", thread: "none", pane: "w:p1", brief: "/b.md", done: "merged acme/app#7", cwd: wt, worktrees: [wt], openedAt: new Date(T0).toISOString() });
const updateRefs = () => world.calls.filter((c) => c.includes("update-ref"));
const receipt = (lines: readonly string[]): string[] => JSON.parse(lines.at(-1)?.split(" ").slice(2).join(" ") ?? "{}").cleanup;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  if (TEST_STORE === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  const origin = join(state.dir, "acme", "app.git");
  mkdirSync(join(state.dir, "acme"));
  repo = join(state.dir, "repo");
  wt = join(state.dir, "wt", "demo-lane");
  await git("init", "-q", "--bare", "-b", "main", origin);
  await git("clone", "-q", origin, repo);
  await commit(repo, "init");
  await git("-C", repo, "push", "-q", "origin", "HEAD:main");
  await git("-C", repo, "worktree", "add", "-q", "-b", "feat-x", wt);
  mergedHead = await commit(wt, "feature");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  mergedFromBranch = [];
  await deps().registry.write(lane());
});
afterEach(() => state.done());

test("a branch still at the merged head SHA loses its worktree and its local branch, as one verified operation", async () => {
  const r = await closeLane(deps(), lane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
  expect(receipt(r.lines)).toContain(`branch feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)})`);
  expect(updateRefs()).toEqual([["git", "--git-dir", join(repo, ".git"), "update-ref", "-d", "refs/heads/feat-x", mergedHead]]);
  const ops = openOperations({ stateDir: state.dir, store: TEST_STORE });
  try {
    expect(ops.get(`demo-lane/branch-delete/acme/app#7@${mergedHead}`)?.state).toBe("verified");
    expect(ops.get(`demo-lane/remote-branch-delete/acme/app#7@${mergedHead}`)?.state).toBe("verified");
  } finally { ops.close(); }
  expect(receipt(r.lines)).toContain(`remote branch origin/feat-x deleted (acme/app#7 merged head ${mergedHead.slice(0, 10)})`);
  expect(await remoteTip()).toBe("");
});

test("a commit pushed after the merge keeps the worktree and the branch, says why, and the closed-lane sweep leaves them", async () => {
  const later = await commit(wt, "after-merge");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  const r = await closeLane(deps(), lane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(later);
  expect(receipt(r.lines)).toContain(`branch-bound worktree ${wt} kept: branch feat-x tip ${later.slice(0, 10)} is not the merged head ${mergedHead.slice(0, 10)} of acme/app#7`);
  expect(receipt(r.lines)).toContain(`branch feat-x kept: tip ${later.slice(0, 10)} is not the merged head ${mergedHead.slice(0, 10)} of acme/app#7 (a commit after the merge)`);
  expect(updateRefs()).toEqual([]);
  expect(await watchTick(deps())).toEqual([]);
  expect(existsSync(wt)).toBe(true);
  expect(statusOf((await deps().registry.read("demo-lane")) ?? lane())).toBe("closed");
});

test("a remote branch that moved after the merge keeps the local branch even when the local tip is the merged head", async () => {
  await commit(wt, "pushed-elsewhere");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  await git("-C", wt, "reset", "-q", "--hard", mergedHead);
  const r = await closeLane(deps(), lane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBe(mergedHead);
  expect(receipt(r.lines).some((l) => l.startsWith(`branch feat-x kept: origin/feat-x is at `) && l.includes("a commit pushed after the merge"))).toBe(true);
  expect(updateRefs()).toEqual([]);
});

test("another open lane naming the same PR keeps the branch", async () => {
  await deps().registry.write({ ...lane(), key: "other-lane", pane: "w:p2", cwd: repo, worktrees: [] });
  const r = await closeLane(deps(), lane(), "manual");
  expect(r.closed).toBe(true);
  expect(await localTip()).toBe(mergedHead);
  expect(receipt(r.lines)).toContain("branch feat-x kept: open lane other-lane also names acme/app#7");
});

test("a close interrupted after the worktree went still deletes the branch on resume, from the git dir it recorded", async () => {
  const base = deps();
  const crashing: Runner = async (argv, opts) => {
    if (argv.includes("ls-remote")) throw new Error("killed");
    return base.run(argv, opts);
  };
  await expect(closeLane({ ...base, run: crashing }, lane(), "manual")).rejects.toThrow("killed");
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBe(mergedHead);
  const lines = await watchTick(deps());
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(lines[0]).toContain("branch feat-x deleted");
  expect(await localTip()).toBeUndefined();
});

/** A lane launched in its worktree (cwd), named apart from its branch, whose Done line names no PR (the usual launch). */
const branchLane = (): Lane => ({ ...lane(), key: "plain-lane", done: 'command ["bash","-c","echo OK"] stdout~"OK"', worktrees: undefined });
const mergedPr = (sha: string) => ({ number: 9, headRefName: "feat-x", headRefOid: sha, baseRefName: "dev", isCrossRepository: false });

test("a lane whose worktree branch has a PR merged into dev loses its worktree, local and remote branch with no merged Done signal", async () => {
  mergedFromBranch = [mergedPr(mergedHead)];
  await deps().registry.write(branchLane());
  const r = await closeLane(deps(), branchLane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
  expect(await remoteTip()).toBe("");
  expect(receipt(r.lines)).toEqual([
    `worktree ${wt} removed`,
    `remote branch origin/feat-x deleted (acme/app#9 merged head ${mergedHead.slice(0, 10)})`,
    `branch feat-x deleted (acme/app#9 merged head ${mergedHead.slice(0, 10)})`,
    "pane w:p1 closed",
  ]);
  expect(world.calls.find((c) => c[0] === "gh" && c[2] === "list")).toEqual(["gh", "pr", "list", "--repo", "acme/app", "--state", "merged", "--base", "dev", "--head", "feat-x", "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository", "--limit", "20"]);
});

test("a lane whose worktree branch has no merged PR keeps its worktree and both branches", async () => {
  await deps().registry.write(branchLane());
  const r = await closeLane(deps(), branchLane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(mergedHead);
  expect(await remoteTip()).toBe(mergedHead);
  expect(updateRefs()).toEqual([]);
  expect(world.calls.filter((c) => c.includes("push"))).toEqual([]);
});

test("a worktree branch that moved past its merged PR keeps its worktree and both branches", async () => {
  mergedFromBranch = [mergedPr(mergedHead)];
  const later = await commit(wt, "after-merge");
  await git("-C", wt, "push", "-q", "origin", "feat-x");
  await deps().registry.write(branchLane());
  const r = await closeLane(deps(), branchLane(), "manual");
  expect(r.closed).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(await localTip()).toBe(later);
  expect(await remoteTip()).toBe(later);
  expect(receipt(r.lines)).toContain(`branch feat-x kept: tip ${later.slice(0, 10)} is not the merged head ${mergedHead.slice(0, 10)} of acme/app#9 (a commit after the merge)`);
  expect(world.calls.filter((c) => c.includes("push") || c.includes("update-ref") || (c.includes("worktree") && c.includes("remove")))).toEqual([]);
});

/** The lane claimed done one minute ago: its five-minute window is still open. */
const claimed = (): Lane => ({ ...branchLane(), status: "done-claimed", claim: { at: new Date(T0 - 60_000).toISOString(), evidence: "PR green", emitted: true } });

test("a done-claimed lane whose PR the supervisor merged (CI_MERGED) closes at once, with its branch cleanup", async () => {
  await deps().registry.write(claimed());
  const ops = openOperations({ stateDir: state.dir, store: TEST_STORE });
  try {
    const op = plan(ops, T0, { lane: "plain-lane", action: "merge", target: `acme/app#9@${mergedHead}` });
    settleOperation(ops, T0, op.id, "verified", "");
  } finally { ops.close(); }
  mergedFromBranch = [mergedPr(mergedHead)];
  const lines = await watchTick(deps());
  expect(lines[0]).toStartWith("LANE_CLOSED plain-lane");
  expect(statusOf((await deps().registry.read("plain-lane")) ?? lane())).toBe("closed");
  expect(existsSync(wt)).toBe(false);
  expect(await localTip()).toBeUndefined();
});

test("a done-claimed lane whose worktree branch GitHub reports merged at its HEAD closes at once", async () => {
  await deps().registry.write(claimed());
  mergedFromBranch = [mergedPr(mergedHead)];
  const lines = await watchTick(deps());
  expect(lines[0]).toStartWith("LANE_CLOSED plain-lane");
  expect(lines[0]).toContain("closed at once: acme/app#9 merged into dev");
});

test("a done-claimed lane with no merged PR waits out its claim window", async () => {
  await deps().registry.write(claimed());
  expect(await watchTick(deps())).toEqual([]);
  expect(statusOf((await deps().registry.read("plain-lane")) ?? lane())).toBe("done-claimed");
  expect(existsSync(wt)).toBe(true);
});

