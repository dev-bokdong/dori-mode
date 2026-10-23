import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Runner } from "../src/run.ts";
import { ACK_KEEP_MS, eventPriority, LEAD_SKILL, OUTBOX_ATTEMPTS, OUTBOX_RETRY_MS, plainShell, RetryingDelivery, screenStill, Supervisor, UNCONFIRMED_LIMIT } from "../src/supervise.ts";
import { acquireSupervisor } from "../src/supervise-loop.ts";
import { Waits } from "../src/waits.ts";
import { pendingLeadRestart, requestLeadRestart } from "../src/lead-restart.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { pendingAcks, recordAck, recordHandled } from "../src/ack.ts";
import { approveEmergency, clearEmergencyApproval, emergencyApproved } from "../src/emergency.ts";
import { clearLaunchHold, enqueueLaunch } from "../src/routing.ts";
import { depsFor, fakeClock, newWorld, withState, journalBytes, readJournal, writeJournal } from "./fakes.ts";
import { JOURNAL_FILE, readWakes, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { eventClass, resolveEventPolicy } from "../src/event-policy.ts";
import { openLaneReports, routeReports } from "../src/lane-reports.ts";
import { importStore } from "../src/store-import.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const fixture = (extra: Record<string, unknown> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  // The evidence deadline is measured on this clock, so a sleep must move it forward.
  const clock: ReturnType<typeof fakeClock> = { at: 1_800_000_000_000, now: () => clock.at, sleep: async (ms: number) => { clock.at += ms; } };
  const world = newWorld();
  const session = "11111111-1111-4111-8111-111111111111";
  const config = { sessionsDir: join(state.dir, "sessions"), defaultCwd: "/repo", ...extra };
  const dir = sessionDirFor(config.sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2027-01-15T08-00-00-000Z_${session}.jsonl`);
  writeFileSync(file, "{}\n");
  utimesSync(file, clock.now() / 1000, clock.now() / 1000);
  const pane = { pane_id: "lead:p1", workspace_id: "test", cwd: "/repo", agent: "omo", agent_status: "idle" };
  world.panes.push(pane);
  let active = session;
  let pid = 101;
  let confirm = true;
  let admitted: string | undefined;
  let prompt: string | undefined;
  let onWait: (() => Promise<void>) | undefined;
  let hangs = 0;
  const auth: Record<string, string> = {};
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const ok = (out = "") => ({ code: 0, out, err: "" });
    if (argv[0] === "omo" && argv[1] === "auth") return { code: 1, out: auth[argv[argv.indexOf("--provider") + 1] ?? ""] ?? "", err: "" };
    if (argv[0] === "ps" && argv[1] === "-A") return ok(pid ? `${pid} 10 /usr/bin/omo --session-id ${active}\n102 ${pid} tail -F events\n103 1 tail -F orphan\n104 1 other-agent` : "");
    if (argv[0] === "ps" && argv[1] === "eww") return ok(argv.at(-1) === "103" ? `tail -F orphan PI_SESSION_ID=${session}` : "PI_SESSION_ID=other");
    if (argv[0] === "herdr" && argv[2] === "list") return ok(JSON.stringify({ result: { panes: world.panes } }));
    if (argv[0] === "herdr" && argv[2] === "process-info") return ok(JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_processes: pid ? [{ pid, argv: ["omo", "--session-id", active] }] : [] } } }));
    if (argv[0] === "kill") {
      if (argv[2] === String(pid)) { pid = 0; pane.agent = ""; pane.agent_status = ""; }
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "run") {
      admitted = argv[4] ?? "";
      const path = /@([^'\s]+)/.exec(admitted)?.[1];
      prompt = path ? readFileSync(path, "utf8") : undefined;
      active = /--session-id ([\w-]+)/.exec(admitted)?.[1] ?? "";
      pid = 201;
      // A healthy omo writes its holder pid file at once; a hung cold start only creates the empty directory.
      mkdirSync(join(dir, "session-holders", active), { recursive: true });
      if (hangs > 0) hangs--;
      else writeFileSync(join(dir, "session-holders", active, `${pid}.json`), "{}");
      pane.agent = "omo";
      pane.agent_status = "idle";
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "wait") {
      await onWait?.();
      return confirm ? ok() : { code: 1, out: "", err: "not ready" };
    }
    if (argv[0] === "herdr" && argv[2] === "read") return ok(world.screen);
    if (argv[0] === "herdr" && (argv[2] === "send-text" || argv[2] === "send-keys")) return ok();
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = { ...depsFor(world, clock, state.dir, config), run };
  const log = () => readFileSync(join(state.dir, "lead-events.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    state, deps, pane, clock, calls, log, file, world, auth,
    cold: () => { clock.at += 300_000; },
    command: () => admitted,
    prompt: () => prompt,
    setConfirm: (value: boolean) => { confirm = value; },
    hang: (launches: number) => { hangs = launches; },
    noAgent: () => { pid = 0; pane.agent = ""; pane.agent_status = ""; },
    onWait: (callback: () => Promise<void>) => { onWait = callback; },
  };
};

test("spinner frames of any common style do not count as screen progress; text does", () => {
  const frames = ["⠙ Thinking 12s", "✻ Thinking 13s", "◐ Thinking 14s", "| Thinking 15s", "/ Thinking 16s", "- Thinking 17s", "\\ Thinking 18s", "· Thinking 19s"];
  expect(new Set(frames.map((frame) => screenStill(`out\n${frame}\n❯ `))).size).toBe(1);
  expect(screenStill("out\n✻ Writing tests\n❯ ")).not.toBe(screenStill("out\n✻ Thinking\n❯ "));
  expect(screenStill("a/b - c")).toBe("a/b  c");
});

test("warm idle delivery appends once without restarting the lead", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND warm");
  await supervisor.flush();
  supervisor.enqueue("discord:1:1", "INBOUND warm");
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "discord:1:1", line: "INBOUND warm" }]);
  expect(f.calls.some((call) => call[0] === "kill" || call[2] === "run")).toBe(false);
});

test("a lane's dori report question reaches the lead as an urgent LANE_REPORT within 10 s, with no pane typing", async () => {
  const f = fixture();
  await f.deps.registry.write({ key: "local-lane", title: "t", thread: "none", pane: "w:p7", brief: "b", done: "d", openedAt: new Date(f.clock.now()).toISOString() });
  const supervisor = new Supervisor(f.deps);
  const reports = openLaneReports(f.deps.config);
  cleanups.push(() => { reports.close(); });
  // The lane writes its rows (what `dori report` does); nothing is typed into the lead's pane.
  const written = f.clock.now();
  reports.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "tests green", at: written });
  reports.append({ lane: "local-lane", generation: 0, kind: "question", text: "which\nbase branch?", at: written });
  // One polling pass routes the rows, one delivery pass hands them over.
  f.clock.at += 5_000;
  expect(await routeReports(f.deps, reports, (id, line) => supervisor.enqueue(id, line))).toEqual([
    "LANE_REPORT_ROUTED local-lane:0:1 milestone journal", "LANE_REPORT_ROUTED local-lane:0:2 question journal",
  ]);
  f.clock.at += 5_000;
  await supervisor.flush();
  expect(f.clock.now() - written).toBeLessThanOrEqual(10_000);
  // The question wakes the lead; the milestone is digest by the policy table and waits for the next urgent delivery.
  const delivered = f.log();
  expect(delivered.some((event: { line: string }) => event.line === "LANE_REPORT local-lane question which base branch?")).toBe(true);
  expect(eventClass("LANE_REPORT local-lane question which base branch?", f.deps.config.eventPolicy)).toBe("lead-urgent");
  expect(eventClass("LANE_REPORT local-lane milestone tests green", f.deps.config.eventPolicy)).toBe("lead-digest");
  expect(f.calls.some((call) => call[0] === "herdr" && (call[2] === "send-text" || call[2] === "send-keys"))).toBe(false);
  // Consumed: the next pass routes nothing.
  expect(reports.pending()).toEqual([]);
  expect(await routeReports(f.deps, reports, (id, line) => supervisor.enqueue(id, line))).toEqual([]);
});

test("a forced restart takes a warm idle lead without traffic and applies model and thinking", async () => {
  const f = fixture();
  requestLeadRestart(f.deps.config, f.clock.now(), "test/forced", "high");
  const supervisor = new Supervisor(f.deps);
  await supervisor.flush();
  expect(f.command()).toContain("--model test/forced --thinking high");
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
  expect(pendingLeadRestart(f.state.dir)).toBeUndefined();
  expect(readJournal(f.state.dir).models).toEqual([{ model: "test/forced", thinking: "high" }]);
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test.each(["working", "blocked", "unknown"])("a forced restart waits for a %s lead while events still deliver warm", async (status) => {
  const f = fixture();
  f.pane.agent_status = status;
  const request = requestLeadRestart(f.deps.config, f.clock.now(), "test/forced");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("queued", "INBOUND queued");
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "queued", line: "INBOUND queued" }]);
  expect(f.calls.some((call) => call[0] === "kill" || call[2] === "run")).toBe(false);
  expect(pendingLeadRestart(f.state.dir)?.id).toBe(request.id);
  f.pane.agent_status = "idle";
  await new Supervisor(f.deps).flush();
  expect(f.command()).toContain("--model test/forced");
  expect(pendingLeadRestart(f.state.dir)).toBeUndefined();
});

test("a forced restart captures edited config and preserves a newer request arriving at startup", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  requestLeadRestart({ ...f.deps.config, leadModel: "edited/model", leadThinking: "medium" }, f.clock.now());
  f.onWait(async () => {
    f.onWait(async () => {});
    requestLeadRestart(f.deps.config, f.clock.now(), "newer/model", "high");
    f.pane.agent_status = "working";
  });
  await supervisor.flush();
  expect(f.command()).toContain("--model edited/model --thinking medium");
  expect(pendingLeadRestart(f.state.dir)?.models[0]?.model).toBe("newer/model");
});

test.each([false, true])("a durable wait wakes a cold=%s lead through normal delivery", async (cold) => {
  const f = fixture();
  if (cold) f.cold();
  const file = join(f.state.dir, "ready");
  writeFileSync(file, "");
  new Waits(f.state.dir).register({ key: "release", until: `file ${file}`, note: "tell owner", cwd: f.state.dir }, f.clock.now());
  const supervisor = new Supervisor(f.deps);
  await new Waits(f.state.dir).tick(f.clock.now, f.deps.run, (id, line) => supervisor.enqueue(id, line));
  await supervisor.flush();
  expect(f.log().map((event) => event.line)).toEqual(["WAIT_DONE release tell owner"]);
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(cold ? 1 : 0);
});

test("an unseen newly idle agent reported as done is positive startup evidence", async () => {
  const f = fixture();
  f.cold();
  f.onWait(async () => { f.pane.agent_status = "done"; });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-state", "INBOUND done-state");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["done-state"]);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("at the TTL boundary cold delivery starts a fresh session in the same pane and stops only owned processes", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("cold", "INBOUND cold");
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "cold", line: "INBOUND cold" }]);
  expect(f.prompt()).toContain('"id":"cold"');
  const launched = f.calls.filter((call) => call[2] === "run");
  expect(launched).toHaveLength(1);
  expect(launched[0]?.[3]).toBe("lead:p1");
  expect(f.calls.filter((call) => call[0] === "kill").map((call) => call[2])).toEqual(["103", "102", "101"]);
  expect(f.prompt()).toContain(`tail -c +${Buffer.byteLength(`${JSON.stringify(f.log()[0])}\n`) + 1}`);
});

test("a stale lead with a pending durable wait delivers warm", async () => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait-active", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run" || call[0] === "kill")).toEqual([]);
  expect(f.log().map((event) => event.id)).toEqual(["wait-active"]);
});

test("a stale lead with a working registry lane delivers warm", async () => {
  const f = fixture();
  await f.deps.registry.write({
    key: "working", title: "Working lane", thread: "discord:1/2", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status: "working",
  });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-active", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run" || call[0] === "kill")).toEqual([]);
  expect(f.log().map((event) => event.id)).toEqual(["lane-active"]);
});

test.each([
  [149_999, false], [150_000, true], [150_001, true],
] as const)("stale usage %s restarts=%s despite waits and working lanes", async (tokens, restart) => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  await f.deps.registry.write({
    key: "working", title: "Working lane", thread: "discord:1/2", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status: "working",
  });
  writeFileSync(f.file, [
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 300_000 } } }),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: tokens } } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
  ].join("\n") + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("cap", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(restart ? 1 : 0);
  expect(f.log().map((event) => event.id)).toEqual(["cap"]);
  expect(new Waits(f.state.dir).list()).toHaveLength(1);
});

test("a custom context cap controls stale delivery rather than the default cap", async () => {
  const f = fixture({ leadContextCapTokens: 42_000 });
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: 50_000 } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("custom-cap", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test("usage above the cap does not restart a lead before its cache is stale", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: 200_000 } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("fresh-cap", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run" || call[0] === "kill")).toEqual([]);
});

test.each([
  [299_999, false], [300_000, true], [300_001, true],
] as const)("usage %s inside the TTL restarts=%s at the hard cap, logging LEAD_HARD_CAP", async (tokens, restart) => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: tokens } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("hard-cap", "INBOUND owner");
    await supervisor.flush();
  } finally { console.log = original; }
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(restart ? 1 : 0);
  expect(logged.includes(`LEAD_HARD_CAP ${tokens}`)).toBe(restart);
  expect(f.log().map((event) => event.id)).toEqual(["hard-cap"]);
});

test("a custom hard cap controls the in-TTL restart", async () => {
  const f = fixture({ leadContextHardCapTokens: 180_000 });
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: 200_000 } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("custom-hard", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test.each([
  "not json\n",
  '{"message":{"role":"toolResult"}}\n',
  '{"message":{"usage":{"totalTokens":"200000"}}}\n',
  '{"message":{"usage":null}}\n',
  '{"message":{"usage":{"totalTokens":-1}}}\n',
])("unreadable usage is under-cap for a stale lead with a wait: %s", async (text) => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  writeFileSync(f.file, text);
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("unreadable", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run" || call[0] === "kill")).toEqual([]);
});

test.each(["paused", "done-claimed", "not-done", "closed"] as const)("a %s lane does not retain a stale lead", async (status) => {
  const f = fixture();
  await f.deps.registry.write({
    key: "inactive", title: "Inactive lane", thread: "discord:1/2", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status,
  });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("inactive-lane", "INBOUND owner");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test("an expired but working lead receives an append and is never stopped", async () => {
  const f = fixture();
  f.cold();
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("working", "INBOUND working");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["working"]);
  expect(f.calls.some((call) => call[0] === "kill" || call[2] === "run")).toBe(false);
});

test("events arriving during restart stay queued and follow the prompt handoff exactly once", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("first", "INBOUND first");
  f.onWait(async () => {
    supervisor.enqueue("second", "INBOUND second");
    f.pane.agent_status = "working";
  });
  await Promise.all([supervisor.flush(), supervisor.flush()]);
  expect(f.log().map((event) => event.id)).toEqual(["first", "second"]);
  expect(f.prompt()).toContain('"id":"first"');
  expect(f.prompt()).not.toContain('"id":"second"');
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

const restartSession = (f: ReturnType<typeof fixture>) => readJournal(f.state.dir).restart;
const launchedSessions = (f: ReturnType<typeof fixture>) => f.calls.filter((call) => call[2] === "run").map((call) => /--session-id ([\w-]+)/.exec(call[4] ?? "")?.[1]);

test("a healthy cold start with holder evidence launches once and never kills the new session", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("healthy", "INBOUND healthy");
  await supervisor.flush();
  expect(launchedSessions(f)).toHaveLength(1);
  expect(f.calls.filter((call) => call[0] === "kill" && call[2] === "201")).toHaveLength(0);
  expect(restartSession(f)).toBeUndefined();
});

test("a hung cold start is killed by exact session and relaunched once with the same events and offset", async () => {
  const f = fixture();
  f.cold();
  f.hang(1);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("hung", "INBOUND hung");
  const before = f.clock.now();
  await supervisor.flush();
  const [first, second] = launchedSessions(f);
  expect(launchedSessions(f)).toHaveLength(2);
  expect(second).not.toBe(first);
  // the hung process (pid 201) was killed after the evidence deadline, not the original lead twice
  expect(f.calls.filter((call) => call[0] === "kill" && call[2] === "201")).toHaveLength(1);
  expect(f.clock.now() - before).toBeGreaterThanOrEqual(20_000);
  expect(f.log()).toEqual([{ id: "hung", line: "INBOUND hung" }]);
  expect(f.prompt()).toContain('"id":"hung"');
  expect(f.prompt()).toContain(`tail -c +${statSync(join(f.state.dir, "lead-events.log")).size + 1} -F`);
  expect(restartSession(f)).toBeUndefined();
});

test("two hung launches journal LEAD_STARTUP_HUNG, retain the events, and do not relaunch in a tight loop", async () => {
  const f = fixture();
  f.cold();
  f.hang(2);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("hung2", "INBOUND hung2");
    await expect(supervisor.flush()).rejects.toThrow("LEAD_STARTUP_HUNG");
  } finally { console.log = original; }
  const sessions = launchedSessions(f);
  expect(sessions).toHaveLength(2);
  expect(lines.some((line) => line === `LEAD_STARTUP_HUNG ${sessions[1]}`)).toBe(true);
  const pending = restartSession(f);
  expect(pending.phase).toBe("starting");
  expect(pending.events).toEqual([{ id: "hung2", line: "INBOUND hung2" }]);
  expect(pending.session).not.toBe(sessions[1]);
  // a later backoff retry relaunches and recovers with the retained events
  await new Supervisor(f.deps).flush();
  expect(launchedSessions(f)).toHaveLength(3);
  expect(restartSession(f)).toBeUndefined();
});

test("a supervisor restart preserves queued input and does not duplicate a prior append", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("delivered", "INBOUND delivered");
  await before.flush();
  before.enqueue("pending", "INBOUND pending");
  const after = new Supervisor(f.deps);
  after.enqueue("delivered", "INBOUND delivered");
  await after.flush();
  expect(f.log().map((event) => event.id)).toEqual(["delivered", "pending"]);
});

test("unconfirmed startup retains the transaction and recovery confirms the same launch without resubmitting", async () => {
  const f = fixture();
  f.cold();
  f.setConfirm(false);
  const before = new Supervisor(f.deps);
  before.enqueue("pending", "INBOUND pending");
  await expect(before.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
  expect(readJournal(f.state.dir).restart.phase).toBe("submitted");
  f.setConfirm(true);
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(f.log().map((event) => event.id)).toEqual(["pending"]);
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("a partial final log record is recovered from the durable inbox", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("recover", "INBOUND recover");
  writeFileSync(join(f.state.dir, "lead-events.log"), '{"id":"recover"');
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(f.log()).toEqual([{ id: "recover", line: "INBOUND recover" }]);
});

test("only one supervisor may own a state directory and releasing it permits a restart", () => {
  const f = fixture();
  const release = acquireSupervisor(f.state.dir);
  try { expect(() => acquireSupervisor(f.state.dir)).toThrow("lock"); }
  finally { release(); }
  acquireSupervisor(f.state.dir)();
});

test("a shell with no live agent starts the lead instead of appending into an unmonitored log", async () => {
  const f = fixture();
  f.noAgent();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("missing", "INBOUND missing-agent");
  await supervisor.flush();
  expect(f.prompt()).toContain('"id":"missing"');
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test("stale ready state from the old occupant cannot confirm a new generation", async () => {
  const f = fixture();
  f.cold();
  let stale = true;
  const run: Runner = async (argv, options) => {
    if (argv[2] === "process-info" && f.command() && stale) {
      stale = false;
      return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ["omo", "--session-id", "old-generation"] }] } } }) };
    }
    return f.deps.run(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("fresh", "INBOUND fresh");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "wait")).toHaveLength(2);
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test("the shell interval before a new agent registers is not a startup failure", async () => {
  const f = fixture();
  f.noAgent();
  let waiting = true;
  const run: Runner = async (argv, options) => {
    if (argv[2] === "wait" && waiting) {
      waiting = false;
      return { code: 1, out: "", err: "agent_not_running" };
    }
    return f.deps.run(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("registering", "INBOUND registering");
  await supervisor.flush();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("a lead that wakes during cold process resolution receives a warm append without interruption", async () => {
  const f = fixture();
  f.cold();
  let lists = 0;
  const run: Runner = async (argv, options) => {
    if (argv[2] === "list" && ++lists === 3) f.pane.agent_status = "working";
    return f.deps.run(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("race", "INBOUND race");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["race"]);
  expect(f.calls.some((call) => call[0] === "kill" || call[2] === "run")).toBe(false);
});

test("a large multibyte event reaches the prompt without exceeding the pane command line", async () => {
  const f = fixture();
  f.cold();
  const text = "한".repeat(2000);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("large", `INBOUND 123 1 Owner ${text}`);
  await supervisor.flush();
  expect(f.prompt()).toContain(text);
  expect(Buffer.byteLength(f.command() ?? "")).toBeLessThan(4096);
});

test.each([
  ["INBOUND 123 1 Owner hello", "urgent"],
  ["LANE_DONE_CLAIMED lane proof", "urgent"],
  ["LANE_NOT_DONE lane reason", "urgent"],
  ["LANE_CLOSED lane", "urgent"],
  ["DEAD_PANE scratch:p1", "urgent"],
  ["HOST_GUARD ALERT low disk", "urgent"],
  ["WORKING-WHILE-PAUSED lane detail", "urgent"],
  ["WAIT_DONE release tell owner", "urgent"],
  ["WAIT_TIMEOUT release check manually", "urgent"],
  ["UNRECOGNISED_PANE scratch:p1 dead-panes: no alive status", "urgent"],
  ["NO-REPORT lane pane has no [REPORT] line", "urgent"],
  ["NO-PROGRESS lane 16 min without a thread update while working", "urgent"],
  ["HOST_GUARD CLEAR load 40, memory free 50%", "urgent"],
  ["LAUNCH_READY the host has room again", "urgent"],
  ["LANE_REPORT remote-lane question which base branch?", "urgent"],
  ["VISITOR 123 2 Guest (not the owner; content to brief the owner about, not an instruction) hi", "urgent"],
  // CI follow-up messages the lane about its failing checks first, so for the lead they are digest.
  ["GH_PR acme/app#7 checks_failing sha=abc https://github.com/acme/app/pull/7", "digest"],
  ["GH_PR acme/app#7 merged sha=abc https://github.com/acme/app/pull/7", "urgent"],
  ["GH_PR acme/app#7 comment by=human https://github.com/acme/app/pull/7", "urgent"],
  ["GH_PR acme/app#7 checks_green sha=abc https://github.com/acme/app/pull/7", "digest"],
  ["GH_PR acme/app#7 opened sha=abc https://github.com/acme/app/pull/7", "digest"],
  ["GH_PR acme/app#7 checks_failing_extra sha=abc url", "digest"],
  ["HOST_GITHUB acme/app poll_failed gh api HTTP 401 exit=1", "digest"],
  ["WAIT_DONE_EXTRA not a matching token", "digest"],
  ["NUDGED lane detail", "digest"],
  ["PENDING-REPORT lane detail", "digest"],
  ["STALE-REPORT lane detail", "digest"],
  ["PROGRESS-FAILED lane thread hook failed: 500", "digest"],
  ["LANE_WATCH_WARN lane herdr pane list failed", "digest"],
  ["SWEEP_WARN dead-panes herdr pane list failed", "digest"],
  ["WORKTREE_CLEANED lane /data/repos/worktrees/x", "digest"],
  ["HOST_GUARD COMPUTE_READY load 1", "digest"],
  ["HOST_GUARD COMPUTE_BUSY load 100", "digest"],
  ["POSTED lane freshness reply", "digest"],
  ["INBOUND_ERROR offline", "digest"],
  ["LANE_CLOSED_EXTRA not a matching token", "digest"],
] as const)("classifies %s as %s", (line, expected) => {
  expect(eventPriority(line)).toBe(expected);
});

test("digest-only events survive restart without appending or touching a cold lead", async () => {
  const f = fixture();
  f.cold();
  const before = new Supervisor(f.deps);
  before.enqueue("digest", "HOST_GUARD COMPUTE_READY load 1");
  await before.flush();
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(f.log()).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(readJournal(f.state.dir).events).toHaveLength(1);
});

test("a kind's class comes from config: owner-only is posted to the owner, engine-only stays journaled, neither reaches the lead", async () => {
  const f = fixture({ eventPolicy: resolveEventPolicy({ kinds: { "GH_PR * opened": "lead-urgent", NUDGED: "engine-only", LANE_REPORT: "owner-only" } }) });
  const posted: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { posted.push(text); } });
  supervisor.enqueue("nudged", "NUDGED lane silent");
  supervisor.enqueue("report", "LANE_REPORT lane question which base?");
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  supervisor.enqueue("pr", "GH_PR acme/app#7 opened sha=1 https://github.com/acme/app/pull/7");
  await supervisor.flush();
  await supervisor.reactionsSettled();
  expect(f.log().map((event) => event.id)).toEqual(["pr"]);
  expect(posted).toEqual(["LANE_REPORT lane question which base?"]);
  f.clock.at += 2 * 60 * 60_000;
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["pr"]);
  expect(readJournal(f.state.dir).events.map((event: { id: string }) => event.id)).toEqual(["nudged", "report", "pr"]);
  supervisor.close();
});

test("a warm wake records its trigger kinds and is closed with the lead's model calls when the next wake starts", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudged", "NUDGED lane silent");
  supervisor.enqueue("owner", "INBOUND 1 1 hello");
  await supervisor.flush();
  const woke = f.clock.now();
  const record = (role: string, ms: number) => JSON.stringify({ type: "message", timestamp: new Date(ms).toISOString(), message: { role } });
  appendFileSync(f.file, `${[record("assistant", woke - 1_000), record("user", woke + 500), record("assistant", woke + 1_000), record("assistant", woke + 2_000)].join("\n")}\n`);
  f.clock.at += 3_000;
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  supervisor.enqueue("merged", "GH_PR acme/app#7 merged sha=1 https://github.com/acme/app/pull/7");
  await supervisor.flush();
  supervisor.close();
  expect(readWakes(f.state.dir, 0)).toEqual([
    { at: woke, session: f.file, trigger: ["INBOUND"], kinds: { NUDGED: 1, INBOUND: 1 }, calls: 2, closed: true },
    { at: woke + 3_000, session: f.file, trigger: ["GH_PR * merged"], kinds: { "GH_PR * merged": 1 } },
  ]);
  expect(readWakes(f.state.dir, woke + 1)).toHaveLength(1);
});

test("a cold start is a wake on the new session; a digest-only batch past digestMaxDelayMin is triggered by its overdue kinds", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudged", "NUDGED lane silent");
  f.clock.at += 61 * 60_000;
  await supervisor.flush();
  supervisor.close();
  const session = /--session-id ([\w-]+)/.exec(f.command() ?? "")?.[1] ?? "";
  expect(session).not.toBe("");
  expect(readWakes(f.state.dir, 0)).toEqual([{ at: f.clock.now(), session, trigger: ["NUDGED"], kinds: { NUDGED: 1 } }]);
});

test("digest waits for an urgent event, but no longer than digestMaxDelayMin", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("digest", "NUDGED lane silent");
  f.clock.at += 59 * 60_000;
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  f.clock.at += 60_000;
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "digest", line: "NUDGED lane silent" }]);
});

test("a sweep warning alone never forces a delivery, however old it gets", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("warn", "LANE_WATCH_WARN lane worktree /x not removed: locked");
  f.clock.at += 6 * 60 * 60_000;
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("an owner message the lead has not taken within a minute is reported once; a delivered one never", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:100:7", "INBOUND 100 7 Owner are you there");
  supervisor.enqueue("discord:100:8", "VISITOR 100 8 Guest (not the owner) hi");
  supervisor.enqueue("gh:1", "GH_PR acme/app#7 merged url");
  // The lead pane is gone: delivery fails (transient) and the owner's message stays undelivered.
  f.pane.pane_id = "gone:p9";
  await expect(supervisor.flush()).rejects.toThrow("does not exist");
  expect(supervisor.overdueOwnerMessages(60_000)).toEqual([]);
  f.clock.at += 60_000;
  expect(supervisor.overdueOwnerMessages(60_000)).toEqual([{ channel: "100", message: "7" }]);
  supervisor.noticeSent("delay", "100", "7");
  expect(new Supervisor(f.deps).overdueOwnerMessages(60_000)).toEqual([]);
  const delivered = fixture();
  const warm = new Supervisor(delivered.deps);
  warm.enqueue("discord:100:9", "INBOUND 100 9 Owner hi");
  await warm.flush();
  delivered.clock.at += 120_000;
  expect(warm.overdueOwnerMessages(60_000)).toEqual([]);
});

test("the next warm urgent delivery includes held digest once", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("digest", "NUDGED lane silent");
  await before.flush();
  const after = new Supervisor(f.deps);
  after.enqueue("urgent", "INBOUND 123 1 Owner hello");
  await after.flush();
  await after.flush();
  expect(f.log().map((event) => event.id)).toEqual(["digest", "urgent"]);
  expect(f.calls.some((call) => call[0] === "kill" || call[2] === "run")).toBe(false);
});

test("GitHub digest survives restart then joins an actionable PR event exactly once", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("github:opened", "GH_PR acme/app#7 opened sha=abc url");
  await before.flush();
  expect(f.calls).toEqual([]);
  expect(f.log()).toEqual([]);
  const after = new Supervisor(f.deps);
  after.enqueue("github:merged", "GH_PR acme/app#7 merged sha=abc url");
  await after.flush();
  const restarted = new Supervisor(f.deps);
  restarted.enqueue("github:merged", "GH_PR acme/app#7 merged sha=abc url");
  await restarted.flush();
  expect(f.log().map((event) => event.id)).toEqual(["github:opened", "github:merged"]);
  expect(f.calls.some((call) => call[0] === "kill" || call[2] === "run")).toBe(false);
});

test("the next cold urgent delivery includes held digest in the new session prompt", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("digest", "NUDGED lane silent");
  await supervisor.flush();
  supervisor.enqueue("urgent", "LANE_DONE_CLAIMED lane proof");
  await supervisor.flush();
  expect(f.prompt()).toContain('"id":"digest"');
  expect(f.prompt()).toContain('"id":"urgent"');
  expect(f.log().map((event) => event.id)).toEqual(["digest", "urgent"]);
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

test("a claim reads delivered to the lead only once a cold start carrying it confirmed", async () => {
  const f = fixture();
  f.cold();
  f.setConfirm(false);
  const before = new Supervisor(f.deps);
  before.enqueue("done-claim:lane:t", "LANE_DONE_CLAIMED lane - proof");
  expect(before.leadDelivered("done-claim:lane:t")).toBe(false);
  await expect(before.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
  // Logged into the cold batch, but the new lead has not confirmed: not received yet.
  expect(f.log().map((event) => event.id)).toEqual(["done-claim:lane:t"]);
  expect(before.leadDelivered("done-claim:lane:t")).toBe(false);
  f.setConfirm(true);
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(after.leadDelivered("done-claim:lane:t")).toBe(true);
  expect(after.leadDelivered("done-claim:lane:other")).toBe(false);
});

test("a claim delivered warm reads delivered at once", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:lane:t", "LANE_DONE_CLAIMED lane - proof");
  await supervisor.flush();
  expect(supervisor.leadDelivered("done-claim:lane:t")).toBe(true);
});

test("a machine-closed lane's claim and close are digest and wake no lead", async () => {
  const f = fixture();
  expect(eventPriority("LANE_AUTO_CLAIMED lane w:p1 merged acme/app#1")).toBe("digest");
  expect(eventPriority("LANE_AUTO_CLOSED lane {}")).toBe("digest");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("sweep:1", "LANE_AUTO_CLAIMED lane w:p1 merged acme/app#1");
  supervisor.enqueue("sweep:2", "LANE_AUTO_CLOSED lane {}");
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("a cold start points the lead at the full SKILL.md and puts leadArgs on the lead command only", async () => {
  const f = fixture({ leadArgs: ["--approve"], defaultModel: "test/lead-default" });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("card", "INBOUND card");
  await supervisor.flush();
  expect(LEAD_SKILL.endsWith("/skills/dori-mode/SKILL.md")).toBe(true);
  expect(existsSync(LEAD_SKILL)).toBe(true);
  expect(f.prompt()).toContain(LEAD_SKILL);
  expect(f.prompt()).toContain("Supervised mode: do not start inbound pollers or sweeps.");
  const command = f.command() ?? "";
  expect(command).toMatch(/omo '?--session-id'? \S+ '?--session-dir'? \S+ '?--approve'? '?--model'?/);
  expect(command).toContain("test/lead-default");
});

const WITH_THINKING = ["omo", "--model", "{model}", "--thinking", "medium", "{prompt}"];
/** The lead's agent argv after `--session-dir <dir>`, up to the `@prompt` file. */
const leadAgent = async (extra: Record<string, unknown>) => {
  const f = fixture({ defaultModel: "test/lane-default", ...extra });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("card", "INBOUND card");
  await supervisor.flush();
  return /--session-dir \S+ (.*) @\S+$/.exec(f.command() ?? "")?.[1];
};

test.each([
  ["no lead fields keep agentCommand with defaultModel", {}, "--model test/lane-default --thinking medium"],
  ["leadModel sets only the lead's model", { leadModel: "test/lead" }, "--model test/lead --thinking medium"],
  ["leadThinking replaces only the lead's --thinking value", { leadThinking: "high" }, "--model test/lane-default --thinking high"],
  ["both lead fields apply together", { leadModel: "test/lead", leadThinking: "high" }, "--model test/lead --thinking high"],
  ["blank lead fields count as unset", { leadModel: " ", leadThinking: "" }, "--model test/lane-default --thinking medium"],
])("lead command: %s", async (_, extra, expected) => {
  expect(await leadAgent({ agentCommand: WITH_THINKING, ...extra })).toBe(expected);
});

test("lead command: leadThinking goes right after the --model pair when agentCommand has no --thinking", async () => {
  expect(await leadAgent({ agentCommand: ["omo", "--model", "{model}", "--yolo", "{prompt}"], leadThinking: "high" }))
    .toBe("--model test/lane-default --thinking high --yolo");
  // Without leadThinking nothing is inserted.
  expect(await leadAgent({ agentCommand: ["omo", "--model", "{model}", "--yolo", "{prompt}"] })).toBe("--model test/lane-default --yolo");
});

const recordReactions = () => {
  const ops: string[] = [];
  return { ops, react: async (op: string, channel: string, message: string, emoji: string) => { ops.push(`${op} ${channel}/${message} ${emoji}`); } };
};

test("a cold restart reacts hourglass on the owner's inbound message and leaves it for the lead to hand over", async () => {
  const f = fixture();
  f.cold();
  const r = recordReactions();
  const supervisor = new Supervisor(f.deps, r);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  supervisor.enqueue("sweep:x:1", "DEAD_PANE w1:p1");
  await supervisor.flush();
  await supervisor.reactionsSettled();
  // LEAD_RESTARTED only means the new process initialised. The lead removes the hourglass and adds its eyes as
  // one back-to-back pair once it is reading, so the supervisor must not take the hourglass off here.
  expect(r.ops).toEqual(["add 11/22 \u23F3"]);
  expect(restartSession(f)).toBeUndefined();
});

test("a final hung start swaps the hourglass for the warning sign", async () => {
  const f = fixture();
  f.cold();
  f.hang(2);
  const r = recordReactions();
  const supervisor = new Supervisor(f.deps, r);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  const original = console.log;
  console.log = () => {};
  try { await expect(supervisor.flush()).rejects.toThrow("LEAD_STARTUP_HUNG"); } finally { console.log = original; }
  await supervisor.reactionsSettled();
  expect(r.ops).toEqual(["add 11/22 \u23F3", "remove 11/22 \u23F3", "add 11/22 \u26A0\uFE0F"]);
});

test("warm delivery and non-discord or non-inbound events get no reaction", async () => {
  const warm = fixture();
  const r1 = recordReactions();
  const s1 = new Supervisor(warm.deps, r1);
  s1.enqueue("discord:11:22", "INBOUND 11 22 owner warm");
  await s1.flush();
  await s1.reactionsSettled();
  expect(r1.ops).toEqual([]);
  const cold = fixture();
  cold.cold();
  const r2 = recordReactions();
  const s2 = new Supervisor(cold.deps, r2);
  s2.enqueue("gh:1", "INBOUND gh");
  s2.enqueue("discord:11:23", "GH_PR something");
  await s2.flush();
  await s2.reactionsSettled();
  expect(r2.ops).toEqual([]);
});

test("a failing reaction never fails or blocks the restart", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps, { react: async () => { throw new Error("discord down"); } });
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  const original = console.error;
  console.error = () => {};
  try {
    await supervisor.flush();
    await supervisor.reactionsSettled();
  } finally { console.error = original; }
  expect(restartSession(f)).toBeUndefined();
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(1);
});

/** Captures console.log lines and silences console.error while `body` runs. */
const quiet = async (body: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = () => {};
  try { await body(); } finally { [console.log, console.error] = [log, error]; }
  return lines;
};

/** herdr answers for pane recreation: workspace "Dori" (w7), a new tab with root pane w7:p9, and pane close. */
const recreating = (f: ReturnType<typeof fixture>, next: Runner): Runner => async (argv, options) => {
  if (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { workspaces: [{ workspace_id: "w7", label: "Dori" }] } }), err: "" };
  if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
    f.calls.push([...argv]);
    f.world.panes.push({ pane_id: "w7:p9", workspace_id: "w7", cwd: "/repo", agent: "omo", agent_status: "idle" });
    return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w7:p9" } } }), err: "" };
  }
  if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close") {
    f.calls.push([...argv]);
    f.world.panes.splice(f.world.panes.findIndex((p) => p.pane_id === argv[3]), 1);
    return { code: 0, out: "", err: "" };
  }
  return next(argv, options);
};

test("a lead pane closed by hand together with its Dori workspace is recreated in a new Dori workspace and cold-started with the pending events", async () => {
  const f = fixture();
  f.cold();
  // The owner closes the lead's only pane: the process is gone and herdr drops the now empty Dori workspace with it.
  f.world.panes.splice(f.world.panes.indexOf(f.pane), 1);
  f.noAgent();
  const workspaces: { workspace_id: string; label: string }[] = [];
  const run: Runner = async (argv, options) => {
    if (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { workspaces } }), err: "" };
    if (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "create") {
      f.calls.push([...argv]);
      workspaces.push({ workspace_id: "w8", label: "Dori" });
      // A fresh shell at the root pane: the fixture's pane object stands for it, so a launch typed there takes it over.
      Object.assign(f.pane, { pane_id: "w8:p1", workspace_id: "w8" });
      f.world.panes.push(f.pane);
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w8:p1", tab_id: "w8:t1", workspace_id: "w8" } } }), err: "" };
    }
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "rename") { f.calls.push([...argv]); return { code: 0, out: "", err: "" }; }
    return f.deps.run(argv, options);
  };
  const persisted: string[] = [];
  const supervisor = new Supervisor({ ...f.deps, run, config: { ...f.deps.config } }, { persistLeadPane: (pane) => { persisted.push(pane); } });
  supervisor.enqueue("inbound:1", "INBOUND hello");
  const retries: string[] = [];
  const delivery = new RetryingDelivery({
    now: f.clock.now, flush: () => supervisor.flush(), repair: () => supervisor.repairLeadPane(),
    enqueue: () => {}, notify: async () => {}, log: (line) => { retries.push(line); },
  }, "boot");
  const lines = await quiet(async () => {
    await delivery.tick();
    f.clock.at = delivery.nextAttemptAt;
    await delivery.tick();
  });
  expect(retries).toEqual([expect.stringMatching(/^SUPERVISOR_RETRY lead pane lead:p1 does not exist; attempt 1/)]);
  expect(f.calls).toContainEqual(["herdr", "workspace", "create", "--label", "Dori", "--cwd", "/repo", "--no-focus"]);
  expect(f.calls).toContainEqual(["herdr", "tab", "rename", "w8:t1", "dori-lead"]);
  expect(persisted).toEqual(["w8:p1"]);
  expect(lines).toContain("LEAD_PANE_RECREATED lead:p1 -> w8:p1");
  const [launched] = launchedSessions(f);
  expect(launchedSessions(f)).toHaveLength(1);
  expect(f.calls.find((call) => call[2] === "run")?.[3]).toBe("w8:p1");
  expect(f.prompt()).toContain("INBOUND hello");
  expect(lines).toContain(`LEAD_RESTARTED w8:p1 ${launched}`);
  expect(restartSession(f)).toBeUndefined();
  expect(delivery.due).toBe(true);
});

test("a starting restart is never typed into a pane whose foreground is an agent, and launches once a plain shell is back", async () => {
  const f = fixture();
  // The issue's case: the journal is past "stopping" (a recreated pane or a hung retry) and the owner started omo by hand.
  writeJournal(f.state.dir, ({ events: [{ id: "x", line: "INBOUND x" }], restart: { session: "22222222-2222-4222-8222-222222222222", events: [{ id: "x", line: "INBOUND x" }], offset: 0, phase: "starting" } }));
  // "stopping" already logged the cold batch before the launch.
  writeFileSync(join(f.state.dir, "lead-events.log"), `${JSON.stringify({ id: "x", line: "INBOUND x" })}\n`);
  await expect(new Supervisor(f.deps).flush()).rejects.toThrow("LEAD_PANE_BUSY lead:p1: foreground is not a plain shell (omo)");
  expect(f.calls.filter((call) => call[2] === "run")).toHaveLength(0);
  expect(restartSession(f).phase).toBe("starting");
  f.noAgent();
  await quiet(() => new Supervisor(f.deps).flush());
  expect(launchedSessions(f)).toEqual(["22222222-2222-4222-8222-222222222222"]);
  expect(restartSession(f)).toBeUndefined();
});

test("a submitted launch that never confirms is abandoned after the limit: screen saved, pane replaced, fresh session", async () => {
  const f = fixture();
  f.cold();
  f.setConfirm(false);
  f.hang(1); // the launch never initialises: no holder file, no session jsonl
  const deps = { ...f.deps, run: recreating(f, f.deps.run), config: { ...f.deps.config } };
  // One supervisor process: the recreated pane id lives in its deps (and in config through persistLeadPane).
  const supervisor = new Supervisor(deps);
  supervisor.enqueue("stuck", "INBOUND stuck");
  const lines = await quiet(async () => {
    for (let i = 1; i < UNCONFIRMED_LIMIT; i++) {
      await expect(supervisor.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
      expect(restartSession(f)).toMatchObject({ phase: "submitted", unconfirmed: i });
    }
    await expect(supervisor.flush()).rejects.toThrow("lead pane recreated as w7:p9");
  });
  const [launched] = launchedSessions(f);
  const pending = restartSession(f);
  expect(launchedSessions(f)).toHaveLength(1);
  expect(pending).toMatchObject({ phase: "starting", unconfirmed: 0, events: [{ id: "stuck", line: "INBOUND stuck" }] });
  expect(pending.session).not.toBe(launched);
  // the never-confirmed process was stopped by its exact session, then the screen was read before the pane closed
  expect(f.calls.filter((call) => call[0] === "kill" && call[2] === "201")).toHaveLength(1);
  const read = f.calls.findIndex((call) => call.join(" ") === "herdr pane read lead:p1 --source recent --lines 80");
  const killed = f.calls.findIndex((call) => call[0] === "kill" && call[2] === "201");
  const closed = f.calls.findIndex((call) => call.join(" ") === "herdr pane close lead:p1");
  expect(read).toBeGreaterThanOrEqual(0);
  expect(killed).toBeGreaterThan(read);
  expect(closed).toBeGreaterThan(killed);
  const saved = readdirSync(f.state.dir).filter((name) => name.startsWith("lead-pane-lead_p1-"));
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(f.state.dir, saved[0] ?? ""), "utf8")).toBe("❯ ");
  expect(lines).toContain(`LEAD_PANE_SCREEN_SAVED lead:p1 ${join(f.state.dir, saved[0] ?? "")}`);
  expect(lines).toContain("LEAD_PANE_RECREATED lead:p1 -> w7:p9");
  expect(existsSync(join(f.state.dir, `lead-${launched}.md`))).toBe(false);
  // the next backoff retry launches the fresh session into the new pane
  f.setConfirm(true);
  await quiet(() => supervisor.flush());
  expect(launchedSessions(f)).toEqual([launched, pending.session]);
  expect(f.calls.filter((call) => call[2] === "run").at(-1)?.[3]).toBe("w7:p9");
  expect(restartSession(f)).toBeUndefined();
});

test("argv-less foreground entries never crash, and a pane held by a process the supervisor did not start is kept", async () => {
  const f = fixture();
  f.cold();
  f.hang(1);
  let foreign = false;
  // After the launch the pane runs something else (the owner's own omo); herdr lists its entries without argv.
  const run: Runner = async (argv, options) => {
    if (argv[2] === "process-info" && foreign) return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_process_group_id: 300, foreground_processes: [{ pid: 300 }, { pid: 301, name: "node" }] } } }) };
    const out = await f.deps.run(argv, options);
    if (argv[2] === "run") foreign = true;
    return out;
  };
  const deps = { ...f.deps, run: recreating(f, run) };
  const first = new Supervisor(deps);
  first.enqueue("owner", "INBOUND owner");
  const lines = await quiet(async () => {
    for (let i = 1; i <= UNCONFIRMED_LIMIT; i++) {
      const flushed = (i === 1 ? first : new Supervisor(deps)).flush();
      await expect(flushed).rejects.toThrow(i < UNCONFIRMED_LIMIT ? "STARTUP_UNCONFIRMED" : "lead pane kept");
    }
    // the fresh session is refused at the launch guard instead of being typed into that process
    await expect(new Supervisor(deps).flush()).rejects.toThrow("LEAD_PANE_BUSY lead:p1: foreground is not a plain shell (pid 300, pid 301)");
  });
  expect(lines).toContain("LEAD_PANE_KEPT lead:p1: foreground is not a plain shell");
  expect(f.calls.some((call) => call[2] === "close" || call[1] === "tab")).toBe(false);
  expect(launchedSessions(f)).toHaveLength(1);
  const pending = restartSession(f);
  expect(pending.phase).toBe("starting");
  expect(pending.session).not.toBe(launchedSessions(f)[0]);
});

test("an unconfirmed session that did initialise is never killed or relaunched past the limit", async () => {
  const f = fixture();
  f.cold();
  f.setConfirm(false); // e.g. blocked on a dialog: herdr never reports it ready, but omo wrote its holder file
  const supervisor = new Supervisor({ ...f.deps, run: recreating(f, f.deps.run) });
  supervisor.enqueue("blocked", "INBOUND blocked");
  await quiet(async () => {
    for (let i = 1; i <= UNCONFIRMED_LIMIT + 1; i++) await expect(supervisor.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
  });
  const [launched] = launchedSessions(f);
  expect(launchedSessions(f)).toHaveLength(1);
  expect(restartSession(f)).toMatchObject({ session: launched, phase: "submitted", unconfirmed: UNCONFIRMED_LIMIT + 1 });
  expect(f.calls.some((call) => (call[0] === "kill" && call[2] === "201") || call[2] === "close" || call[1] === "tab")).toBe(false);
});

test("a foreground process group other than the shell is not a plain shell", () => {
  expect(plainShell({ shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, argv: ["/usr/bin/zsh"] }] })).toBe(true);
  expect(plainShell({ shell_pid: 10, foreground_process_group_id: 300, foreground_processes: [{ pid: 10, argv: ["/usr/bin/zsh"] }] })).toBe(false);
  expect(plainShell({ foreground_processes: [] })).toBe(false);
});

const CHAIN = ["a/primary", { model: "b/fallback", thinking: "high" }];
const BLOCKED_SCREEN = "Error: All Claude accounts for a are currently blocked\n❯ ";
const allBlocked = JSON.stringify({ status: "not_ready", accounts: [{ name: "default", blocked: true }, { name: "login-2", blocked: true }] });
const oneHealthy = JSON.stringify({ status: "not_ready", accounts: [{ name: "default", blocked: true }, { name: "login-2", blocked: false }] });
const launches = (f: ReturnType<typeof fixture>) => f.calls.filter((call) => call[2] === "run").map((call) => call[4] ?? "");
const journal = (f: ReturnType<typeof fixture>) => readJournal(f.state.dir);
const muted = async (work: () => Promise<void>) => {
  const original = console.log;
  console.log = () => {};
  try { await work(); } finally { console.log = original; }
};

test("an idle lead stalled on quota moves to the next model with the pending events, and one line is announced", async () => {
  const f = fixture({ leadModel: CHAIN, agentCommand: WITH_THINKING });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("discord:1:9", "INBOUND 1 9 owner are you there");
  f.onWait(async () => { f.world.screen = "❯ "; });
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toHaveLength(1);
  expect(launches(f)[0]).toContain("--model b/fallback --thinking high");
  expect(f.prompt()).toContain('"id":"discord:1:9"');
  expect(f.prompt()).toContain("The previous lead stopped: a/primary is blocked on quota");
  expect(f.log().map((event) => event.id)).toEqual(["discord:1:9"]);
  expect(announced).toEqual(["The lead's model a/primary is out of quota, so the lead now runs on b/fallback. It moves back to a/primary once that has quota again."]);
  expect(journal(f)).toMatchObject({ leadModel: 1 });
  expect(f.calls.filter((call) => call[0] === "omo").every((call) => !call.includes("--credentials"))).toBe(true);
});

test("a fresh launch stalled on quota is stopped and relaunched on the next model with the same events", async () => {
  const f = fixture({ leadModel: CHAIN });
  f.cold();
  f.auth.a = allBlocked;
  // The first launch comes up blocked; the fallback launch comes up clean.
  f.onWait(async () => { f.world.screen = launches(f).length === 1 ? BLOCKED_SCREEN : "❯ "; });
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("cold", "INBOUND cold");
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  const [first, second] = launches(f);
  expect(first).toContain("--model a/primary");
  expect(second).toContain("--model b/fallback");
  expect(/--session-id (\S+)/.exec(first ?? "")?.[1]).not.toBe(/--session-id (\S+)/.exec(second ?? "")?.[1]);
  expect(f.prompt()).toContain('"id":"cold"');
  expect(f.log().map((event) => event.id)).toEqual(["cold"]);
  expect(f.calls.filter((call) => call[0] === "kill").map((call) => call[2])).toContain("201");
  expect(announced).toHaveLength(1);
  expect(journal(f)).toMatchObject({ leadModel: 1 });
  expect(journal(f).restart).toBeUndefined();
});

test("on a fallback the first model is retried every leadPrimaryRetryMin and the lead moves back once it has quota on 2 checks", async () => {
  const f = fixture({ leadModel: CHAIN, leadPrimaryRetryMin: 15 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.onWait(async () => { f.world.screen = "❯ "; });
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  f.auth.a = oneHealthy;
  f.clock.at += 5 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  f.clock.at += 11 * 60_000;
  await muted(() => supervisor.flush());
  // One unblocked check is not enough (leadPrimaryReturnChecks 2); the next comes leadPrimaryRetryMin later.
  expect(launches(f)).toHaveLength(1);
  expect(journal(f).primaryClearChecks).toBe(1);
  f.clock.at += 15 * 60_000;
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toHaveLength(2);
  expect(launches(f)[1]).toContain("--model a/primary");
  expect(journal(f).primaryClearChecks).toBeUndefined();
  expect(announced.at(-1)).toBe("a/primary has quota again; the lead is back on it.");
  expect(journal(f).leadModel).toBe(0);
});

test("a blocked subscription never moves the lead to a paid emergency model without the owner's approval; approved, it moves in order and back", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5", "or/anthropic/claude-opus-5.5"], leadPrimaryRetryMin: 15, leadUnreadRestartMin: 600 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.onWait(async () => { f.world.screen = "❯ "; liveSession(f); });
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  // Without approval: no launch, the episode is reported and the approval is asked for, once.
  expect(launches(f)).toEqual([]);
  expect(f.log().filter((event) => event.line.startsWith("LEAD_QUOTA_EXHAUSTED a/primary "))).toHaveLength(1);
  expect(f.log().filter((event) => event.line.startsWith("LEAD_EMERGENCY_APPROVAL og/anthropic/claude-opus-5-5 "))).toHaveLength(1);
  expect(announced).toEqual([
    expect.stringContaining("Every lead model is out of quota (a/primary)"),
    "The lead can run on the paid emergency model og/anthropic/claude-opus-5-5 until a/primary has quota again. It moves only with your approval for this outage: use /emergency here, or run dori lead-emergency approve on the host.",
  ]);
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 still there?");
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
  // Approved: the next check moves the lead to the first emergency model.
  approveEmergency(f.state.dir, f.clock.at);
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:3", "INBOUND 1 3 approved");
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toHaveLength(1);
  expect(launches(f)[0]).toContain("--model og/anthropic/claude-opus-5-5");
  expect(announced.at(-1)).toBe("The Claude subscription is blocked (a/primary is out of quota), so the lead now runs on the paid emergency model og/anthropic/claude-opus-5-5. Lanes never use it. The lead moves back to a/primary once that has quota again.");
  // The first emergency provider fails on its own credit: its screen line alone moves the lead on.
  f.world.screen = "Error: insufficient_quota\n❯ ";
  f.clock.at += 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(2);
  expect(launches(f)[1]).toContain("--model or/anthropic/claude-opus-5.5");
  f.auth.a = oneHealthy;
  f.clock.at += 16 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(2);
  f.clock.at += 15 * 60_000;
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toHaveLength(3);
  expect(launches(f)[2]).toContain("--model a/primary");
  expect(announced.at(-1)).toBe("The Claude subscription has quota again: the lead is back on a/primary, and the paid emergency model or/anthropic/claude-opus-5.5 is off.");
  expect(journal(f).leadModel).toBe(0);
  // Back on the first model, the approval is spent: the next episode asks again.
  expect(emergencyApproved(f.state.dir)).toBe(false);
});

test("a working lead stalled on quota is never force-switched onto an emergency model, even approved", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"], leadQuotaBusySwitchMin: 10, leadStuckRestartMin: 600 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  expect(approveEmergency(f.state.dir, f.clock.at)).toBeDefined();
  f.clock.at += 30 * 60_000;
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 still?");
  await muted(() => supervisor.flush());
  f.clock.at += 30 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
  expect(f.calls.some((call) => call[0] === "kill")).toBe(false);
});

test("an emergency approval holds only for its own quota episode: the next episode asks again instead of moving the lead", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"], leadStuckRestartMin: 600 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  approveEmergency(f.state.dir, f.clock.at);
  // The subscription recovers before the working lead ever moved: the episode, and its approval, end.
  f.world.screen = "❯ ";
  f.auth.a = oneHealthy;
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 back?");
  await muted(() => supervisor.flush());
  expect(f.log().filter((event) => event.line.startsWith("LEAD_QUOTA_CLEARED "))).toHaveLength(1);
  // Later an idle lead is blocked again: a new episode, a new question, no paid model.
  f.clock.at += 60_000;
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.pane.agent_status = "idle";
  supervisor.enqueue("discord:1:3", "INBOUND 1 3 hello again");
  // The fixture cannot complete a cold restart here; a failed one must still show up as a planned move below.
  await muted(() => supervisor.flush()).catch(() => {});
  expect(journal(f).restart?.modelIndex).toBeUndefined();
  expect(launches(f)).toEqual([]);
  expect(f.log().filter((event) => event.line.startsWith("LEAD_EMERGENCY_APPROVAL "))).toHaveLength(2);
});

test("a stale approval file from a closed episode never moves the lead", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"], leadStuckRestartMin: 600 });
  // Written for an episode a day old, e.g. by a CLI approve that raced the supervisor closing that episode.
  await Bun.write(join(f.state.dir, "lead-emergency-approval.json"), JSON.stringify({ at: f.clock.at - 1, episode: f.clock.at - 86_400_000 }));
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush()).catch(() => {});
  expect(journal(f).restart?.modelIndex).toBeUndefined();
  expect(launches(f)).toEqual([]);
  expect(f.log().filter((e) => e.line.startsWith("LEAD_EMERGENCY_APPROVAL "))).toHaveLength(1);
});

test("an approval given with no quota episode open is refused and never moves a later stalled lead", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"] });
  expect(approveEmergency(f.state.dir, f.clock.at)).toBeUndefined();
  expect(emergencyApproved(f.state.dir)).toBe(false);
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
  expect(f.log().filter((event) => event.line.startsWith("LEAD_EMERGENCY_APPROVAL "))).toHaveLength(1);
});

test("an approval while the working lead is still blocked closes no episode: no LEAD_QUOTA_CLEARED, no 'quota again' notice", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"], leadStuckRestartMin: 600 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.pane.agent_status = "working";
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  approveEmergency(f.state.dir, f.clock.at);
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 still there?");
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toEqual([]);
  expect(f.log().some((event) => event.line.startsWith("LEAD_QUOTA_CLEARED "))).toBe(false);
  expect(announced.some((text) => text.startsWith("The lead has quota again"))).toBe(false);
  expect(journal(f).quotaExhausted).toBeDefined();
});

test("an approved lead stays on the paid model after the episode closes, and revoking brings an idle one back to its first model", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"] });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.onWait(async () => { f.world.screen = "❯ "; liveSession(f); });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  approveEmergency(f.state.dir, f.clock.at);
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 go");
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:3", "INBOUND 1 3 working?");
  await muted(() => supervisor.flush());
  expect(journal(f).quotaExhausted).toBeUndefined();
  expect(launches(f)).toHaveLength(1);
  clearEmergencyApproval(f.state.dir);
  f.clock.at += 60_000;
  supervisor.enqueue("discord:1:4", "INBOUND 1 4 stop paying");
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(2);
  expect(launches(f)[1]).toContain("--model a/primary");
});

test("the open episode's approval request is never dropped from the outbox; other lines are after OUTBOX_ATTEMPTS", async () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"] });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  const supervisor = new Supervisor(f.deps, { announce: async () => { throw new Error("discord down"); } });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  for (let i = 0; i <= OUTBOX_ATTEMPTS; i++) {
    f.clock.at += OUTBOX_RETRY_MS;
    await muted(() => supervisor.flush());
    await muted(() => supervisor.reactionsSettled());
  }
  expect((journal(f).outbox ?? []).map((item: { id: string }) => item.id.split(":")[0])).toEqual(["lead-emergency-approval"]);
});

test("a lead restart is never requested onto a paid emergency model", () => {
  const f = fixture({ leadModel: "a/primary", leadEmergencyModels: ["og/anthropic/claude-opus-5-5"] });
  expect(() => requestLeadRestart(f.deps.config, f.clock.now(), "og/anthropic/claude-opus-5-5:max")).toThrow(/emergency/);
  expect(pendingLeadRestart(f.state.dir)).toBeUndefined();
});

test("one blocked account next to a healthy one, a briefly busy lead, or a single lead model never switches", async () => {
  const healthy = fixture({ leadModel: CHAIN });
  healthy.world.screen = BLOCKED_SCREEN;
  healthy.auth.a = oneHealthy;
  const s1 = new Supervisor(healthy.deps);
  s1.enqueue("discord:1:1", "INBOUND warm");
  await s1.flush();
  expect(launches(healthy)).toEqual([]);
  expect(healthy.log().map((event) => event.id)).toEqual(["discord:1:1"]);

  const busy = fixture({ leadModel: CHAIN });
  busy.world.screen = BLOCKED_SCREEN;
  busy.auth.a = allBlocked;
  busy.pane.agent_status = "working";
  const s2 = new Supervisor(busy.deps);
  s2.enqueue("discord:1:2", "INBOUND busy");
  await s2.flush();
  expect(launches(busy)).toEqual([]);
  expect(busy.calls.some((call) => call[0] === "kill")).toBe(false);

  const single = fixture({ leadModel: "a/primary" });
  single.world.screen = BLOCKED_SCREEN;
  single.auth.a = allBlocked;
  const s3 = new Supervisor(single.deps);
  s3.enqueue("discord:1:3", "INBOUND single");
  await muted(() => s3.flush());
  // Nothing to switch to: the episode is reported instead (test/lead-quota-control.test.ts).
  expect(launches(single)).toEqual([]);
  expect(single.log().some((event) => event.line.startsWith("LEAD_QUOTA_EXHAUSTED a/primary "))).toBe(true);
});

test("LANE_QUOTA_STALL is urgent", () => {
  expect(eventPriority("LANE_QUOTA_STALL lane w:p1 2/2 anthropic-subscription accounts blocked: Usage limit reached")).toBe("urgent");
});

const inbox = (f: ReturnType<typeof fixture>): string[] =>
  readJournal(f.state.dir).events.map((e: { line: string }) => e.line);
const ackMissing = (f: ReturnType<typeof fixture>): string[] => inbox(f).filter((line) => line.startsWith("ACK_MISSING "));

test("an owner message handed to the lead and not acked gets one urgent ACK_MISSING after the window", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  supervisor.enqueue("discord:11:23", "VISITOR 11 23 Guest (not the owner) hi");
  await supervisor.flush();
  f.clock.at += 59_999;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  expect(ackMissing(f)).toEqual([]);
  f.clock.at += 1;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  expect(ackMissing(f)).toHaveLength(1);
  expect(ackMissing(f)[0]?.split(" ").slice(0, 3)).toEqual(["ACK_MISSING", "11", "22"]);
  expect(ackMissing(f)[0]).toContain("INBOUND 11 22 owner hello");
  expect(eventPriority(ackMissing(f)[0] ?? "")).toBe("urgent");
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toHaveLength(1);
  await supervisor.flush();
  expect(f.log().map((e) => e.line).filter((line) => line.startsWith("ACK_MISSING"))).toHaveLength(1);
});

test("still unacked after a second window: one notice per message, kept across a supervisor restart", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  await supervisor.flush();
  f.clock.at += 60_000;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  f.clock.at += 59_999;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  f.clock.at += 1;
  expect(supervisor.ackTick(60_000)).toEqual([{ channel: "11", message: "22" }]);
  supervisor.noticeSent("ack", "11", "22");
  expect(supervisor.ackTick(60_000)).toEqual([]);
  f.clock.at += 600_000;
  expect(new Supervisor(f.deps).ackTick(60_000)).toEqual([]);
  expect(ackMissing(f)).toHaveLength(1);
});

test("dori ack clears the message: no reminder, no notice, and the ack file is consumed", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  await supervisor.flush();
  f.clock.at += 30_000;
  recordAck(f.state.dir, "11", "22", f.clock.now());
  expect(supervisor.ackTick(60_000)).toEqual([]);
  expect(pendingAcks(f.state.dir)).toEqual([]);
  f.clock.at += 600_000;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  expect(ackMissing(f)).toEqual([]);
});

test("an ack file for a message nobody waits for is kept for a day, then dropped", () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  recordAck(f.state.dir, "11", "99", f.clock.now());
  const [file] = pendingAcks(f.state.dir);
  supervisor.ackTick(60_000);
  expect(pendingAcks(f.state.dir)).toHaveLength(1);
  f.clock.at = (file?.at ?? 0) + ACK_KEEP_MS;
  supervisor.ackTick(60_000);
  expect(pendingAcks(f.state.dir)).toEqual([]);
});

test("a cold-start batch starts its ack window when the lead is ready, not while it boots", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  const during: unknown[] = [];
  f.onWait(async () => {
    f.onWait(async () => {});
    // A slow boot: ten minutes pass before the new lead reports ready, and the supervisor keeps ticking meanwhile.
    f.clock.at += 600_000;
    during.push(...supervisor.ackTick(60_000));
  });
  await supervisor.flush();
  expect(restartSession(f)).toBeUndefined();
  expect(during).toEqual([]);
  expect(ackMissing(f)).toEqual([]);
  f.clock.at += 59_999;
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toEqual([]);
  f.clock.at += 1;
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toHaveLength(1);
});

test("a cold restart gives a message the old lead never acked a fresh window, and a posted notice is not repeated", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  await supervisor.flush();
  f.clock.at += 60_000;
  supervisor.ackTick(60_000);
  f.clock.at += 60_000;
  expect(supervisor.ackTick(60_000)).toEqual([{ channel: "11", message: "22" }]);
  supervisor.noticeSent("ack", "11", "22");
  // The old lead goes cold and the next urgent event restarts it.
  f.cold();
  supervisor.enqueue("discord:11:30", "INBOUND 11 30 owner again");
  await supervisor.flush();
  expect(restartSession(f)).toBeUndefined();
  expect(ackMissing(f)).toHaveLength(1);
  f.clock.at += 60_000;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  // Both overdue messages share one coalesced reminder.
  expect(ackMissing(f)).toHaveLength(2);
  expect(ackMissing(f)[1]).toStartWith("ACK_MISSING 11 22 ");
  expect(ackMissing(f)[1]).toContain(" | 11 30 INBOUND 11 30 owner again");
  f.clock.at += 60_000;
  expect(supervisor.ackTick(60_000)).toEqual([{ channel: "11", message: "30" }]);
});

test.each([false, true])("a restart replays delivered owner work with acked=%s until handled", async (acked) => {
  // Given a delivered owner request, optionally read but not covered.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner project-alpha");
  await supervisor.flush();
  if (acked) {
    recordAck(f.state.dir, "11", "22", f.clock.now());
    supervisor.ackTick(60_000);
  }
  // When an unrelated event causes a cold restart.
  f.cold();
  supervisor.enqueue("restart-trigger", "WAIT_DONE release");
  await supervisor.flush();
  // Then the cold prompt includes the original request, without appending it twice.
  const events = f.prompt()?.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  expect(events?.some((event) => event.id === "discord:11:22")).toBe(true);
  expect(f.log().filter((event) => event.id === "discord:11:22")).toHaveLength(1);
});

test("handled owner work is excluded from a fresh lead handoff", async () => {
  // Given a covered reply still waiting in the receipt spool.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner project-alpha");
  await supervisor.flush();
  recordHandled(f.state.dir, "11", "22", f.clock.now(), { reply: true });
  // When a restart begins, it consumes receipts before selecting unfinished work.
  f.cold();
  supervisor.enqueue("restart-trigger", "WAIT_DONE release");
  await supervisor.flush();
  // Then the old request is not replayed.
  const events = f.prompt()?.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  expect(events?.some((event) => event.id === "discord:11:22")).toBe(false);
});

test("acked but unhandled work wakes the lead with its body and escalates once after another window", async () => {
  // Given an owner request with a persisted read receipt.
  const f = fixture();
  let supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner project-alpha");
  await supervisor.flush();
  recordAck(f.state.dir, "11", "22", f.clock.now());
  supervisor.ackTick(60_000);
  supervisor = new Supervisor(f.deps);
  f.clock.at += 30 * 60_000;
  // When the handling deadline expires.
  expect(supervisor.handledTick()).toEqual([]);
  // Then an urgent reminder retains the request and a second full window precedes escalation.
  const reminders = inbox(f).filter((line) => line.startsWith("UNHANDLED "));
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toContain("INBOUND 11 22 owner project-alpha");
  expect(eventPriority(reminders[0] ?? "")).toBe("urgent");
  f.clock.at += 30 * 60_000 - 1;
  expect(supervisor.handledTick()).toEqual([]);
  f.clock.at++;
  expect(supervisor.handledTick()).toEqual([{ channel: "11", message: "22" }]);
  supervisor.noticeSent("unhandled", "11", "22");
  expect(new Supervisor(f.deps).handledTick()).toEqual([]);
});

test("two declared tasks require distinct links and survive receipt replay and supervisor restart", async () => {
  // Given two projects in one message and one linked lane, repeated twice.
  const f = fixture();
  let supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner project-alpha project-beta");
  await supervisor.flush();
  recordAck(f.state.dir, "11", "22", f.clock.now(), 2);
  recordHandled(f.state.dir, "11", "22", f.clock.now(), { lanes: ["alpha"] });
  recordHandled(f.state.dir, "11", "22", f.clock.now(), { lanes: ["alpha"] });
  supervisor.ackTick(60_000);
  supervisor = new Supervisor(f.deps);
  f.clock.at += 30 * 60_000;
  supervisor.handledTick();
  expect(inbox(f).filter((line) => line.startsWith("UNHANDLED "))[0]).toContain("coverage=1/2");
  // When a second distinct task gets a reply.
  recordHandled(f.state.dir, "11", "22", f.clock.now(), { reply: true });
  supervisor.handledTick();
  // Then all declared work is durably covered and no owner escalation remains.
  const journal = readJournal(f.state.dir);
  expect(journal.awaitingAck[0]).toMatchObject({ tasks: 2, lanes: ["alpha"], reply: true, handledAt: f.clock.now() });
  f.clock.at += 30 * 60_000;
  expect(new Supervisor(f.deps).handledTick()).toEqual([]);
});

test("a failed ack notice retries after restart and only successful sending marks it sent", async () => {
  // Given a request still unacked after both windows.
  const f = fixture();
  let supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  await supervisor.flush();
  f.clock.at += 60_000;
  supervisor.ackTick(60_000);
  f.clock.at += 60_000;
  let attempts = 0;
  const send = async () => { if (++attempts === 1) throw new Error("network unavailable"); };
  const notify = async () => {
    for (const { channel, message } of supervisor.ackTick(60_000)) {
      await send();
      supervisor.noticeSent("ack", channel, message);
    }
  };
  // When sending fails, then succeeds on the next supervisor tick.
  await expect(notify()).rejects.toThrow("network unavailable");
  supervisor = new Supervisor(f.deps);
  await notify();
  // Then the successful receipt persists and suppresses future sends.
  expect(attempts).toBe(2);
  expect(new Supervisor(f.deps).ackTick(60_000)).toEqual([]);
});

test("busy lead time does not count against acknowledgment and begins when idle", async () => {
  // Given an event log available to a lead that is still working.
  const f = fixture();
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner hello");
  await supervisor.flush();
  f.clock.at += 10 * 60_000;
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toEqual([]);
  // When the lead becomes idle, even without any new events.
  f.pane.agent_status = "idle";
  await supervisor.flush();
  // Then the read deadline starts now, rather than at journal append.
  f.clock.at += 59_999;
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toEqual([]);
  f.clock.at++;
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toHaveLength(1);
});

test("a busy lead dying before its read window starts replays the message without new traffic", async () => {
  // Given a message journaled while the lead was busy.
  const f = fixture();
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha");
  await supervisor.flush();
  // When that lead disappears before ever becoming readable.
  f.noAgent();
  await supervisor.flush();
  // Then a new lead receives the request and its acknowledgment deadline starts.
  const events = f.prompt()?.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  expect(events?.some((event) => event.id === "discord:11:22")).toBe(true);
  f.clock.at += 60_000;
  supervisor.ackTick(60_000);
  expect(ackMissing(f)).toHaveLength(1);
});

test("missing-ack bodies and owner reports are redacted before durable journal and log writes", async () => {
  // Given secrets in inbound and lane-report event payloads.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  const secret = "ghp_1234567890123456789012345";
  supervisor.enqueue("discord:11:22", `INBOUND 11 22 owner ${secret} ${"x".repeat(4_000)}`);
  supervisor.enqueue("report:alpha", `LANE_REPORT alpha password=hunter2\n${secret}`);
  // When delivery and the missing-ack timer run.
  await supervisor.flush();
  f.clock.at += 60_000;
  supervisor.ackTick(60_000);
  // Then neither durable surface leaks secrets and the reminder body is bounded.
  for (const text of [journalBytes(f.state.dir), readFileSync(join(f.state.dir, "lead-events.log"), "utf8")]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[REDACTED]");
  }
  expect(ackMissing(f)[0]?.length).toBeLessThanOrEqual(2_020);
});


// Lead quota control: exhaustion, busy switch, return hysteresis, stuck lead.
const onModel = (f: ReturnType<typeof fixture>, journalExtra: Record<string, unknown>) =>
  writeJournal(f.state.dir, ({ events: [], ...journalExtra }));
const blockedUntil = (at: number) => JSON.stringify({ status: "not_ready", accounts: [{ name: "default", blocked: true, resetAt: at }] });

test("a single lead model blocked on quota: the owner is told once with the reset, LEAD_QUOTA_EXHAUSTED queued, and its end told once", async () => {
  const f = fixture({ leadModel: "a/primary" });
  f.world.screen = BLOCKED_SCREEN;
  const reset = Date.parse("2027-01-15T12:00:00.000Z");
  f.auth.a = blockedUntil(reset);
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 still there?");
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toEqual([]);
  const exhausted = f.log().filter((event) => event.line.startsWith("LEAD_QUOTA_EXHAUSTED "));
  expect(exhausted).toHaveLength(1);
  expect(exhausted[0].line).toStartWith("LEAD_QUOTA_EXHAUSTED a/primary reset=2027-01-15T12:00:00.000Z every lead model is blocked on quota (a/primary): ");
  expect(announced).toEqual(["Every lead model is out of quota (a/primary), so the lead cannot answer until one resets (earliest known reset 01-15 21:00 KST). Your messages stay queued."]);
  expect(journal(f).quotaExhausted).toMatchObject({ model: "a/primary", resetAt: reset });
  // A supervisor restart inside the same episode does not tell the owner again.
  const again = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  again.enqueue("discord:1:3", "INBOUND 1 3 third");
  await muted(() => again.flush());
  expect(announced).toHaveLength(1);
  f.auth.a = oneHealthy;
  again.enqueue("discord:1:4", "INBOUND 1 4 fourth");
  await muted(() => again.flush());
  await again.reactionsSettled();
  expect(announced.at(-1)).toBe("The lead has quota again (a/primary); queued messages are being answered.");
  expect(f.log().filter((event) => event.line.startsWith("LEAD_QUOTA_CLEARED a/primary "))).toHaveLength(1);
  expect(journal(f).quotaExhausted).toBeUndefined();
});

test("every model of the chain blocked: the earliest reset across the chain is reported", async () => {
  const f = fixture({ leadModel: CHAIN });
  onModel(f, { leadModel: 1, primaryRetryAt: f.clock.at + 15 * 60_000 });
  f.world.screen = "Error: All accounts for b are currently blocked\n❯ ";
  f.auth.a = blockedUntil(Date.parse("2027-01-15T12:00:00.000Z"));
  f.auth.b = blockedUntil(Date.parse("2027-01-15T09:30:00.000Z"));
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toEqual([]);
  expect(f.log().find((event) => event.line.startsWith("LEAD_QUOTA_EXHAUSTED "))?.line).toStartWith("LEAD_QUOTA_EXHAUSTED b/fallback reset=2027-01-15T09:30:00.000Z every lead model is blocked on quota (a/primary, b/fallback)");
  expect(announced).toEqual([expect.stringContaining("(earliest known reset 01-15 18:30 KST)")]);
});

test("a working lead stalled on quota is switched once the stall outlives leadQuotaBusySwitchMin", async () => {
  const f = fixture({ leadModel: CHAIN, leadQuotaBusySwitchMin: 10 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.pane.agent_status = "working";
  f.onWait(async () => { f.world.screen = "❯ "; });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  f.clock.at += 9 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
  expect(f.calls.some((call) => call[0] === "kill")).toBe(false);
  f.clock.at += 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  expect(launches(f)[0]).toContain("--model b/fallback");
  expect(f.prompt()).toContain("a/primary is blocked on quota");
  expect(f.prompt()).toContain("while working for 10 min");
  expect(f.prompt()).toContain('"id":"discord:1:1"');
  expect(journal(f)).toMatchObject({ leadModel: 1 });
});

test("a working lead whose stall clears in between restarts the busy clock", async () => {
  const f = fixture({ leadModel: CHAIN, leadQuotaBusySwitchMin: 10 });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => supervisor.flush());
  f.clock.at += 6 * 60_000;
  f.world.screen = "❯ working";
  await muted(() => supervisor.flush());
  f.world.screen = BLOCKED_SCREEN;
  f.clock.at += 6 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
});

test("returning to the primary needs leadPrimaryReturnChecks unblocked checks in a row; blocked or unreadable restarts the count", async () => {
  const f = fixture({ leadModel: CHAIN, leadPrimaryRetryMin: 15, leadPrimaryReturnChecks: 2 });
  onModel(f, { leadModel: 1, primaryRetryAt: f.clock.at });
  f.onWait(async () => { f.world.screen = "❯ "; });
  const supervisor = new Supervisor(f.deps);
  const step = async (auth: string) => { f.auth.a = auth; await muted(() => supervisor.flush()); f.clock.at += 15 * 60_000; };
  await step(oneHealthy);
  expect(journal(f).primaryClearChecks).toBe(1);
  await step(allBlocked);
  expect(journal(f).primaryClearChecks).toBeUndefined();
  await step(oneHealthy);
  await step("not json");
  expect(journal(f).primaryClearChecks).toBeUndefined();
  await step(oneHealthy);
  expect(launches(f)).toEqual([]);
  await step(oneHealthy);
  expect(launches(f)).toHaveLength(1);
  expect(launches(f)[0]).toContain("--model a/primary");
  expect(journal(f)).toMatchObject({ leadModel: 0 });
});

test("a lead stuck blocked with owner messages unread is cold-restarted with them after leadStuckRestartMin, and the owner is told", async () => {
  const f = fixture({ leadStuckRestartMin: 30 });
  f.pane.agent_status = "blocked";
  const announced: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { announced.push(text); } });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 please answer");
  await muted(() => supervisor.flush());
  expect(f.log().map((event) => event.id)).toEqual(["discord:1:1"]);
  f.clock.at += 29 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
  f.clock.at += 60_000;
  await muted(() => supervisor.flush());
  await supervisor.reactionsSettled();
  expect(launches(f)).toHaveLength(1);
  expect(f.calls.some((call) => call[0] === "kill" && call[2] === "101")).toBe(true);
  expect(f.prompt()).toContain("it was stuck blocked for 30 min with 1 owner message(s) unread");
  expect(f.prompt()).toContain('"id":"discord:1:1"');
  expect(announced).toEqual(["The lead has been stuck (blocked) for 30 min without reading your messages, so it is being restarted; your unanswered messages go to the new lead."]);
  expect(journal(f).restart).toBeUndefined();
});

test("a busy lead is not restarted when it acked the message or became idle in between", async () => {
  const acked = fixture({ leadStuckRestartMin: 30 });
  acked.pane.agent_status = "working";
  const s1 = new Supervisor(acked.deps);
  s1.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await muted(() => s1.flush());
  recordAck(acked.state.dir, "1", "1", acked.clock.at);
  s1.ackTick(60_000);
  acked.clock.at += 31 * 60_000;
  await muted(() => s1.flush());
  expect(launches(acked)).toEqual([]);

  const idle = fixture({ leadStuckRestartMin: 30 });
  idle.pane.agent_status = "working";
  const s2 = new Supervisor(idle.deps);
  s2.enqueue("discord:1:2", "INBOUND 1 2 hi");
  await muted(() => s2.flush());
  idle.clock.at += 20 * 60_000;
  idle.pane.agent_status = "idle";
  // Idle makes the message readable: the lead had its chance, so it is not stuck.
  await muted(() => s2.flush());
  idle.pane.agent_status = "working";
  idle.clock.at += 20 * 60_000;
  await muted(() => s2.flush());
  expect(launches(idle)).toEqual([]);
});

/** The lead's session ends in an assistant tool call started at `at`, answered or still open. */
const inToolCall = (f: ReturnType<typeof fixture>, at: number, answered = false): void => {
  const entry = (message: object, when: number) => JSON.stringify({ type: "message", timestamp: new Date(when).toISOString(), message });
  writeFileSync(f.file, [
    entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "waiting for CI" }, { type: "toolCall", id: "call_1", name: "eval" }] }, at),
    ...(answered ? [entry({ role: "toolResult", toolCallId: "call_1", content: [] }, at + 1_000)] : []),
  ].join("\n") + "\n");
};
const typed = (f: ReturnType<typeof fixture>): string[] => f.calls.filter((call) => call[0] === "herdr" && call[2] === "send-text").map((call) => call[4] ?? "");
// The footer omo showed on a lead the owner stopped with Esc during `gh pr checks --watch` (2026-10-23).
const PAUSED_SCREEN = "❯ \n(😺 OmO Native by Q Kim) ◉ watching lead events (5m) Paused · 4 updates held · type to continue, /resume to resume";

test("a working lead held inside one tool call (a foreground watch) with an owner message unacked is restarted after leadUnreadRestartMin, though its screen moves", async () => {
  const f = fixture({ leadUnreadRestartMin: 5 });
  f.pane.agent_status = "working";
  inToolCall(f, f.clock.now());
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 please answer");
  for (let i = 0; i < 5; i++) {
    f.world.screen = `test (json) pending ${"x".repeat(i)}`;
    await muted(() => supervisor.flush());
    f.clock.at += 60_000;
  }
  expect(launches(f)).toEqual([]);
  f.world.screen = "test (json) pass";
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  expect(f.calls.some((call) => call[0] === "kill" && call[2] === "101")).toBe(true);
  expect(f.prompt()).toContain("it was stuck in one tool call for 5 min with 1 owner message(s) unread");
  expect(f.prompt()).toContain('"id":"discord:1:1"');
});

test("a working lead between tool calls, or one whose call started after it acked, is left alone", async () => {
  const answered = fixture({ leadUnreadRestartMin: 5 });
  answered.pane.agent_status = "working";
  inToolCall(answered, answered.clock.now(), true);
  const s1 = new Supervisor(answered.deps);
  s1.enqueue("discord:1:1", "INBOUND 1 1 hi");
  for (let i = 0; i < 10; i++) {
    answered.world.screen = `step ${i}`;
    await muted(() => s1.flush());
    answered.clock.at += 60_000;
  }
  expect(launches(answered)).toEqual([]);

  const acked = fixture({ leadUnreadRestartMin: 5 });
  acked.pane.agent_status = "working";
  const s2 = new Supervisor(acked.deps);
  s2.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await muted(() => s2.flush());
  recordAck(acked.state.dir, "1", "1", acked.clock.at);
  s2.ackTick(60_000);
  inToolCall(acked, acked.clock.now());
  acked.clock.at += 10 * 60_000;
  await muted(() => s2.flush());
  expect(launches(acked)).toEqual([]);
});

test("an idle lead paused by Esc gets /resume typed once after the ack window; still unacked after leadUnreadRestartMin it is restarted", async () => {
  const f = fixture({ leadUnreadRestartMin: 5, ackTimeoutSec: 60 });
  f.world.screen = PAUSED_SCREEN;
  // herdr reports an Esc-paused omo as done.
  f.pane.agent_status = "done";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await muted(() => supervisor.flush());
  expect(f.log().map((event) => event.id)).toEqual(["discord:1:1"]);
  expect(typed(f)).toEqual([]);
  f.clock.at += 60_000;
  await muted(() => supervisor.flush());
  expect(typed(f)).toEqual(["/resume"]);
  await muted(() => supervisor.flush());
  expect(typed(f)).toEqual(["/resume"]);
  expect(launches(f)).toEqual([]);
  f.clock.at += 4 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  expect(f.prompt()).toContain("it was stuck idle for 5 min with 1 owner message(s) unread");
  expect(f.prompt()).toContain('"id":"discord:1:1"');
});

test("a paused lead with the owner's text in its input is not typed into, and a lead that is not paused is not resumed", async () => {
  for (const screen of [PAUSED_SCREEN.replace("❯ ", "❯ half a sentence"), "❯ \n(😺 OmO Native by Q Kim) ◉ watching lead events (5m)"]) {
    const f = fixture({ leadUnreadRestartMin: 5, ackTimeoutSec: 60 });
    f.world.screen = screen;
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
    await muted(() => supervisor.flush());
    f.clock.at += 2 * 60_000;
    await muted(() => supervisor.flush());
    expect(typed(f)).toEqual([]);
    expect(launches(f)).toEqual([]);
  }
});

test("safety-work events reach an idle lead at once, without waiting for the digest delay", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  const lines = [
    "INBOUND_EDIT 1 9 owner edited: new text",
    "INBOUND_DELETE 1 9",
    "WAIT_FAILED release ci green (30 checks in a row failed; no --timeout set)",
    "WAITS_CORRUPT waits.json did not parse and was moved to /x; every wait in it is dropped, register them again",
    "LANE_QUOTA_CLEARED k w:p1 0/2 a accounts blocked; auto-resumed",
    "LANE_RECOVERY_EXHAUSTED k w:p1 dead after 3 recovery attempts",
    "LEAD_QUOTA_EXHAUSTED a/x reset=unknown every lead model is blocked on quota (a/x): hit",
    "QUOTA_GATE_UNKNOWN Claude usage unreadable (offline); the Claude quota gate is off (fail-open)",
  ];
  for (const [i, line] of lines.entries()) {
    supervisor.enqueue(`urgent:${i}`, line);
    await supervisor.flush();
    expect(f.log().map((event) => event.id)).toContain(`urgent:${i}`);
  }
  // Control: a digest line alone still waits.
  supervisor.enqueue("digest", "NUDGED lane silent");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).not.toContain("digest");
});

// PR #61 review fixes: owner revisions, held launches, primary return, durable clocks and announcements.
/** The newest launched session gets a fresh session file, so later deliveries reach it warm. */
const liveSession = (f: ReturnType<typeof fixture>): void => {
  const id = /--session-id (\S+)/.exec(launches(f).at(-1) ?? "")?.[1];
  if (!id) return;
  const file = join(dirname(f.file), `2027-01-15T08-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, "{}\n");
  utimesSync(file, f.clock.now() / 1000, f.clock.now() / 1000);
};
type Tracked = { id: string; since?: number; handledAt?: number; revision?: string; revisions?: string[]; deleted?: true };
const tracked = (f: ReturnType<typeof fixture>, id: string): Tracked | undefined =>
  (journal(f).awaitingAck as Tracked[] | undefined)?.find((entry) => entry.id === id);

test("a cold handoff always carries the held launch queue, even after LAUNCH_READY lowered the flag", async () => {
  const f = fixture();
  f.cold();
  enqueueLaunch(f.state.dir, { key: "held-lane", title: "held", done: "merged acme/app#1", brief: "/b.md", queuedAt: "2027-01-15T08:00:00.000Z", reasons: ["memory"] });
  clearLaunchHold(f.state.dir);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 owner hi");
  await supervisor.flush();
  expect(f.prompt()).toContain("LAUNCH_QUEUE held launches are still waiting");
  expect(f.prompt()).toContain("held-lane");
});

test("an edited owner message is reminded and handed to a new lead in its latest text; a deleted one never is", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 owner original task");
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 owner doomed task");
  await supervisor.flush();
  supervisor.enqueue("discord:1:1:edit:2027-01-15T08:01:00.000Z", "INBOUND_EDIT 1 1 owner (edited) revised task");
  supervisor.enqueue("discord:1:2:delete", "INBOUND_DELETE 1 2 (deleted)");
  await supervisor.flush();
  f.clock.at += 60_000;
  supervisor.ackTick(60_000);
  const missing = inbox(f).filter((line) => line.startsWith("ACK_MISSING "));
  expect(missing).toEqual([expect.stringContaining("revised task")]);
  expect(tracked(f, "discord:1:2")).toMatchObject({ deleted: true });
  // Replaying the inbox at startup changes nothing.
  const before = journal(f).awaitingAck;
  const restarted = new Supervisor(f.deps);
  expect(journal(f).awaitingAck).toEqual(before);
  f.cold();
  restarted.enqueue("cold", "INBOUND cold");
  await restarted.flush();
  expect(f.prompt()).toContain("revised task");
  expect(f.prompt()).not.toContain("original task");
  expect(f.prompt()).not.toContain("doomed task");
});

test("an edit of a message already handled is tracked again as a new instruction", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 owner do x");
  await supervisor.flush();
  recordHandled(f.state.dir, "1", "1", f.clock.at, { reply: true });
  supervisor.ackTick(60_000);
  expect(tracked(f, "discord:1:1")?.handledAt).toBeDefined();
  supervisor.enqueue("discord:1:1:edit:2027-01-15T08:01:00.000Z", "INBOUND_EDIT 1 1 owner (edited) do y instead");
  expect(tracked(f, "discord:1:1")).toEqual({ id: "discord:1:1", revision: "discord:1:1:edit:2027-01-15T08:01:00.000Z", revisions: ["discord:1:1:edit:2027-01-15T08:01:00.000Z"] });
});

test("a lead stalled while working on its last fallback goes back to the first model once that has quota", async () => {
  const f = fixture({ leadModel: CHAIN, leadPrimaryRetryMin: 15, leadPrimaryReturnChecks: 1 });
  onModel(f, { leadModel: 1, primaryRetryAt: f.clock.at });
  f.world.screen = "Error: All accounts for b are currently blocked\n❯ ";
  f.auth.a = oneHealthy;
  f.auth.b = allBlocked;
  f.pane.agent_status = "working";
  f.onWait(async () => { f.world.screen = "❯ "; liveSession(f); });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  expect(launches(f)[0]).toContain("--model a/primary");
  expect(journal(f)).toMatchObject({ leadModel: 0 });
});

test("a cold start that comes up blocked on its last model counts as started instead of looping on STARTUP_UNCONFIRMED", async () => {
  const f = fixture({ leadModel: "a/primary" });
  f.cold();
  f.auth.a = allBlocked;
  f.onWait(async () => { f.world.screen = "Error: usage limit reached\n❯ "; liveSession(f); });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await muted(() => supervisor.flush());
  expect(journal(f).restart).toBeUndefined();
  expect(f.log().some((event) => event.line.startsWith("LEAD_QUOTA_EXHAUSTED a/primary "))).toBe(true);
});

test("a working lead whose screen keeps changing is not restarted as stuck; one frozen for the limit is", async () => {
  const f = fixture({ leadStuckRestartMin: 30 });
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 please answer");
  for (let i = 0; i < 4; i++) {
    f.world.screen = `building step ${"x".repeat(i)}`;
    await muted(() => supervisor.flush());
    f.clock.at += 10 * 60_000;
  }
  expect(launches(f)).toEqual([]);
  await muted(() => supervisor.flush());
  f.clock.at += 30 * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  expect(f.prompt()).toContain("it was stuck working for");
});

test("the stuck clock and the busy-switch clock survive supervisor restarts", async () => {
  const stuck = fixture({ leadStuckRestartMin: 30 });
  stuck.pane.agent_status = "blocked";
  const first = new Supervisor(stuck.deps);
  first.enqueue("discord:1:1", "INBOUND 1 1 please answer");
  await muted(() => first.flush());
  for (let i = 0; i < 3; i++) {
    stuck.clock.at += 12 * 60_000;
    await muted(() => new Supervisor(stuck.deps).flush());
  }
  expect(launches(stuck)).toHaveLength(1);

  const busy = fixture({ leadModel: CHAIN, leadQuotaBusySwitchMin: 10 });
  busy.world.screen = BLOCKED_SCREEN;
  busy.auth.a = allBlocked;
  busy.pane.agent_status = "working";
  busy.onWait(async () => { busy.world.screen = "❯ "; });
  const s = new Supervisor(busy.deps);
  s.enqueue("discord:1:1", "INBOUND 1 1 hello");
  await muted(() => s.flush());
  for (let i = 0; i < 3; i++) {
    busy.clock.at += 4 * 60_000;
    const again = new Supervisor(busy.deps);
    again.enqueue(`discord:1:${i + 2}`, `INBOUND 1 ${i + 2} again`);
    await muted(() => again.flush());
  }
  expect(launches(busy)).toHaveLength(1);
  expect(launches(busy)[0]).toContain("--model b/fallback");
});

test("a message that arrives while a cold start boots gets its read window only once it is delivered", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 first");
  f.onWait(async () => {
    f.onWait(async () => {});
    supervisor.enqueue("discord:1:2", "INBOUND 1 2 during startup");
    f.pane.agent_status = "working";
  });
  await supervisor.flush();
  expect(tracked(f, "discord:1:1")?.since).toBeDefined();
  expect(tracked(f, "discord:1:2")?.since).toBeUndefined();
});

test("owner messages handled a day ago leave the tracking list for good", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await supervisor.flush();
  recordHandled(f.state.dir, "1", "1", f.clock.at, { reply: true });
  supervisor.ackTick(60_000);
  f.clock.at += ACK_KEEP_MS;
  supervisor.ackTick(60_000);
  expect(journal(f).awaitingAck).toEqual([]);
  expect(journal(f).closedOwners).toEqual(["discord:1:1"]);
  new Supervisor(f.deps);
  expect(journal(f).awaitingAck).toEqual([]);
});

test("an owner announcement that fails to post is kept and posted by the next supervisor", async () => {
  const f = fixture({ leadModel: "a/primary" });
  f.world.screen = BLOCKED_SCREEN;
  f.auth.a = allBlocked;
  const failing = new Supervisor(f.deps, { announce: async () => { throw new Error("discord down"); } });
  failing.enqueue("discord:1:1", "INBOUND 1 1 hi");
  const error = console.error;
  console.error = () => {};
  try {
    await muted(() => failing.flush());
    await failing.reactionsSettled();
  } finally { console.error = error; }
  expect(journal(f).outbox).toHaveLength(1);
  f.clock.at += 60_000;
  const posted: string[] = [];
  const next = new Supervisor(f.deps, { announce: async (text) => { posted.push(text); } });
  await next.reactionsSettled();
  expect(posted).toEqual([expect.stringContaining("Every lead model is out of quota (a/primary)")]);
  expect(journal(f).outbox).toEqual([]);
});

// Phase 0.3: owner tracking from rows. Each case runs on the json store and on the sqlite store after dori store import.
const DAY_MS = 24 * 60 * 60_000;
type StoreName = "json" | "sqlite";
/** Writes a json journal and its delivery log as an older supervisor left them, then imports it for the sqlite store. */
const seedState = (dir: string, store: StoreName, journal: { events: { id: string; line: string; at?: number }[] } & Record<string, unknown>): void => {
  writeFileSync(join(dir, JOURNAL_FILE), JSON.stringify(journal));
  writeFileSync(join(dir, "lead-events.log"), journal.events.map(({ id, line }) => `${JSON.stringify({ id, line })}\n`).join(""));
  if (store === "sqlite") importStore(dir, 1_800_000_000_000);
};
const stored = (dir: string, store: StoreName): { events: { id: string; line: string }[]; awaitingAck?: (Tracked & Record<string, unknown>)[] } => {
  if (store === "json") return JSON.parse(readFileSync(join(dir, JOURNAL_FILE), "utf8"));
  const db = new SqliteStore(join(dir, SQLITE_FILE));
  try { return db.read(false) as never; } finally { db.close(); }
};
const lines = (dir: string, store: StoreName, prefix: string): string[] =>
  stored(dir, store).events.map((event) => event.line).filter((line) => line.startsWith(prefix));

test.each(["json", "sqlite"] as const)("an ack-flood journal on the %s store: no per-message ACK_MISSING, one quarantine digest, nothing handed over", async (store) => {
  // Given a supervisor.json.bak-ackflood-like state: 300 owner messages delivered days ago and tracking reset to nothing,
  // one of them edited, one deleted and one already tombstoned (synthetic text only).
  const f = fixture({ store });
  const old = f.clock.now() - 3 * DAY_MS;
  const events: { id: string; line: string; at?: number }[] = [];
  for (let i = 0; i < 300; i++) events.push({ id: `discord:11:${1000 + i}`, line: `INBOUND 11 ${1000 + i} synthetic flood message ${i}`, ...(i % 2 ? { at: old } : {}) });
  events.push({ id: "discord:11:1001:edit:2027-01-01T00:00:00.000Z", line: "INBOUND_EDIT 11 1001 synthetic flood message (edited)", at: old });
  events.push({ id: "discord:11:1002:delete", line: "INBOUND_DELETE 11 1002 (deleted)", at: old });
  seedState(f.state.dir, store, { events, awaitingAck: [], closedOwners: ["discord:11:1003"] });
  // When the supervisor starts, delivers, passes several ack windows, cold-restarts the lead with a new request, and restarts itself.
  const supervisor = new Supervisor(f.deps);
  await supervisor.flush();
  f.clock.at += 300_000;
  supervisor.ackTick(60_000);
  expect(supervisor.ackTick(60_000)).toEqual([]);
  expect(supervisor.overdueOwnerMessages(60_000)).toEqual([]);
  f.cold();
  supervisor.enqueue("discord:11:5000", "INBOUND 11 5000 synthetic new request");
  await supervisor.flush();
  supervisor.close();
  const restarted = new Supervisor(f.deps);
  await restarted.flush();
  f.clock.at += 60_000;
  restarted.ackTick(60_000);
  f.clock.at += 60_000;
  restarted.ackTick(60_000);
  restarted.close();
  // Then the flood produced no ACK_MISSING and one digest listing the 298 untracked messages; only the new request is reminded.
  expect(lines(f.state.dir, store, "ACK_MISSING ")).toEqual([expect.stringMatching(/^ACK_MISSING 11 5000 INBOUND 11 5000 synthetic new request$/)]);
  const digest = lines(f.state.dir, store, "OWNER_QUARANTINED ");
  expect(digest).toHaveLength(1);
  expect(digest[0]).toStartWith("OWNER_QUARANTINED 298 11:1000,1001,1004,");
  expect(eventPriority(digest[0] ?? "")).toBe("digest");
  // The cold start carried the new request and none of the quarantined history.
  expect(f.prompt()).toContain("synthetic new request");
  expect(f.prompt()).not.toContain("synthetic flood message");
  const rows = stored(f.state.dir, store).awaitingAck ?? [];
  expect(rows.filter((entry) => (entry as { quarantined?: true }).quarantined)).toHaveLength(298);
  expect(rows.find((entry) => entry.id === "discord:11:1002")).toMatchObject({ deleted: true });
});

test.each(["json", "sqlite"] as const)("a 3-day-old unresolved request survives the %s store and is still reminded; a handled one stays handled", async (store) => {
  // Given tracking rows written three days ago: an unacked edited request, an acked one covering 1 of 2 tasks, a handled one.
  const f = fixture({ store });
  const old = f.clock.now() - 3 * DAY_MS;
  const handledAt = f.clock.now() - 60 * 60_000;
  seedState(f.state.dir, store, {
    events: [
      { id: "discord:11:1", line: "INBOUND 11 1 synthetic old request", at: old },
      { id: "discord:11:1:edit:2027-01-12T00:00:00.000Z", line: "INBOUND_EDIT 11 1 synthetic old request (edited)", at: old + 1 },
      { id: "discord:11:2", line: "INBOUND 11 2 synthetic handled request", at: old },
      { id: "discord:11:3", line: "INBOUND 11 3 synthetic half-covered request", at: old },
    ],
    awaitingAck: [
      { id: "discord:11:1", since: old, revision: "discord:11:1:edit:2027-01-12T00:00:00.000Z", revisions: ["discord:11:1:edit:2027-01-12T00:00:00.000Z"] },
      { id: "discord:11:2", since: old, ackedAt: old + 5, handledAt, tasks: 1, reply: true },
      { id: "discord:11:3", since: old, ackedAt: old + 5, tasks: 2, lanes: ["alpha"], reply: false },
    ],
  });
  // When the supervisor starts on it and runs its ack and handled checks.
  const supervisor = new Supervisor(f.deps);
  supervisor.ackTick(60_000);
  supervisor.handledTick(30 * 60_000);
  supervisor.close();
  // Then the old request is reminded in its latest text, the coverage gap is reported, and the handled one is untouched.
  expect(lines(f.state.dir, store, "ACK_MISSING ")).toEqual([expect.stringMatching(/^ACK_MISSING 11 1 INBOUND_EDIT 11 1 synthetic old request \(edited\)$/)]);
  expect(lines(f.state.dir, store, "UNHANDLED ")).toEqual([expect.stringMatching(/^UNHANDLED 11 3 coverage=1\/2 /)]);
  expect(lines(f.state.dir, store, "OWNER_QUARANTINED ")).toEqual([]);
  const rows = stored(f.state.dir, store).awaitingAck ?? [];
  expect(rows.find((entry) => entry.id === "discord:11:1")).toMatchObject({ since: old, reminded: true, revisions: ["discord:11:1:edit:2027-01-12T00:00:00.000Z"] });
  expect(rows.find((entry) => entry.id === "discord:11:2")).toEqual({ id: "discord:11:2", since: old, ackedAt: old + 5, handledAt, tasks: 1, reply: true });
});

test("a quarantined message the lead acks, or the owner edits, is tracked like any other again", async () => {
  // Given two quarantined messages from an untracked history.
  const f = fixture();
  const events = [{ id: "discord:11:1", line: "INBOUND 11 1 synthetic a", at: f.clock.now() }, { id: "discord:11:2", line: "INBOUND 11 2 synthetic b", at: f.clock.now() }];
  writeJournal(f.state.dir, { events, awaitingAck: [] });
  writeFileSync(join(f.state.dir, "lead-events.log"), events.map(({ id, line }) => `${JSON.stringify({ id, line })}\n`).join(""));
  const supervisor = new Supervisor(f.deps);
  // When the lead acks one and the owner edits the other.
  recordAck(f.state.dir, "11", "1", f.clock.now());
  supervisor.ackTick(60_000);
  supervisor.enqueue("discord:11:2:edit:2027-01-15T08:01:00.000Z", "INBOUND_EDIT 11 2 synthetic b (edited)");
  await supervisor.flush();
  f.clock.at += 60_000;
  supervisor.ackTick(60_000);
  // Then neither is quarantined any more: the acked one is waiting to be handled, the edited one is reminded.
  expect(tracked(f, "discord:11:1")).toMatchObject({ id: "discord:11:1" });
  expect((journal(f).awaitingAck as { quarantined?: true }[]).filter((entry) => entry.quarantined)).toEqual([]);
  expect(ackMissing(f)).toEqual([expect.stringMatching(/^ACK_MISSING 11 2 INBOUND_EDIT 11 2 synthetic b \(edited\)$/)]);
});
