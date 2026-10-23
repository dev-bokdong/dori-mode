import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { recoverLanes, RECOVERY_LIMIT, type RecoveryLane, resumeCommand, STARTUP_GRACE_MS, withRecoveryLock } from "../src/recover.ts";
import { writeQuotaState } from "../src/claude-quota.ts";
import { freshnessTick } from "../src/freshness.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, withSqliteStore } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); withSqliteStore(state.dir); });
afterEach(() => state.done());

const fixture = async () => {
  const world = newWorld();
  world.prState = "OPEN";
  const clock = fakeClock(0);
  const d = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "Execute the task.");
  const lane: Lane = { key: "recover-lane", title: "lane", thread: "chat:1", brief, cwd: state.dir, model: "provider/expected", pane: "old:p1", tab: "old:t1", done: "merged a/b#1", openedAt: new Date(-STARTUP_GRACE_MS).toISOString() };
  const control = { live: false, argv: ["omo", "--model", "provider/expected"], createCode: 0, listCode: 0, next: 0, attempted: 0, duringCreate: undefined as undefined | (() => Promise<void>) };
  const base = fakeRunner(world);
  const deps: typeof d = { ...d, run: async (argv, opts) => {
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") {
      world.calls.push([...argv]);
      const panes = [
        ...(control.live ? [{ pane_id: "old:p1", tab_id: "old:t1", workspace_id: "w", agent_status: "working" }] : []),
        ...(control.next ? [{ pane_id: `new:p${control.next}`, tab_id: `new:t${control.next}`, workspace_id: "w", agent_status: "working" }] : []),
      ];
      return { code: control.listCode, out: JSON.stringify({ result: { panes } }), err: "" };
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") {
      world.calls.push([...argv]);
      return { code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 42, argv: control.argv }] } } }), err: "" };
    }
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
      world.calls.push([...argv]);
      control.attempted = (await d.registry.read(lane.key))?.recoveryAttempts ?? 0;
      await control.duringCreate?.();
      control.next++;
      return { code: control.createCode, out: JSON.stringify({ result: { root_pane: { pane_id: `new:p${control.next}` }, tab_id: `new:t${control.next}` } }), err: "" };
    }
    return base(argv, opts);
  } };
  await deps.registry.write(lane);
  return { deps, world, lane, control, clock };
};

test("recovers a missing pane with persisted attempt and original launch metadata", async () => {
  const { deps, world, lane, control } = await fixture();
  const events = await recoverLanes(deps, lane.key);
  expect(events).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
  expect(control.attempted).toBe(1);
  expect(await deps.registry.read(lane.key)).toMatchObject({ pane: "new:p1", model: lane.model, brief: lane.brief, cwd: lane.cwd, openedAt: lane.openedAt, recoveryAttempts: 1, lastRecoveryAt: 0 });
  expect(world.calls.filter((call) => call[0] === "notify")).toHaveLength(1);
});

test.each([
  { argv: ["omo"], reason: "missing-model" },
  { argv: ["bun", "/bin/omo", "--model", "provider/wrong"], reason: "model-mismatch" },
  { argv: ["omo", "--model=provider/wrong"], reason: "model-mismatch" },
  { argv: ["bun", "/agent/senpi/dist/bundle/cli.js"], reason: "missing-model" },
])("recovers restored argv $argv using registry model", async ({ argv, reason }) => {
  const { deps, world, control } = await fixture();
  control.live = true;
  control.argv = [...argv];
  const events = await recoverLanes(deps);
  expect(events[0]).toBe(`LANE_RECOVERED recover-lane new:p1 ${reason}`);
  expect((await deps.registry.read("recover-lane"))?.model).toBe("provider/expected");
  expect(world.calls.findIndex((call) => call[2] === "run")).toBeLessThan(world.calls.findIndex((call) => call[2] === "close"));
  expect(world.calls.filter((call) => call[2] === "close")).toEqual([["herdr", "pane", "close", "old:p1"]]);
  expect(world.calls.filter((call) => call[0] === "notify")).toHaveLength(1);
});

test.each(["working", "paused", "closed", "done-claimed"] as const)("leaves %s live lanes untouched when matching or inactive", async (status) => {
  const { deps, world, lane, control } = await fixture();
  control.live = true;
  if (status !== "working") control.argv = ["omo"];
  await deps.registry.write({ ...lane, status });
  const events = await recoverLanes(deps);
  expect(events).toEqual([]);
  expect(world.calls.some((call) => call[2] === "create" || call[2] === "close")).toBe(false);
});

test.each(["paused", "closed", "done-claimed"] as const)("does not recover a missing %s lane", async (status) => {
  const { deps, lane } = await fixture();
  await deps.registry.write({ ...lane, status });
  const events = await recoverLanes(deps);
  expect(events).toEqual([]);
});

test("does not interpret list failure as a missing pane", async () => {
  const { deps, control } = await fixture();
  control.listCode = 1;
  const events = await recoverLanes(deps);
  expect(events[0]?.startsWith("LANE_RECOVERY_ERROR recover-lane ")).toBe(true);
  expect(control.next).toBe(0);
  expect((await deps.registry.read("recover-lane"))?.recoveryAttempts).toBeUndefined();
});

test("failed attempts exhaust the persisted recovery budget", async () => {
  const { deps, control, lane } = await fixture();
  control.createCode = 1;
  await deps.registry.write({ ...lane, recoveryAttempts: RECOVERY_LIMIT - 1 });
  const first = await recoverLanes(deps);
  const second = await recoverLanes(deps);
  const third = await recoverLanes(deps);
  expect(first[0]?.startsWith("LANE_RECOVERY_ERROR recover-lane ")).toBe(true);
  expect(second).toEqual([`LANE_RECOVERY_EXHAUSTED recover-lane old:p1 missing-pane after ${RECOVERY_LIMIT} recovery attempts; lane is not relaunched or nudged again, inspect it or dori close recover-lane`]);
  expect(third).toEqual([]);
  expect((await deps.registry.read("recover-lane")) as RecoveryLane | null).toMatchObject({ recoveryPending: true, recoveryExhausted: true });
  expect(control.next).toBe(1);
  expect((await deps.registry.read("recover-lane"))?.recoveryAttempts).toBe(RECOVERY_LIMIT);
});

test.each(["exhausted", "blocked"] as const)(
  "retries the %s notice when enqueue fails before acceptance", async (kind) => {
    const { deps, world, lane } = await fixture();
    if (kind === "exhausted") await deps.registry.patch(lane.key, { recoveryAttempts: RECOVERY_LIMIT });
    const d = kind === "blocked" ? withAuth(deps, world, { out: JSON.stringify({ accounts: [{ blocked: true }] }) }) : deps;
    const ids: string[] = [];
    const enqueue = async (_line: string, id: string) => {
      ids.push(id);
      if (ids.length === 1) throw new Error("crash before enqueue");
    };
    await recoverLanes(d, undefined, enqueue);
    expect((await deps.registry.read(lane.key)) as RecoveryLane).not.toMatchObject(
      kind === "exhausted" ? { recoveryExhausted: true } : { recoveryBlocked: expect.any(String) });
    await recoverLanes({ ...d, registry: new Registry(state.dir) }, undefined, enqueue);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBeTruthy();
    await recoverLanes({ ...d, registry: new Registry(state.dir) }, undefined, enqueue);
    expect(ids).toHaveLength(2);
  },
);

test.each(["exhausted", "blocked"] as const)(
  "deduplicates the %s notice after enqueue but before flag persistence", async (kind) => {
    const { deps, world, lane } = await fixture();
    if (kind === "exhausted") await deps.registry.patch(lane.key, { recoveryAttempts: RECOVERY_LIMIT });
    const d = kind === "blocked" ? withAuth(deps, world, { out: JSON.stringify({ accounts: [{ blocked: true }] }) }) : deps;
    const journal = new Map<string, string>();
    const ids: string[] = [];
    const enqueue = async (line: string, id: string) => { ids.push(id); journal.set(id, line); };
    const patch = deps.registry.patch.bind(deps.registry);
    deps.registry.patch = async () => { throw new Error("crash before flag persistence"); };
    await recoverLanes(d, undefined, enqueue);
    expect(journal.size).toBe(1);
    deps.registry.patch = patch;
    await recoverLanes(d, undefined, enqueue);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(journal.size).toBe(1);
    await recoverLanes(d, undefined, enqueue);
    expect(ids).toHaveLength(2);
  },
);

test("a concurrent recovery owner excludes another registry instance", async () => {
  const { deps, control } = await fixture();
  const events = await withRecoveryLock(deps, "recover-lane", () => recoverLanes({ ...deps, registry: new Registry(state.dir) }));
  expect(events).toEqual([]);
  expect(control.next).toBe(0);
});

test("a pause during process inspection prevents recovery admission", async () => {
  const { deps, lane, control, world } = await fixture();
  control.live = true;
  control.argv = ["omo"];
  const run: typeof deps.run = async (argv, opts) => {
    const result = await deps.run(argv, opts);
    if (argv[2] === "process-info") await deps.registry.write({ ...lane, status: "paused" });
    return result;
  };
  expect(await recoverLanes({ ...deps, run })).toEqual([]);
  expect((await deps.registry.read(lane.key))?.status).toBe("paused");
  expect(world.calls.some((call) => call[2] === "create" || call[2] === "close")).toBe(false);
});

test("a capped wrong-model pane is never fed a freshness nudge", async () => {
  const { deps, lane, control, world } = await fixture();
  control.live = true;
  control.argv = ["omo"];
  await deps.registry.write({ ...lane, recoveryAttempts: RECOVERY_LIMIT });
  await recoverLanes(deps);
  expect((await deps.registry.read(lane.key))?.recoveryPending).toBe(true);
  expect(await freshnessTick({ ...deps, clock: fakeClock(30 * 60_000) }, "/home/test")).toEqual([]);
  expect(world.calls.some((call) => call[2] === "send-text" || call[2] === "create")).toBe(false);
});

test("failed process inspection never turns a live lane into a missing lane", async () => {
  const { deps, control } = await fixture();
  control.live = true;
  const run: typeof deps.run = async (argv, opts) => argv[2] === "process-info"
    ? { code: 1, out: "", err: "unavailable" } : deps.run(argv, opts);
  const events = await recoverLanes({ ...deps, run });
  expect(events[0]?.startsWith("LANE_RECOVERY_ERROR recover-lane ")).toBe(true);
  expect(control.next).toBe(0);
  expect((await deps.registry.read("recover-lane"))?.recoveryAttempts).toBeUndefined();
});

test("recovery closes only its registered pane even when the saved tab changed", async () => {
  const { deps, lane, control, world } = await fixture();
  control.live = true;
  control.argv = ["omo"];
  await deps.registry.write({ ...lane, tab: "someone-else:t1" });
  const events = await recoverLanes(deps);
  expect(events[0]).toBe("LANE_RECOVERED recover-lane new:p1 missing-model");
  expect(world.calls.filter((call) => call[2] === "close")).toEqual([["herdr", "pane", "close", "old:p1"]]);
});

test("a recovered agent that later confirms clears the freshness hold", async () => {
  const { deps, lane, control } = await fixture();
  control.live = true;
  await deps.registry.write({ ...lane, recoveryPending: true });
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane old:p1 startup-confirmed"]);
  expect((await deps.registry.read(lane.key))?.recoveryPending).toBeUndefined();
});

/** Answers omo auth check for provider "provider" with `accounts`; everything else goes to the fixture. */
const withAuth = (deps: Awaited<ReturnType<typeof fixture>>["deps"], world: Awaited<ReturnType<typeof fixture>>["world"], auth: { out: string }) => ({
  ...deps, run: async (argv: readonly string[], opts?: Parameters<typeof deps.run>[1]) => {
    if (argv[0] === "omo" && argv[1] === "auth") { world.calls.push([...argv]); return { code: 1, out: auth.out, err: "" }; }
    return deps.run(argv, opts);
  },
});

test("item 5: a lane whose provider is out of quota is not relaunched; the reason is recorded and sent once", async () => {
  const { deps, world, lane, control } = await fixture();
  const auth = { out: JSON.stringify({ accounts: [{ name: "a", blocked: true, blockedUntil: "2026-10-22T09:30:00.000Z" }] }) };
  const d = withAuth(deps, world, auth);
  expect(await recoverLanes(d)).toEqual(["LANE_RECOVERY_BLOCKED recover-lane old:p1 missing-pane: quota 1/1 provider accounts blocked, resets 2026-10-22T09:30:00.000Z; not relaunched"]);
  expect(await recoverLanes(d)).toEqual([]);
  expect(control.next).toBe(0);
  expect((await deps.registry.read(lane.key)) as RecoveryLane).toMatchObject({ recoveryPending: true, recoveryBlocked: "quota 1/1 provider accounts blocked, resets 2026-10-22T09:30:00.000Z" });
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
  auth.out = JSON.stringify({ accounts: [{ name: "a", blocked: false }] });
  expect(await recoverLanes(d)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
  expect(((await deps.registry.read(lane.key)) as RecoveryLane).recoveryBlocked).toBeUndefined();
});

test("item 5: a blocked Claude subscription (the supervisor's cached read) holds recovery of a Claude lane", async () => {
  const { deps, lane, control } = await fixture();
  await deps.registry.write({ ...lane, model: "anthropic-subscription/claude-opus-5-5" });
  writeQuotaState(state.dir, { mode: "blocked", usage: { at: 0, accounts: [{ name: "a", fiveHour: { usedPct: 100 } }] } });
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERY_BLOCKED recover-lane old:p1 missing-pane: claude subscription blocked; not relaunched"]);
  expect(control.next).toBe(0);
});

test("a lane on a bare model name (no provider prefix) gets the provider quota check before relaunch", async () => {
  const { deps, world, lane, control } = await fixture();
  await deps.registry.write({ ...lane, model: "gpt-5.5" });
  const d = withAuth(deps, world, { out: JSON.stringify({ accounts: [{ name: "a", blocked: true }] }) });
  const [line] = await recoverLanes(d);
  expect(line).toStartWith("LANE_RECOVERY_BLOCKED recover-lane old:p1 missing-pane: quota");
  expect(control.next).toBe(0);
});

test("a field changed while the relaunch runs survives the relaunch's registry write", async () => {
  const { deps, lane, control } = await fixture();
  control.duringCreate = async () => { await deps.registry.patch(lane.key, { title: "renamed mid-launch" }); };
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane", "STARTUP_OK recover-lane new:p1"]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ title: "renamed mid-launch", pane: "new:p1" });
});

test("item 7: a recovered lane resumes its registered session instead of restarting from the brief", async () => {
  const { deps, world, lane } = await fixture();
  await deps.registry.write({ ...lane, session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc", sessionVia: "argv" });
  expect(await recoverLanes(deps)).toEqual(["LANE_RECOVERED recover-lane new:p1 missing-pane session-resumed", "STARTUP_OK recover-lane new:p1"]);
  const ran = world.calls.find((c) => c[0] === "herdr" && c[2] === "run")?.[4] ?? "";
  expect(ran).toStartWith("DORI_LANE_KEY=recover-lane omo --model provider/expected --session 0b1c2d3e-aaaa-bbbb-cccc-123456789abc ");
  expect(await deps.registry.read(lane.key)).toMatchObject({ session: "0b1c2d3e-aaaa-bbbb-cccc-123456789abc", pane: "new:p1" });
});

test("item 7: a resume that does not start falls back to the brief on the next attempt", async () => {
  const { deps, world, lane, control, clock } = await fixture();
  await deps.registry.write({ ...lane, session: "gone-session" });
  world.screen = "Error: Session crashed\n";
  const idle: typeof deps = { ...deps, run: async (argv, opts) => {
    const r = await deps.run(argv, opts);
    return argv[0] === "herdr" && argv[2] === "list" ? { ...r, out: r.out.replaceAll('"working"', '"idle"') } : r;
  } };
  const first = await recoverLanes(idle);
  expect(first).toEqual(["STARTUP_ERROR recover-lane new:p1: Session crashed", "LANE_RECOVERY_ERROR recover-lane replacement-unconfirmed; session gone-session not resumed, the next attempt starts from the brief"]);
  expect(await deps.registry.read(lane.key)).toMatchObject({ recoveryResumeFailed: "gone-session" });
  expect((await deps.registry.read(lane.key))?.session).toBeUndefined();
  control.argv = ["omo"];
  world.screen = "❯ ";
  clock.at = STARTUP_GRACE_MS;
  await recoverLanes(deps);
  const runs = world.calls.filter((c) => c[0] === "herdr" && c[2] === "run").map((c) => c[4] ?? "");
  expect(runs).toHaveLength(2);
  expect(runs[0]).toContain("--session gone-session");
  expect(runs[1]).not.toContain("--session");
});

test("item 7: resumeCommand puts --session before the prompt, and declines when it cannot resume", () => {
  expect(resumeCommand(["omo", "--model", "{model}", "{prompt}"], "abc")).toEqual(["omo", "--model", "{model}", "--session", "abc", "{prompt}"]);
  expect(resumeCommand(["omo", "--model", "{model}", "{prompt}"], undefined)).toBeUndefined();
  expect(resumeCommand(["omo", "--continue", "{prompt}"], "abc")).toBeUndefined();
  expect(resumeCommand(["omo", "--model", "{model}"], "abc")).toBeUndefined();
  expect(resumeCommand(["omo", "{prompt}"], "--evil")).toBeUndefined();
  expect(resumeCommand(["omo", "{prompt}"], "a b")).toBeUndefined();
});

test.each([{ live: false, reason: "missing-pane" }, { live: true, reason: "missing-model" }])("never relaunches a lane whose PR is merged ($reason); the lane is closed instead", async ({ live, reason }) => {
  const { deps, world, lane, control } = await fixture();
  world.prState = "MERGED";
  if (live) { control.live = true; control.argv = ["omo"]; }
  const events = await recoverLanes(deps, lane.key);
  expect(events).toHaveLength(1);
  expect(events[0]).toStartWith(`LANE_RECOVERY_SKIPPED recover-lane old:p1 ${reason}: every Done signal holds`);
  expect(control.next).toBe(0);
  expect((await deps.registry.read(lane.key))?.recoveryAttempts).toBeUndefined();
  expect(world.calls.some((call) => call[2] === "create")).toBe(false);
  expect(events[0]).toContain("lane closed");
  expect((await deps.registry.read(lane.key))?.status).toBe("closed");
});

// Captured 10-23 from live omo 5.1.44 panes (herdr process-info argv and the status bar's last lines).
const SONNET = "anthropic-subscription/claude-sonnet-5-5";
const OMO = "/home/dev/.omo/binary-runtime/5.1.44/omo";
const MCP_CHILD = [OMO, "/home/dev/.omo/binary-runtime/5.1.44/plugin/runtime/ast-grep-mcp/cli.js", "mcp"];
const BAR_TAGGED = "/tmp/tmp.isIeWh971Y • CH98.8% • … • 39K/1M (3.9%) (auto)      (anthropic-subscription@default) claude-sonnet-5-5:medium\n(😺 OmO Native by Q Kim)\n";
const BAR_BARE = "…-228 • fix/recovery-never-respawn-a-lane-whose-pr • CH97.5% • 121K/1M (12.1%) (auto) claude-sonnet-5-5:medium\n(😺 OmO Native by Q Kim)\n";
const BAR_EFFORT = "/work/app • CH99.2% • $0.000 • 99K/1M (9.9%) (auto)      (anthropic-subscription@login-2) claude-sonnet-5-5 • effort low (shift+tab)\n(😺 OmO Native by Q Kim) mem:dori-b116e8a6 1m ago\n";

test.each([
  { name: "omo's MCP child listed before the agent", procs: [MCP_CHILD, [OMO, "--model", SONNET, "--thinking", "medium", "prompt"]], screen: "❯ " },
  { name: "a bare --model name", procs: [["omo", "--model", "claude-sonnet-5-5", "prompt"]], screen: "❯ " },
  { name: "restored argv, bar with provider tag", procs: [["omo"], MCP_CHILD], screen: BAR_TAGGED },
  { name: "restored argv, bar without provider tag", procs: [["omo"]], screen: BAR_BARE },
  { name: "restored argv, bar with effort", procs: [["omo"]], screen: BAR_EFFORT },
])("a sonnet lane running its model is left alone: $name", async ({ procs, screen }) => {
  const { deps, world, lane, control } = await fixture();
  await deps.registry.write({ ...lane, model: SONNET });
  control.live = true;
  world.screen = screen;
  const run: typeof deps.run = async (argv, opts) => argv[2] === "process-info"
    ? { code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: procs.map((p, i) => ({ pid: 40 + i, argv: p })) } } }), err: "" }
    : deps.run(argv, opts);
  expect(await recoverLanes({ ...deps, run })).toEqual([]);
  expect(world.calls.some((call) => call[2] === "create" || call[2] === "close")).toBe(false);
});

test("a pane whose model is not readable yet is not judged missing-model until the startup grace ends", async () => {
  const { deps, world, lane, control, clock } = await fixture();
  clock.at = 1_000_000;
  await deps.registry.write({ ...lane, openedAt: new Date(clock.at - 15_000).toISOString() });
  control.live = true;
  control.argv = ["omo"];
  expect(await recoverLanes(deps)).toEqual([]);
  expect(world.calls.some((call) => call[2] === "create")).toBe(false);
  clock.at += STARTUP_GRACE_MS;
  expect((await recoverLanes(deps))[0]).toBe("LANE_RECOVERED recover-lane new:p1 missing-model");
});

test.each([
  { name: "argv names another model, even inside the startup grace", argv: [OMO, "--model", "anthropic-subscription/claude-opus-5-5", "prompt"], screen: BAR_TAGGED, fresh: true, reason: "model-mismatch" },
  { name: "argv names the model under another provider", argv: ["omo", "--model", "openai/claude-sonnet-5-5"], screen: "❯ ", fresh: false, reason: "model-mismatch" },
  { name: "restored argv and a bar tagged with another provider", argv: ["omo"], screen: BAR_TAGGED.replace("anthropic-subscription@default", "openai@default"), fresh: false, reason: "missing-model" },
  { name: "restored argv and a bar showing another model", argv: ["omo"], screen: BAR_TAGGED.replace("claude-sonnet-5-5", "claude-opus-5-5"), fresh: false, reason: "missing-model" },
])("a truly different model is still replaced: $name", async ({ argv, screen, fresh, reason }) => {
  const { deps, world, lane, control, clock } = await fixture();
  clock.at = 1_000_000;
  await deps.registry.write({ ...lane, model: SONNET, ...(fresh ? { openedAt: new Date(clock.at - 5_000).toISOString() } : {}) });
  control.live = true;
  control.argv = [...argv];
  world.screen = screen;
  expect((await recoverLanes(deps))[0]).toBe(`LANE_RECOVERED recover-lane new:p1 ${reason}`);
  expect(world.calls.filter((call) => call[2] === "close")).toEqual([["herdr", "pane", "close", "old:p1"]]);
});
