import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { EventSources, readSourceStatus, SourceError, SourceSpecs } from "../src/event-sources.ts";
import { openOperations, type OperationStore, plan, settleOperation } from "../src/operations.ts";
import type { Ran, Runner } from "../src/run.ts";
import { nextCron, nextSlot, parseCron, queueRunNow, SCHEDULE_ACTION, scheduleRow, type ScheduleSpec } from "../src/schedule.ts";
import { collectStatus, renderStatus } from "../src/status.ts";
import { supervise } from "../src/supervise-loop.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, manualPause, newWorld, readJournal, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const done of cleanups.splice(0).reverse()) done();
});

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
/** 2026-10-22 21:00 KST: the jobs are added here. */
const SINCE = Date.UTC(2026, 9, 22, 12, 0);
/** 09:00 KST on 2026-10-23 and the days after. */
const nineKst = (day: number): number => Date.UTC(2026, 9, day, 0, 0);

type Heavy = { free: string | undefined; taken: string[]; released: string[] };

/**
 * One supervisor run on a state dir: a Supervisor, its operation store and a source registry running the schedules.
 * `restart` closes them all and opens new ones on the same dir, as a supervisor restart does.
 */
const world = (run: Runner = async () => ok()) => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(SINCE);
  const deps = depsFor(newWorld(), clock, state.dir, { eventPolicy: resolveEventPolicy({ kinds: {} }) });
  const heavy: Heavy = { free: "slot.1", taken: [], released: [] };
  let open: { supervisor: Supervisor; ops: OperationStore; sources: EventSources } | undefined;
  const start = () => {
    const supervisor = new Supervisor(deps);
    const ops = openOperations(deps.config);
    const sources = new EventSources({
      stateDir: state.dir, enqueue: (id, line) => supervisor.enqueue(id, line), now: clock.now, run, policy: deps.config.eventPolicy,
      schedules: {
        operations: ops, journaled: (id) => supervisor.journaled(id),
        heavy: {
          take: async (label) => { if (heavy.free === undefined) return undefined; heavy.taken.push(label); return heavy.free; },
          release: (slot) => { heavy.released.push(slot); },
        },
      },
    });
    open = { supervisor, ops, sources };
  };
  const stop = () => {
    if (!open) return;
    open.sources.close();
    open.ops.close();
    open.supervisor.close();
    open = undefined;
  };
  cleanups.push(stop);
  start();
  const live = () => open ?? (() => { throw new Error("stopped"); })();
  return {
    dir: state.dir, clock, deps, heavy,
    /** One registry pass, then wait for the jobs it started. */
    tick: async () => { await live().sources.tick(); await live().sources.settled(); },
    restart: () => { stop(); start(); },
    ops: () => live().ops,
    events: (): { id: string; line: string }[] => readJournal(state.dir).events,
    lines: (prefix: string): string[] => readJournal(state.dir).events.map((event: { line: string }) => event.line).filter((line: string) => line.startsWith(prefix)),
    specs: new SourceSpecs(state.dir),
  };
};

test("cron in Asia/Seoul: weekday, list and step fields, and both day fields restricted means either", () => {
  // Saturday 2026-10-24 12:00 KST -> Monday 08:30 KST.
  expect(new Date(nextCron(parseCron("30 8 * * 1-5"), "Asia/Seoul", Date.UTC(2026, 9, 24, 3, 0)) ?? 0).toISOString()).toBe("2026-10-25T23:30:00.000Z");
  expect(new Date(nextCron(parseCron("*/15 9-10 * * *"), "Asia/Seoul", Date.UTC(2026, 9, 23, 0, 50)) ?? 0).toISOString()).toBe("2026-10-23T01:00:00.000Z");
  // Day 1 of the month or a Sunday, whichever is first: Sunday 2026-10-25.
  expect(new Date(nextCron(parseCron("0 0 1 * 0"), "Asia/Seoul", Date.UTC(2026, 9, 23, 0, 0)) ?? 0).toISOString()).toBe("2026-10-24T15:00:00.000Z");
  expect(new Date(nextCron(parseCron("@daily"), "UTC", Date.UTC(2026, 9, 23, 0, 0)) ?? 0).toISOString()).toBe("2026-10-24T00:00:00.000Z");
  for (const bad of ["0 9 * *", "60 * * * *", "0 9 * * mon", "5-1 * * * *"]) expect(() => parseCron(bad)).toThrow(SourceError);
  const specs = new SourceSpecs(withState().dir);
  const base = { type: "schedule", kind: "BRIEF", text: "x", since: SINCE };
  expect(() => specs.add({ ...base, name: "never", cron: "0 0 31 2 *" })).toThrow("never fires");
  expect(() => specs.add({ ...base, name: "both", cron: "0 9 * * *", everySec: 60 })).toThrow("exactly one of cron and everySec");
  expect(() => specs.add({ ...base, name: "fast", everySec: 10 })).toThrow("at least 60");
  expect(() => specs.add({ ...base, name: "zone", cron: "0 9 * * *", tz: "Mars/Olympus" })).toThrow("not a known time zone");
  expect(() => specs.add({ ...base, name: "heavyemit", cron: "0 9 * * *", heavy: true })).toThrow("for command jobs");
  expect(() => specs.add({ ...base, name: "reserved", kind: "SCHEDULE_FAILED", cron: "0 9 * * *" })).toThrow("built-in event kind");
  expect(specs.add({ ...base, name: "ok", cron: "0 9 * * *" })).toMatchObject({ tz: "Asia/Seoul", catchUp: "once" });
});

test("a job fires at its slot and not before, and exactly once after a restart that spanned its slot", async () => {
  const w = world();
  w.specs.add({ name: "brief", type: "schedule", kind: "DAILY_BRIEF", cron: "0 9 * * *", text: "morning brief", since: SINCE });
  w.clock.at = nineKst(23) - 60_000;
  await w.tick();
  expect(w.lines("DAILY_BRIEF")).toEqual([]);
  w.clock.at = nineKst(23) + 10_000;
  await w.tick();
  await w.tick();
  expect(w.lines("DAILY_BRIEF")).toEqual(["DAILY_BRIEF morning brief"]);
  expect(w.events().find((event) => event.line.startsWith("DAILY_BRIEF"))?.id).toBe("schedule:brief:2026-10-23T00:00:00.000Z");
  // Last run in the store: a verified row for the slot.
  expect(w.ops().list({ lane: "schedule:brief" }).map((op) => [op.target, op.state])).toEqual([["2026-10-23T00:00:00.000Z", "verified"]]);

  // Down from 10:00 to 12:00 the next day: the 09:00 slot passed while it was down and runs once on start.
  w.restart();
  w.clock.at = nineKst(24) + 3 * 3_600_000;
  await w.tick();
  await w.tick();
  expect(w.lines("DAILY_BRIEF")).toHaveLength(2);
  w.restart();
  await w.tick();
  expect(w.lines("DAILY_BRIEF")).toHaveLength(2);

  // Three days down: catchUp once runs only the newest missed slot.
  w.restart();
  w.clock.at = nineKst(27) + 5 * 3_600_000;
  await w.tick();
  w.restart();
  await w.tick();
  expect(w.events().filter((event) => event.line.startsWith("DAILY_BRIEF")).map((event) => event.id)).toEqual([
    "schedule:brief:2026-10-23T00:00:00.000Z", "schedule:brief:2026-10-24T00:00:00.000Z", "schedule:brief:2026-10-27T00:00:00.000Z",
  ]);
  const status = readSourceStatus(w.dir)?.sources.brief;
  expect(status).toMatchObject({ type: "schedule", lastSlot: nineKst(27), lastResult: "emitted", events: 3 });
  const row = scheduleRow(w.specs.list()[0] as ScheduleSpec, status, w.clock.at);
  expect(new Date(row.nextRunAt ?? 0).toISOString()).toBe("2026-10-28T00:00:00.000Z");
});

test("catchUp skip records the missed slots without running them; the next slot on time runs", async () => {
  const w = world();
  w.specs.add({ name: "tick", type: "schedule", kind: "HOURLY", everySec: 3_600, text: "hourly", catchUp: "skip", since: SINCE });
  w.clock.at = SINCE + 5 * 3_600_000 + 20 * 60_000;
  await w.tick();
  expect(w.lines("HOURLY")).toEqual([]);
  const [skipped] = w.ops().list({ lane: "schedule:tick" });
  expect(skipped).toMatchObject({ target: new Date(SINCE + 5 * 3_600_000).toISOString(), state: "verified" });
  expect(skipped?.detail).toContain("skipped: 5 slot(s) missed");
  w.clock.at = SINCE + 6 * 3_600_000 + 30_000;
  await w.tick();
  expect(w.lines("HOURLY")).toEqual(["HOURLY hourly"]);
});

test("a heavy command job waits for a free slot, releases it, and a failing command is one SCHEDULE_FAILED event", async () => {
  const calls: { argv: readonly string[]; timeoutMs?: number; cwd?: string }[] = [];
  const w = world(async (argv, opts) => {
    calls.push({ argv, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    return argv[0] === "build" ? ok("built\nall green\n") : { code: 2, out: "", err: "disk full" };
  });
  w.specs.add({ name: "nightly", type: "schedule", kind: "NIGHTLY", cron: "0 9 * * *", command: ["build"], cwd: "/srv", heavy: true, timeoutSec: 900, since: SINCE });
  w.specs.add({ name: "backup", type: "schedule", kind: "BACKUP", cron: "0 9 * * *", command: ["backup"], since: SINCE });
  w.heavy.free = undefined;
  w.clock.at = nineKst(23) + 10_000;
  await w.tick();
  // No slot: the heavy job did not run and its row stays planned; the light job ran.
  expect(calls.map((call) => call.argv[0])).toEqual(["backup"]);
  expect(w.ops().list({ lane: "schedule:nightly" }).map((op) => op.state)).toEqual(["planned"]);
  expect(readSourceStatus(w.dir)?.sources.nightly?.waiting).toBe("heavy slot");
  // Well past the grace period: the planned run is still due, not a missed slot.
  w.heavy.free = "slot.1";
  w.clock.at += 20 * 60_000;
  await w.tick();
  await w.tick();
  expect(calls).toEqual([{ argv: ["backup"], timeoutMs: 600_000 }, { argv: ["build"], timeoutMs: 900_000, cwd: "/srv" }]);
  expect(w.heavy).toMatchObject({ taken: ["schedule:nightly"], released: ["slot.1"] });
  expect(w.lines("NIGHTLY")).toEqual(["NIGHTLY nightly: built all green"]);
  expect(w.lines("SCHEDULE_FAILED")).toEqual(["SCHEDULE_FAILED backup exited 2: disk full"]);
  expect(readSourceStatus(w.dir)?.sources.backup?.lastResult).toBe("failed exit 2");
  expect(readSourceStatus(w.dir)?.sources.nightly?.waiting).toBeUndefined();
  const status = await collectStatus({ ...w.deps, run: async () => ok("active") });
  expect(renderStatus(status)).toContain("schedules: nightly next 10-24 09:00 KST (24h left), backup next 10-24 09:00 KST (24h left) last failed exit 2");
});

test("a crash mid-command leaves an attempted row: it reads back ambiguous once and never reruns until resolved", async () => {
  const calls: string[] = [];
  const w = world(async (argv) => { calls.push(argv[0] ?? ""); return ok("done"); });
  w.specs.add({ name: "deploy", type: "schedule", kind: "DEPLOY", cron: "0 9 * * *", command: ["deploy"], since: SINCE });
  // The run was attempted when the supervisor died: the row is durable, the command's result never journaled.
  const target = new Date(nineKst(23)).toISOString();
  const op = plan(w.ops(), nineKst(23), { lane: "schedule:deploy", action: SCHEDULE_ACTION, target });
  settleOperation(w.ops(), nineKst(23), op.id, "attempted", "attempted");
  w.restart();
  w.clock.at = nineKst(23) + 60_000;
  await w.tick();
  await w.tick();
  expect(calls).toEqual([]);
  expect(w.ops().get(op.id)?.state).toBe("ambiguous");
  expect(w.lines("OPERATION_AMBIGUOUS")).toEqual([
    `OPERATION_AMBIGUOUS ${op.id} interrupted attempt and the read-back cannot tell whether it happened; check whether deploy ran, then dori ops resolve ${op.id} --as verified|retry`,
  ]);
  // The lead resolves it as not run (dori ops resolve --as retry): it runs once.
  settleOperation(w.ops(), w.clock.at, op.id, "planned", "resolved by the lead");
  await w.tick();
  await w.tick();
  expect(calls).toEqual(["deploy"]);
  expect(w.lines("DEPLOY")).toEqual(["DEPLOY deploy: done"]);
});

test("run-now runs a job once as its own row and leaves its schedule as it was", async () => {
  const w = world();
  w.specs.add({ name: "brief", type: "schedule", kind: "DAILY_BRIEF", cron: "0 9 * * *", text: "morning brief", since: SINCE });
  w.clock.at = SINCE + 3_600_000;
  queueRunNow(w.dir, "brief", w.clock.at);
  queueRunNow(w.dir, "gone", w.clock.at + 1);
  await w.tick();
  await w.tick();
  expect(w.events().filter((event) => event.line.startsWith("DAILY_BRIEF")).map((event) => event.id)).toEqual([`schedule:brief:now@${new Date(SINCE + 3_600_000).toISOString()}`]);
  const spec = w.specs.list()[0] as ScheduleSpec;
  expect(scheduleRow(spec, readSourceStatus(w.dir)?.sources.brief, w.clock.at).nextRunAt).toBe(nineKst(23));
  expect(nextSlot(spec, w.clock.at)).toBe(nineKst(23));
  w.clock.at = nineKst(23) + 1_000;
  await w.tick();
  expect(w.lines("DAILY_BRIEF")).toHaveLength(2);
});

test("the real supervisor runs a due job through the registry", async () => {
  const state = withState();
  cleanups.push(state.done);
  const home = process.env.HOME;
  const socket = process.env.NOTIFY_SOCKET;
  process.env.HOME = state.dir;
  delete process.env.NOTIFY_SOCKET;
  cleanups.push(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (socket === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = socket;
  });
  const error = console.error;
  console.error = () => {};
  cleanups.push(() => { console.error = error; });
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ id: "33" }), { status: 200 }), { preconnect: fetch.preconnect }));
  const clock = fakeClock(nineKst(23) + 10_000);
  const w = newWorld();
  w.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(w, clock, state.dir, {
    discord: { applicationId: "100", guildId: "200", ownerId: "123456789012345" }, discordChannels: ["11"], defaultModel: "test/model",
  });
  const deps = {
    ...base,
    run: async (argv: readonly string[]): Promise<Ran> => {
      if (argv[0] === "df") return ok("Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200");
      if (argv[0] === "nightly-report") return ok("3 lanes closed");
      return base.run(argv);
    },
  };
  new SourceSpecs(state.dir).add({ name: "report", type: "schedule", kind: "NIGHTLY", cron: "0 9 * * *", command: ["nightly-report"], since: SINCE });
  // Each pass after the first waits for the test, not for real time: once all five loops (four tasks and the stall
  // check) are parked and the sources are not done yet, they take their next pass.
  const pauses = manualPause();
  const pause = (ms: number, signal: AbortSignal) => {
    const parked = pauses.pause(ms, signal);
    if (pauses.parked() === 5) setImmediate(() => { if (!done()) pauses.tick(); });
    return parked;
  };
  const controller = new AbortController();
  const running = supervise(deps, controller.signal, {
    token: `schedule-test-${state.dir}`,
    http: async (request) => ({ status: 200, headers: {}, body: request.url.endsWith("/threads/active") ? JSON.stringify({ threads: [] }) : "[]" }),
    lookup: async () => "", statusLookup: async () => "",
    open: () => {
      let closed = (_code: number) => {};
      return { send: () => {}, close: () => { closed(1000); }, onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; } };
    },
    timers: { setInterval: () => 0, clearInterval: () => {} },
  }, async () => true, undefined, pause);
  const done = () => readSourceStatus(state.dir)?.sources.report?.lastResult === "ok";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(new Error(`timed out; status ${readFileSync(join(state.dir, "sources-status.json"), "utf8")}`)); }, 20_000);
      const watcher = watch(state.dir, () => { if (done()) { clearTimeout(timer); watcher.close(); resolve(); } });
      if (done()) { clearTimeout(timer); watcher.close(); resolve(); }
    });
  } finally {
    controller.abort();
    await running;
  }
  const lines = readJournal(state.dir).events.map((event: { line: string }) => event.line);
  expect(lines.filter((line: string) => line.startsWith("NIGHTLY "))).toEqual(["NIGHTLY report: 3 lanes closed"]);
  const ops = openOperations(base.config);
  try { expect(ops.list({ lane: "schedule:report" }).map((op) => op.state)).toEqual(["verified"]); } finally { ops.close(); }
}, 30_000);
