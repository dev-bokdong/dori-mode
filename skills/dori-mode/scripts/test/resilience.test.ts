import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Runner } from "../src/run.ts";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, RetryingDelivery, STUCK_AFTER_MS, SuperviseError, Supervisor, TransientSuperviseError } from "../src/supervise.ts";
import { writeQuotaState } from "../src/claude-quota.ts";
import { recordLaunchVerdict } from "../src/routing.ts";
import { runSweeps, supervise, supervisorSweeps, WARN_REPEAT_MS } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState, readJournal, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;

/** A retrying delivery whose flush is scripted; time only moves when the test moves it. */
const scripted = (failWith: () => Error | undefined) => {
  const clock = fakeClock(T0);
  const enqueued: string[] = [];
  const notified: string[] = [];
  const logs: string[] = [];
  let flushes = 0;
  const delivery = new RetryingDelivery({
    now: clock.now,
    flush: async () => { flushes++; const e = failWith(); if (e) throw e; },
    repair: async () => undefined,
    enqueue: (_id, line) => { enqueued.push(line); },
    notify: async (text) => { notified.push(text); },
    log: (line) => { logs.push(line); },
  }, "boot");
  return { clock, delivery, enqueued, notified, logs, flushes: () => flushes };
};

test("a transient error retries instead of throwing, and backoff doubles up to the cap", async () => {
  const s = scripted(() => new TransientSuperviseError("lead pane lead:p1 does not exist"));
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    await s.delivery.tick();
    delays.push(s.delivery.nextAttemptAt - s.clock.at);
    expect(s.delivery.due).toBe(false);
    s.clock.at = s.delivery.nextAttemptAt;
    expect(s.delivery.due).toBe(true);
  }
  expect(delays).toEqual([BACKOFF_MIN_MS, 10_000, 20_000, 40_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
  expect(s.logs).toHaveLength(8);
  expect(s.logs[0]).toStartWith("SUPERVISOR_RETRY lead pane lead:p1 does not exist");
});

test("a fatal error is rethrown", async () => {
  const s = scripted(() => new SuperviseError("cannot acquire supervisor lock: busy"));
  await expect(s.delivery.tick()).rejects.toThrow("cannot acquire supervisor lock");
  const plain = scripted(() => new Error("boom"));
  await expect(plain.delivery.tick()).rejects.toThrow("boom");
});

test("after ten minutes of the same failure exactly one SUPERVISOR_STUCK is queued and posted", async () => {
  const s = scripted(() => new TransientSuperviseError("old lead has not exited; events retained"));
  while (s.clock.at - T0 < STUCK_AFTER_MS + 3 * BACKOFF_MAX_MS) {
    await s.delivery.tick();
    s.clock.at = s.delivery.nextAttemptAt;
  }
  expect(s.enqueued).toEqual(["SUPERVISOR_STUCK old lead has not exited; events retained"]);
  expect(s.notified).toEqual(s.enqueued);
});

test("the SUPERVISOR_STUCK channel post is scrubbed of home paths and pane ids; the lead's copy keeps them", async () => {
  const s = scripted(() => new TransientSuperviseError(`cannot stop owned lead process in wL1:p3 (${homedir()}/.dori/state)`));
  while (s.clock.at - T0 < STUCK_AFTER_MS + BACKOFF_MAX_MS) {
    await s.delivery.tick();
    s.clock.at = s.delivery.nextAttemptAt;
  }
  expect(s.enqueued).toEqual([`SUPERVISOR_STUCK cannot stop owned lead process in wL1:p3 (${homedir()}/.dori/state)`]);
  expect(s.notified).toEqual(["SUPERVISOR_STUCK cannot stop owned lead process in (pane) (~/.dori/state)"]);
});

/** The real supervisor sweeps over a registry and runner; the queue is what Supervisor.enqueue would receive. */
const sweepWorld = (fail: (argv: readonly string[]) => boolean) => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, state.dir);
  // A host with 200 GB free disk, no load reading and unknown memory: room for a launch once panes allow it.
  const run: Runner = async (argv) => (fail(argv) ? { code: 1, out: "", err: "herdr: server unreachable" }
    : argv[0] === "df" ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
    : base.run(argv));
  const deps = { ...base, run };
  const queue: string[] = [];
  const logs: string[] = [];
  const recent = new Map<string, number>();
  const sweeps = supervisorSweeps(deps, "/home/test", async () => ({ results: [], text: "" }));
  const tick = () => runSweeps(sweeps, async (line) => { queue.push(line); }, clock.now, recent, (line) => { logs.push(line); });
  return { deps, clock, queue, logs, tick, world };
};

test("a failing sweep never ends the supervisor or loses a done claim: the claim is enqueued, the failure is one digest warning", async () => {
  const w = sweepWorld((argv) => argv.join(" ") === "herdr pane list");
  await w.deps.registry.write({ key: "demo-lane", title: "d", thread: "none", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "merged acme/app#1 abc", emitted: false } });
  await w.tick();
  expect(w.queue).toContain("LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc");
  expect(w.queue).toContain("SWEEP_WARN dead-panes herdr pane list failed: herdr: server unreachable");
  expect((await w.deps.registry.read("demo-lane"))?.claim?.emitted).toBe(true);
  expect(w.logs).toContain("SWEEP_ERROR dead-panes herdr pane list failed: herdr: server unreachable");
  // The same failure on the next ticks is logged but not queued again within the hour.
  const queued = w.queue.length;
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("SWEEP_WARN dead-panes"))).toHaveLength(1);
  expect(w.queue.length).toBe(queued);
  w.clock.at += WARN_REPEAT_MS;
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("SWEEP_WARN dead-panes"))).toHaveLength(2);
});

test("a launch held by dori can-launch wakes the lead with LAUNCH_READY once the host has room, once", async () => {
  const w = sweepWorld(() => false);
  w.world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
  recordLaunchVerdict(w.deps.config.stateDir, { ok: false, reasons: ["panes 20 >= 20"] }, T0);
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("LAUNCH_READY "))).toHaveLength(1);
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("LAUNCH_READY "))).toHaveLength(1);
});

test("LAUNCH_READY waits while the cached Claude quota gate still holds lanes", async () => {
  const w = sweepWorld(() => false);
  w.world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
  recordLaunchVerdict(w.deps.config.stateDir, { ok: false, reasons: ["quota hold-lanes: Claude headroom 15% < 50% (a 15% by 5h)"] }, T0);
  writeQuotaState(w.deps.config.stateDir, { mode: "hold-lanes", usage: { at: T0, accounts: [{ name: "a", fiveHour: { usedPct: 85 } }] } });
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("LAUNCH_READY "))).toHaveLength(0);
  writeQuotaState(w.deps.config.stateDir, { mode: "ok", usage: { at: T0, accounts: [{ name: "a", fiveHour: { usedPct: 20 }, weekly: { usedPct: 30 } }] } });
  await w.tick();
  expect(w.queue.filter((line) => line.startsWith("LAUNCH_READY "))).toEqual([expect.stringContaining("Claude headroom 70%")]);
});

test("success resets the streak so a later failure starts its own ten minutes", async () => {
  let fail = true;
  const s = scripted(() => (fail ? new TransientSuperviseError("STARTUP_UNCONFIRMED x") : undefined));
  await s.delivery.tick();
  fail = false;
  s.clock.at = s.delivery.nextAttemptAt;
  await s.delivery.tick();
  expect(s.delivery.due).toBe(true);
  fail = true;
  s.clock.at += STUCK_AFTER_MS + 1;
  await s.delivery.tick();
  expect(s.enqueued).toEqual([]);
});

test("a missing lead pane keeps events and journal untouched, then delivers once the pane returns", async () => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const clock = fakeClock(T0);
  const supervisor = new Supervisor(depsFor(world, clock, state.dir));
  supervisor.enqueue("inbound:1", "INBOUND hello");
  const journal = JSON.stringify(readJournal(state.dir));
  const delivery = new RetryingDelivery({
    now: clock.now, flush: () => supervisor.flush(), repair: () => supervisor.repairLeadPane(),
    enqueue: () => {}, notify: async () => {}, log: () => {},
  }, "boot");
  await delivery.tick();
  expect(JSON.stringify(readJournal(state.dir))).toBe(journal);
  expect(readFileSync(supervisor.eventLog, "utf8")).toBe("");
  world.panes.push({ pane_id: "lead:p1", workspace_id: "w", cwd: "/repo", agent: "omo", agent_status: "working" });
  clock.at = delivery.nextAttemptAt;
  await delivery.tick();
  expect(readFileSync(supervisor.eventLog, "utf8")).toContain("INBOUND hello");
});

test("a vanished lead pane is recreated in the Dori workspace at defaultCwd, in memory only", async () => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, state.dir);
  const run: Runner = async (argv) => {
    if (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { workspaces: [{ workspace_id: "w7", label: "Dori" }] } }), err: "" };
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
      world.panes.push({ pane_id: "w7:p9", workspace_id: "w7", cwd: "/repo" });
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w7:p9" } } }), err: "" };
    }
    return base.run(argv);
  };
  const supervisor = new Supervisor({ ...base, run });
  expect(await supervisor.repairLeadPane()).toBe("w7:p9");
  expect(world.calls.some((c) => c.join(" ") === "herdr pane list")).toBe(true);
  expect(base.config.leadPane).toBe("lead:p1");
  expect(await supervisor.repairLeadPane()).toBeUndefined();
});

test("config validation still exits the supervisor", async () => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { cacheTtlMin: 0 });
  await expect(supervise(deps, new AbortController().signal)).rejects.toThrow("cacheTtlMin must be positive");
  expect(existsSync(join(state.dir, "supervisor-lock.sqlite"))).toBe(false);
});

test("a non-positive handledTimeoutMin exits the supervisor before it takes the lock", async () => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { handledTimeoutMin: 0 });
  await expect(supervise(deps, new AbortController().signal)).rejects.toThrow("handledTimeoutMin must be positive");
  expect(existsSync(join(state.dir, "supervisor-lock.sqlite"))).toBe(false);
});

test("a non-positive leadQuotaBusySwitchMin exits the supervisor before it takes the lock", async () => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { leadQuotaBusySwitchMin: 0 });
  await expect(supervise(deps, new AbortController().signal)).rejects.toThrow("leadQuotaBusySwitchMin must be positive");
  expect(existsSync(join(state.dir, "supervisor-lock.sqlite"))).toBe(false);
});

test("a non-positive leadStuckRestartMin exits the supervisor before it takes the lock", async () => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { leadStuckRestartMin: 0 });
  await expect(supervise(deps, new AbortController().signal)).rejects.toThrow("leadStuckRestartMin must be positive");
  expect(existsSync(join(state.dir, "supervisor-lock.sqlite"))).toBe(false);
});

test("a non-positive leadPrimaryReturnChecks exits the supervisor before it takes the lock", async () => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { leadPrimaryReturnChecks: 0 });
  await expect(supervise(deps, new AbortController().signal)).rejects.toThrow("leadPrimaryReturnChecks must be a positive integer");
  expect(existsSync(join(state.dir, "supervisor-lock.sqlite"))).toBe(false);
});

test("a recreated lead pane is persisted through the hook, and a failing hook does not undo the repair", async () => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), state.dir);
  const run: Runner = async (argv) => {
    if (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { workspaces: [{ workspace_id: "w7", label: "Dori" }] } }), err: "" };
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
      world.panes.push({ pane_id: "w7:p9", workspace_id: "w7", cwd: "/repo" });
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w7:p9" } } }), err: "" };
    }
    return base.run(argv);
  };
  const saved: string[] = [];
  expect(await new Supervisor({ ...base, run }, { persistLeadPane: (pane) => { saved.push(pane); } }).repairLeadPane()).toBe("w7:p9");
  expect(saved).toEqual(["w7:p9"]);
  world.panes.length = 0;
  const original = console.error;
  console.error = () => {};
  try {
    expect(await new Supervisor({ ...base, run }, { persistLeadPane: () => { throw new Error("read-only fs"); } }).repairLeadPane()).toBe("w7:p9");
  } finally { console.error = original; }
});

test("a vanished pane with a submitted launch moves the same events to a fresh session in the new pane", async () => {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), state.dir);
  const run: Runner = async (argv) => {
    if (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { workspaces: [{ workspace_id: "w7", label: "Dori" }] } }), err: "" };
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w7:p9" } } }), err: "" };
    return base.run(argv);
  };
  const old = "33333333-3333-4333-8333-333333333333";
  const events = [{ id: "x", line: "INBOUND x" }];
  writeJournal(state.dir, ({ events, restart: { session: old, events, offset: 7, phase: "submitted", unconfirmed: 3 } }));
  writeFileSync(join(state.dir, `lead-${old}.md`), "prompt");
  const original = console.log;
  console.log = () => {};
  try { expect(await new Supervisor({ ...base, run }).repairLeadPane()).toBe("w7:p9"); } finally { console.log = original; }
  const restart = readJournal(state.dir).restart;
  expect(restart).toMatchObject({ events, offset: 7, phase: "starting", unconfirmed: 0 });
  expect(restart.session).not.toBe(old);
  expect(existsSync(join(state.dir, `lead-${old}.md`))).toBe(false);
});
