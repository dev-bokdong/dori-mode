import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry, type Lane } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";
import { runSweeps, supervisorSweeps } from "../src/supervise-loop.ts";
import { boundedRunner } from "../src/sweep-view.ts";
import { fakeClock, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MODEL = defaultConfig("/home/test").defaultModel;
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

type Row = { pane_id: string; workspace_id: string; agent: string; agent_status: string; revision: number };

/** herdr on two machines ("" is this host): counts calls and in-flight calls per machine, each call takes `latencyMs`. */
const herdr = (latencyMs: number) => {
  const panes = new Map<string, Row[]>([["", []], ["box2", []]]);
  const calls: string[][] = [];
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const run: Runner = async (argv): Promise<Ran> => {
    if (argv[0] !== "herdr") return { code: 1, out: "", err: "not herdr" };
    calls.push([...argv]);
    const machine = argv[1] === "--machine" ? argv[2] ?? "" : "";
    const [, verb, pane] = argv[1] === "--machine" ? argv.slice(3) : argv.slice(1);
    inFlight.set(machine, (inFlight.get(machine) ?? 0) + 1);
    peak.set(machine, Math.max(peak.get(machine) ?? 0, inFlight.get(machine) ?? 0));
    try {
      await Bun.sleep(latencyMs);
      const rows = panes.get(machine) ?? [];
      if (verb === "list") return { code: 0, out: JSON.stringify({ result: { panes: rows } }), err: "" };
      if (verb === "read") return { code: 0, out: `screen of ${pane} at ${rows.find((r) => r.pane_id === pane)?.revision}\n❯ `, err: "" };
      if (verb === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ["omo", "--model", MODEL] }] } } }), err: "" };
      return { code: 0, out: "", err: "" };
    } finally { inFlight.set(machine, (inFlight.get(machine) ?? 1) - 1); }
  };
  return { panes, calls, peak, run };
};

const setup = async (latencyMs: number) => {
  const h = herdr(latencyMs);
  const clock = fakeClock(T0);
  const config = { ...defaultConfig("/home/test"), stateDir: state.dir, defaultCwd: "/repo", leadPane: "lead:p1", workspaces: ["none"] };
  const deps: FlowDeps = { run: h.run, clock, registry: new Registry(state.dir), config, exists: () => true };
  for (let i = 0; i < 100; i++) {
    const machine = i % 2 ? "box2" : "";
    const pane = `w${i}:p1`;
    h.panes.get(machine)?.push({ pane_id: pane, workspace_id: `w${i}`, agent: "omo", agent_status: i % 3 ? "working" : "idle", revision: 1 });
    const lane: Lane = { key: `lane-${i}`, title: `lane ${i}`, thread: "none", pane, ...(machine ? { machine } : {}), brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
    await deps.registry.write(lane);
  }
  const sweeps = supervisorSweeps(deps, "/home/test", async () => ({ results: [], text: "" }));
  const lines: string[] = [];
  const round = async (): Promise<{ readonly calls: number; readonly ms: number }> => {
    const before = h.calls.length;
    const started = performance.now();
    await runSweeps(sweeps, async (line) => { lines.push(line); }, clock.now, new Map(), () => {});
    clock.at += 30_000;
    return { calls: h.calls.length - before, ms: performance.now() - started };
  };
  return { h, round, lines };
};

const MACHINES = 2;

test("with 100 open lanes a round makes at most machines + changed lanes x 2 herdr calls, within 10 s and 4 calls per machine", async () => {
  const { h, round, lines } = await setup(5);
  const first = await round();
  expect(first.calls).toBeLessThanOrEqual(MACHINES + 100 * 2);
  expect(first.ms).toBeLessThan(10_000);
  const steady = await round();
  expect(steady.calls).toBe(MACHINES);
  expect(steady.ms).toBeLessThan(10_000);
  const changed = [...(h.panes.get("") ?? []).slice(0, 4), ...(h.panes.get("box2") ?? []).slice(0, 3)];
  for (const row of changed) row.revision++;
  const flipped = h.panes.get("box2")?.[10];
  if (flipped) flipped.agent_status = flipped.agent_status === "working" ? "idle" : "working";
  const after = await round();
  expect(after.calls).toBeLessThanOrEqual(MACHINES + (changed.length + 1) * 2);
  expect(await round()).toMatchObject({ calls: MACHINES });
  for (const machine of ["", "box2"]) {
    expect(h.peak.get(machine) ?? 0).toBeLessThanOrEqual(4);
    expect(h.peak.get(machine) ?? 0).toBeGreaterThan(1);
  }
  expect(lines.filter((line) => /^(LANE_RECOVER|NUDGED|DEAD_PANE|UNRECOGNISED_PANE)/.test(line))).toEqual([]);
});

test("a bounded runner never runs more than its limit at once and starts nothing past its deadline", async () => {
  let active = 0;
  let peak = 0;
  const timeouts: (number | undefined)[] = [];
  const inner: Runner = async (_argv, opts) => {
    timeouts.push(opts?.timeoutMs);
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(2);
    active--;
    return { code: 0, out: "ok", err: "" };
  };
  let now = 0;
  const run = boundedRunner(inner, 4, 1_000, () => now);
  const results = await Promise.all(Array.from({ length: 20 }, () => run(["herdr", "pane", "list"])));
  expect(results.every((r) => r.code === 0)).toBe(true);
  expect(peak).toBe(4);
  expect(timeouts.every((t) => t !== undefined && t <= 1_000)).toBe(true);
  now = 1_000;
  const late = await run(["herdr", "pane", "list"]);
  expect(late).toMatchObject({ code: 124, timedOut: true });
  expect(timeouts).toHaveLength(20);
});
