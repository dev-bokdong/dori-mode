import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { adoptLane, launchLane, remoteRepo, type SharedThreadLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import {
  clearLaunchHold, dequeueLaunch, enqueueLaunch, journalQuotaBypass, launchGate, launchHeld, launchQueue, launchQueueText,
  otherOpenLanesOnThread, type QueuedLaunch, recordLaunchVerdict,
} from "../src/routing.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const guard = defaultConfig("/home/test").guard;
const roomy = { load1: 10, memFreePct: 45, diskFreeGb: 300, swapFreeGb: 2, panes: 6 };
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => { state = withState(); world = newWorld(); });
afterEach(() => state.done());

const queued = (key: string, patch: Partial<QueuedLaunch> = {}): QueuedLaunch => ({
  key, title: key, done: "merged acme/app#1", brief: `/briefs/${key}.md`, cwd: `/repos/${key}`, repos: ["acme/app"], thread: `thr-${key}`,
  queuedAt: "2026-01-01T12:00:00.000Z", reasons: ["panes 20 >= 20"], ...patch,
});

// Item 1: the HOLD queue
test("held launches persist in launch-hold.json and survive LAUNCH_READY clearing the hold", () => {
  recordLaunchVerdict(state.dir, { ok: false, reasons: ["panes 20 >= 20"] }, T0);
  enqueueLaunch(state.dir, queued("lane-a"));
  enqueueLaunch(state.dir, queued("lane-b", { queuedAt: "2026-01-01T12:05:00.000Z" }));
  expect(launchHeld(state.dir)).toBe(true);
  clearLaunchHold(state.dir);
  expect(launchHeld(state.dir)).toBe(false);
  expect(launchQueue(state.dir).map((q) => q.key)).toEqual(["lane-a", "lane-b"]);
  // A new HOLD raises the flag again and keeps the queue.
  recordLaunchVerdict(state.dir, { ok: false, reasons: ["memory free 5% < 20%"] }, T0 + 1);
  expect(launchHeld(state.dir)).toBe(true);
  expect(launchQueue(state.dir)).toHaveLength(2);
  recordLaunchVerdict(state.dir, { ok: true, reasons: [] }, T0 + 2);
  expect(launchQueue(state.dir)).toHaveLength(2);
});

test("re-queueing a key keeps its first queued-at time; items leave only when dropped or launched", () => {
  enqueueLaunch(state.dir, queued("lane-a"));
  const q = enqueueLaunch(state.dir, queued("lane-a", { queuedAt: "2026-01-02T00:00:00.000Z", reasons: ["disk"] }));
  expect(q).toHaveLength(1);
  expect(q[0]).toMatchObject({ queuedAt: "2026-01-01T12:00:00.000Z", reasons: ["disk"] });
  expect(dequeueLaunch(state.dir, "missing")).toBe(false);
  expect(dequeueLaunch(state.dir, "lane-a")).toBe(true);
  expect(launchQueue(state.dir)).toEqual([]);
});

test("an older launch-hold.json without a blocked flag still counts as held", () => {
  writeFileSync(join(state.dir, "launch-hold.json"), JSON.stringify({ at: T0, reasons: ["panes 20 >= 20"] }));
  expect(launchHeld(state.dir)).toBe(true);
  expect(launchQueue(state.dir)).toEqual([]);
});

test("the LAUNCH_READY text lists every queued launch with key, cwd, repo, thread, Done, brief and queued-at", () => {
  expect(launchQueueText([])).toBe("");
  const text = launchQueueText([queued("lane-a"), queued("lane-b", { thread: "none", cwd: undefined })]);
  expect(text).toStartWith("; queued launches (2): lane-a cwd=/repos/lane-a repo=acme/app thread=thr-lane-a ");
  expect(text).toContain('done="merged acme/app#1" brief=/briefs/lane-a.md queued 2026-01-01T12:00:00.000Z');
  expect(text).toContain("; lane-b repo=acme/app done=");
  expect(text).not.toContain("thread=none");
});

// Items 2, 5, 6: the launch gate
test("dori launch's gate holds on host memory, disk and pane limits", () => {
  expect(launchGate({ key: "k", sample: roomy, guard })).toEqual({ lines: [] });
  expect(launchGate({ key: "k", sample: { ...roomy, memFreePct: 5 }, guard }).hold).toBe("memory free 5% < 20%");
  expect(launchGate({ key: "k", sample: { ...roomy, diskFreeGb: 3, panes: 20 }, guard }).hold).toBe("disk free 3 GB < 50 GB | panes 20 >= 20");
  expect(launchGate({ key: "k", sample: roomy, guard, quotaHold: "quota hold-lanes: Claude 5h 85% >= 80%" }).hold).toBe("quota hold-lanes: Claude 5h 85% >= 80%");
});

test("--ignore-quota needs a reason, lifts only the quota gate, and yields an OWNER_NOTICE line", () => {
  const hold = "quota hold-lanes: Claude 5h 85% >= 80%";
  expect(launchGate({ key: "k", sample: roomy, guard, quotaHold: hold, ignoreQuota: true }).error).toContain("--reason");
  expect(launchGate({ key: "k", sample: roomy, guard, quotaHold: hold, ignoreQuota: true, reason: "  " }).error).toContain("--reason");
  const ok = launchGate({ key: "k", sample: roomy, guard, quotaHold: hold, ignoreQuota: true, reason: "owner asked for the hotfix now" });
  expect(ok.hold).toBeUndefined();
  expect(ok.lines).toEqual([`OWNER_NOTICE lane k is launching past the Claude quota gate with --ignore-quota (${hold}); reason: owner asked for the hotfix now`]);
  // The host guard is never bypassed.
  const host = launchGate({ key: "k", sample: { ...roomy, memFreePct: 5 }, guard, quotaHold: hold, ignoreQuota: true, reason: "r" });
  expect(host.hold).toBe("memory free 5% < 20%");
  expect(host.lines.some((l) => l.startsWith("OWNER_NOTICE"))).toBe(false);
});

test("a quota bypass is journaled with its reason", () => {
  journalQuotaBypass(state.dir, { key: "k", reason: "hotfix", quotaHold: "quota hold", at: T0 });
  journalQuotaBypass(state.dir, { key: "k2", reason: "again", at: T0 });
  const lines = readFileSync(join(state.dir, "quota-bypass.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([{ key: "k", reason: "hotfix", quotaHold: "quota hold", at: "2026-01-01T12:00:00.000Z" }, { key: "k2", reason: "again", at: "2026-01-01T12:00:00.000Z" }]);
});

test("panesMax 0 means unlimited panes, with a warning on every launch", () => {
  const open = { ...guard, panesMax: 0 };
  const g = launchGate({ key: "k", sample: { ...roomy, panes: 500 }, guard: open });
  expect(g.hold).toBeUndefined();
  expect(g.lines).toEqual([expect.stringMatching(/^LAUNCH_WARN guard\.panesMax is 0: the pane-count limit is off/)]);
  expect(launchGate({ key: "k", sample: { ...roomy, memFreePct: 1 }, guard: open }).lines[0]).toStartWith("LAUNCH_WARN");
});

// Items 3 and 4: placement and threads
/** deps whose git knows checkouts: dir -> [toplevel, remote url]; a new tab is created for each launch. */
const deps = (repos: Record<string, readonly [string, string]> = {}) => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  return {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "git" && argv[1] === "-C") {
        world.calls.push([...argv]);
        const dir = argv[2] ?? "";
        const repo = repos[dir] ?? Object.values(repos).find(([top]) => top === dir);
        if (argv[3] === "rev-parse") return repo ? { code: 0, out: `${repo[0]}\n`, err: "" } : { code: 128, out: "", err: "not a git repository" };
        if (argv[3] === "remote") return { code: 0, out: repo ? `origin\t${repo[1]} (fetch)\norigin\t${repo[1]} (push)\n` : "", err: "" };
      }
      if (argv[1] === "tab" && argv[2] === "create") { world.calls.push([...argv]); return { code: 0, out: JSON.stringify({ result: { tab_id: "w:t9", root_pane: { pane_id: `w:p${world.calls.length}` } } }), err: "" }; }
      return base.run(argv);
    },
  };
};
const brief = () => { const b = join(state.dir, `brief-${Math.random()}.md`); writeFileSync(b, "goal\n"); return b; };
const input = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, brief: brief(), done: "merged acme/app#1", ...extra });
const tabs = () => world.calls.filter((c) => c[1] === "tab" && c[2] === "create");

test("git remote URLs of every common form name their owner/repo", () => {
  expect(remoteRepo("git@github.com:Acme/App.git")).toBe("acme/app");
  expect(remoteRepo("https://github.com/acme/app.git")).toBe("acme/app");
  expect(remoteRepo("https://github.com/acme/app")).toBe("acme/app");
  expect(remoteRepo("ssh://git@github.com/acme/my.app.git")).toBe("acme/my.app");
});

test("a second open lane in the same git checkout is refused before anything is created", async () => {
  const d = deps({ "/repos/app": ["/repos/app", "git@github.com:acme/app.git"], "/repos/app/sub": ["/repos/app", "git@github.com:acme/app.git"] });
  await launchLane(d, input("first-lane", { cwd: "/repos/app" }));
  expect(tabs()).toHaveLength(1);
  await expect(launchLane(d, input("second-lane", { cwd: "/repos/app/sub" }))).rejects.toThrow("is the checkout open lane first-lane works in");
  await expect(adoptLane(d, { ...input("adopted-lane", { cwd: "/repos/app" }), pane: "w:p77" })).rejects.toThrow("first-lane");
  expect(tabs()).toHaveLength(1);
  expect(await d.registry.read("second-lane")).toBeNull();
  // Closed lanes free their checkout; directories outside git are never refused.
  const first = await d.registry.read("first-lane");
  if (first) await d.registry.write({ ...first, closedAt: new Date(T0).toISOString() });
  await launchLane(d, input("third-lane", { cwd: "/repos/app" }));
  await launchLane(d, input("plain-a", { cwd: "/scratch" }));
  await launchLane(d, input("plain-b", { cwd: "/scratch" }));
  expect(tabs()).toHaveLength(4);
});

test("a cwd whose git remotes name none of the Done line's repos is refused unless --allow-repo-mismatch", async () => {
  const d = deps({ "/repos/other": ["/repos/other", "https://github.com/acme/other.git"] });
  await expect(launchLane(d, input("wrong-repo", { cwd: "/repos/other" }))).rejects.toThrow("is a checkout of acme/other, but the Done line names acme/app");
  expect(tabs()).toHaveLength(0);
  const r = await launchLane(d, input("wrong-repo", { cwd: "/repos/other", allowRepoMismatch: true }));
  expect(r.lane.cwd).toBe("/repos/other");
  // A Done line that also names the cwd's repo matches.
  const d2 = deps({ "/repos/other2": ["/repos/other2", "https://github.com/acme/other.git"] });
  await launchLane(d2, input("two-repos", { cwd: "/repos/other2", done: "merged acme/app#1; closed acme/other#2" }));
});

test("a second open lane on the same thread is refused unless --share-thread, which records the sharing", async () => {
  const d = deps();
  await launchLane(d, input("thread-a", { cwd: "/scratch", thread: "discord:123" }));
  await expect(launchLane(d, input("thread-b", { cwd: "/scratch", thread: "discord:123" }))).rejects.toThrow("thread discord:123 already has open lane thread-a; one thread per lane, or pass --share-thread");
  await expect(adoptLane(d, { ...input("thread-c", { thread: "discord:123" }), pane: "w:p70" })).rejects.toThrow("--share-thread");
  const b = await launchLane(d, input("thread-b", { cwd: "/scratch", thread: "discord:123", shareThread: true }));
  expect(((await d.registry.read("thread-b")) as SharedThreadLane | null)?.threadSharedWith).toEqual(["thread-a"]);
  expect((b.lane as SharedThreadLane).threadSharedWith).toEqual(["thread-a"]);
  const c = await adoptLane(d, { ...input("thread-c", { thread: "discord:123", shareThread: true }), pane: "w:p70" }) as SharedThreadLane;
  expect([...(c.threadSharedWith ?? [])].sort()).toEqual(["thread-a", "thread-b"]);
  // "none" is never a shared thread.
  await launchLane(d, input("no-thread-1", { cwd: "/scratch" }));
  await launchLane(d, input("no-thread-2", { cwd: "/scratch" }));
});

for (const conflict of ["key", "thread", "checkout"] as const) {
  test(`launch reservation refuses a concurrent ${conflict} conflict before a second tab is created`, async () => {
    // Given the first launch paused at its first external write, after admission.
    const base = deps(conflict === "checkout" ? { "/repos/app": ["/repos/app", "git@github.com:acme/app.git"] } : {});
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    let creates = 0;
    const d = { ...base, run: async (argv: readonly string[]) => {
      if (argv[1] === "tab" && argv[2] === "create" && ++creates === 1) {
        entered.resolve();
        await proceed.promise;
      }
      return base.run(argv);
    } };
    const placement = conflict === "checkout" ? { cwd: "/repos/app" } : { cwd: "/scratch" };
    const first = launchLane(d, input("first-lane", { ...placement, thread: "discord:one" }));
    let error: unknown;
    try {
      await entered.promise;
      // When a second launch races while the first has not yet registered its agent.
      await launchLane(d, input(conflict === "key" ? "first-lane" : "second-lane", {
        ...placement, thread: conflict === "thread" ? "discord:one" : "discord:two",
      })).catch((caught: unknown) => { error = caught; });
    } finally { proceed.resolve(); await first; }
    // Then only one agent creation was admitted.
    expect(error).toBeInstanceOf(Error);
    expect(creates).toBe(1);
    expect((await d.registry.read("first-lane"))?.launchReservation).toBeUndefined();
  });
}

test("a failed launch releases only its reservation and allows retrying the key", async () => {
  const base = deps();
  const entry = input("retry-lane", { cwd: "/scratch" });
  const d = { ...base, run: async (argv: readonly string[]) => argv[1] === "tab" && argv[2] === "create"
    ? { code: 1, out: "", err: "create failed" } : base.run(argv) };
  await expect(launchLane(d, entry)).rejects.toThrow("create failed");
  expect(await d.registry.read(entry.key)).toBeNull();
  await expect(launchLane(base, entry)).resolves.toMatchObject({ lane: { key: entry.key } });
});

test("a registration failure after agent admission keeps its paused reservation and pane visible", async () => {
  const base = deps();
  let admitted = false;
  const update = base.registry.update.bind(base.registry);
  const spy = spyOn(base.registry, "update").mockImplementation((key, mutate) => {
    if (admitted) return Promise.reject(new Error("registration disk error"));
    return update(key, mutate);
  });
  const d = { ...base, run: async (argv: readonly string[]) => {
    if (argv[1] === "pane" && argv[2] === "run") admitted = true;
    return base.run(argv);
  } };
  try {
    await expect(launchLane(d, input("visible-lane", { cwd: "/scratch" }))).rejects.toThrow("registration disk error");
    expect(await d.registry.read("visible-lane")).toMatchObject({ status: "paused", pane: expect.any(String), launchReservation: expect.any(String) });
  } finally { spy.mockRestore(); }
});

test("otherOpenLanesOnThread tells the done flow whether the thread still has an open lane", () => {
  const lane = (key: string, thread: string, closed = false): Lane => ({ key, title: key, thread, brief: "", done: "", openedAt: "2026-01-01T00:00:00Z", ...(closed ? { closedAt: "2026-01-02T00:00:00Z" } : {}) });
  const lanes = [lane("a", "t1"), lane("b", "t1"), lane("c", "t1", true), lane("d", "t2"), lane("e", "none"), lane("f", "none")];
  expect(otherOpenLanesOnThread(lanes, lanes[0] as Lane).map((l) => l.key)).toEqual(["b"]);
  expect(otherOpenLanesOnThread(lanes, lanes[3] as Lane)).toEqual([]);
  expect(otherOpenLanesOnThread(lanes, lanes[4] as Lane)).toEqual([]);
});

// The CLI paths that need no host or network
const cli = async (args: string[], held = false) => {
  const proc = Bun.spawn(["bun", ...(held ? ["--preload", join(import.meta.dir, "fixtures/held-cli-preload.ts")] : []), join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, DORI_CONFIG: join(state.dir, "no-config.json"), DORI_STATE_DIR: state.dir, HOME: state.dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
};

test("dori hold list prints the queue and dori hold drop removes one item", async () => {
  enqueueLaunch(state.dir, queued("lane-a"));
  enqueueLaunch(state.dir, queued("lane-b"));
  const list = await cli(["hold", "list"]);
  expect(list.code).toBe(0);
  expect((JSON.parse(list.out) as QueuedLaunch[]).map((q) => q.key)).toEqual(["lane-a", "lane-b"]);
  expect(await cli(["hold", "drop", "lane-a"])).toMatchObject({ code: 0, out: "HOLD_DROPPED lane-a\n" });
  expect(launchQueue(state.dir).map((q) => q.key)).toEqual(["lane-b"]);
  expect((await cli(["hold", "drop", "lane-a"])).code).toBe(1);
  expect((await cli(["hold"])).code).toBe(1);
});

test("dori launch --ignore-quota without --reason is refused before anything runs", async () => {
  const r = await cli(["launch", "k-lane", "--title", "t", "--brief", join(state.dir, "b.md"), "--done", "merged acme/app#1", "--ignore-quota"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--ignore-quota needs --reason");
});

test("dori launch validates Done before a host HOLD can enqueue it", async () => {
  const r = await cli(["launch", "bad-done", "--title", "t", "--brief", "/b.md", "--done", "just do it"], true);
  expect(r.code).toBe(1);
  expect(r.err).toContain("Done line is not checkable");
  expect(launchQueue(state.dir)).toEqual([]);
  expect(launchHeld(state.dir)).toBe(false);
});

test("dori launch refuses an existing key before a host HOLD can enqueue it", async () => {
  await adoptLane(deps(), { ...input("existing-lane", { cwd: "/scratch" }), pane: "w:p1" });
  const r = await cli(["launch", "existing-lane", "--title", "t", "--brief", "/b.md", "--done", "merged acme/app#1"], true);
  expect(r.code).toBe(1);
  expect(r.err).toContain("already registered");
  expect(launchQueue(state.dir)).toEqual([]);
  expect(launchHeld(state.dir)).toBe(false);
});

test("dori launch atomically queues a valid launch with its host HOLD", async () => {
  const r = await cli(["launch", "held-lane", "--title", "t", "--brief", "/b.md", "--done", "merged acme/app#1"], true);
  expect(r.code).toBe(4);
  expect(launchQueue(state.dir).map((q) => q.key)).toEqual(["held-lane"]);
  expect(launchHeld(state.dir)).toBe(true);
});

test("a brief declaring autoClose: machine is recorded on the lane and in its footer; an unknown value is refused", async () => {
  const declared = (text: string) => { const b = join(state.dir, `brief-${Math.random()}.md`); writeFileSync(b, text); return b; };
  const machine = declared("goal\n\n- autoClose: machine\n");
  const launched = await launchLane(deps(), { ...input("auto-lane"), brief: machine });
  expect(launched.lane.autoClose).toBe("machine");
  expect(readFileSync(machine, "utf8")).toContain("- autoClose: machine. When the Done signals read back live the lane closes on its own");
  const adopted = await adoptLane(deps(), { ...input("auto-adopted", { cwd: "/scratch" }), brief: declared("autoClose: machine\n"), pane: "w:p5" });
  expect(adopted.autoClose).toBe("machine");
  expect((await launchLane(deps(), { ...input("lead-lane", { cwd: "/scratch2" }), brief: declared("autoClose: lead\n") })).lane.autoClose).toBeUndefined();
  await expect(launchLane(deps(), { ...input("odd-lane", { cwd: "/scratch3" }), brief: declared("autoClose: sometimes\n") })).rejects.toThrow("autoClose: sometimes");
  expect(await deps().registry.read("odd-lane")).toBeNull();
});
