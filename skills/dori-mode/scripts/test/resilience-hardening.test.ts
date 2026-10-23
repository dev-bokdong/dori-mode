import { afterEach, expect, test } from "bun:test";

import { diskGuardPath } from "../src/host-guard.ts";
import { type Lane, Registry, updateRegistry } from "../src/registry.ts";
import { DEFAULT_RUN_TIMEOUT_MS, defaultRunTimeout, run, RUN_TIMEOUT_CODE, type Runner, setDefaultRunTimeout } from "../src/run.ts";
import { sdNotify, supervisorSweeps } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
  setDefaultRunTimeout(DEFAULT_RUN_TIMEOUT_MS);
});
const state = () => {
  const s = withState();
  cleanups.push(s.done);
  return s.dir;
};

const lane = (patch: Partial<Lane> = {}): Lane => ({
  key: "demo-lane", title: "demo", thread: "none", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1",
  openedAt: "2026-10-22T00:00:00.000Z", ...patch,
});

// Item 1: every external call is bounded.
test("a hung call is killed at its timeout and reported as a timeout", async () => {
  const started = Date.now();
  const r = await run(["sleep", "30"], { timeoutMs: 200 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(r).toMatchObject({ code: RUN_TIMEOUT_CODE, out: "", timedOut: true });
  expect(r.err).toBe("timed out after 200 ms: sleep 30");
});

test("a grandchild holding the output pipe open cannot stretch a call past its timeout", async () => {
  const started = Date.now();
  const r = await run(["sh", "-c", "sleep 30 & echo started; wait"], { timeoutMs: 300 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(r.timedOut).toBe(true);
});

test("the default timeout applies to calls without their own, and a per-call value overrides it", async () => {
  expect(defaultRunTimeout()).toBe(DEFAULT_RUN_TIMEOUT_MS);
  setDefaultRunTimeout(200);
  expect((await run(["sleep", "30"])).timedOut).toBe(true);
  const own = await run(["sh", "-c", "sleep 0.4; echo ok"], { timeoutMs: 5_000 });
  expect(own).toEqual({ code: 0, out: "ok", err: "" });
  const unlimited = await run(["sh", "-c", "sleep 0.4; echo ok"], { timeoutMs: 0 });
  expect(unlimited.code).toBe(0);
  expect(() => setDefaultRunTimeout(-1)).toThrow(RangeError);
});

test("a fast call keeps its exit code, output and error text", async () => {
  expect(await run(["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({ code: 3, out: "out", err: "err" });
  expect((await run(["/nonexistent/binary"])).code).toBe(127);
});

// Item 2: sd_notify from the loop.
test("sdNotify is a no-op without NOTIFY_SOCKET and calls systemd-notify with the state when it is set", async () => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (argv) => { calls.push(argv); return { code: 0, out: "", err: "" }; };
  expect(await sdNotify("WATCHDOG=1", {}, runner)).toBe(false);
  expect(calls).toEqual([]);
  expect(await sdNotify("READY=1", { NOTIFY_SOCKET: "/run/user/1/systemd/notify" }, runner)).toBe(true);
  expect(calls).toEqual([["systemd-notify", `--pid=${process.pid}`, "READY=1"]]);
  const failing: Runner = async () => ({ code: 1, out: "", err: "no socket" });
  expect(await sdNotify("WATCHDOG=1", { NOTIFY_SOCKET: "/x" }, failing)).toBe(false);
});

// Item 3: registry lock and version.
test("every write bumps the version and update applies its change to the fresh lane", async () => {
  const registry = new Registry(state());
  await registry.write(lane());
  expect((await registry.read("demo-lane"))?.version).toBe(1);
  const stale = await registry.read("demo-lane");
  await registry.write({ ...(stale as Lane), status: "paused", pausedFrom: "working" });
  // A load-modify-save from the stale copy through update keeps the pause.
  const after = await updateRegistry(registry, "demo-lane", (current) => current ? { ...current, session: "s-1" } : undefined);
  expect(after).toMatchObject({ status: "paused", pausedFrom: "working", session: "s-1", version: 3 });
  expect(await registry.read("demo-lane")).toEqual(after);
  expect(await registry.update("demo-lane", () => undefined)).toEqual(after);
  expect(await registry.update("missing", (current) => current ?? undefined)).toBeNull();
});

// Item 4: the disk guard checks the state directory's filesystem.
test("the guard sweep runs df on the state directory, or on diskGuardPath when set", async () => {
  const dir = state();
  for (const [patch, expected] of [[{}, dir], [{ diskGuardPath: "/srv/data" }, "/srv/data"]] as const) {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(1_800_000_000_000), dir, patch);
    expect(diskGuardPath(deps.config)).toBe(expected);
    const guard = supervisorSweeps(deps, dir).find(([name]) => name === "guard");
    await guard?.[1](async () => {});
    expect(world.calls.filter((c) => c[0] === "df")).toEqual([["df", "-k", expected]]);
  }
});
