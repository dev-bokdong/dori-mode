import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pendingAcks, recordAck, recordHandled } from "../src/ack.ts";
import { ACK_KEEP_MS, eventPriority, OWNER_NOTIFY_ATTEMPTS, Supervisor } from "../src/supervise.ts";
import { enqueueLaunch, launchQueue, launchQueueText, recordLaunchVerdict } from "../src/routing.ts";
import { supervisorSweeps } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState, readJournal, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(1_800_000_000_000);
  const world = newWorld();
  const pane = { pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" };
  world.panes.push(pane);
  const deps = depsFor(world, clock, state.dir);
  const journal = (): {
    events: { id: string; line: string }[];
    awaitingAck: { id: string; since?: number; ackedAt?: number; handledAt?: number; tasks?: number; lanes?: string[]; reply?: boolean; quarantined?: true }[];
    notifications?: Record<string, { attempts: number; sent?: boolean }>;
  } => readJournal(state.dir);
  return { state, clock, pane, deps, journal };
};

test("owner tracking is durable before a failing delivery-log append", async () => {
  // Given a durable inbox with an unwritable delivery-log path.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha");
  unlinkSync(supervisor.eventLog);
  mkdirSync(supervisor.eventLog);
  // When the append fails.
  await expect(supervisor.flush()).rejects.toThrow();
  // Then the owner record already exists and a restart can retry delivery.
  expect(f.journal().awaitingAck).toEqual([{ id: "discord:11:22" }]);
  rmSync(supervisor.eventLog, { recursive: true });
  await new Supervisor(f.deps).flush();
  expect(readFileSync(supervisor.eventLog, "utf8")).toContain('"id":"discord:11:22"');
});

test.each([false, true])("startup quarantines a legacy log entry with inbox-present=%s and no tracking: listed once, never reminded", async (inboxPresent) => {
  // Given the old crash window: a log append exists, but its ack tracking does not.
  const f = fixture();
  const event = { id: "discord:11:22", line: "INBOUND 11 22 owner alpha", at: f.clock.now() };
  writeJournal(f.state.dir, ({ events: inboxPresent ? [event] : [] }));
  writeFileSync(join(f.state.dir, "lead-events.log"), `${JSON.stringify(event)}\n`);
  // When the supervisor starts and the lead becomes readable.
  const supervisor = new Supervisor(f.deps);
  expect(f.journal().awaitingAck).toEqual([{ id: event.id, quarantined: true }]);
  f.pane.agent_status = "idle";
  await supervisor.flush();
  f.clock.at += 120_000;
  supervisor.ackTick(60_000);
  // Then it does not escape tracking: the lead gets it in the quarantine digest, not as a per-message reminder.
  expect(f.journal().events.filter((entry) => entry.line.startsWith("ACK_MISSING "))).toHaveLength(0);
  expect(f.journal().events.filter((entry) => entry.line.startsWith("OWNER_QUARANTINED 1 11:22 "))).toHaveLength(1);
});

test("unsent delay notices retry across restarts and stop at the attempt limit", () => {
  // Given a message a busy lead has not yet received.
  const f = fixture();
  let supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha");
  f.clock.at += 60_000;
  // When all permitted delivery attempts fail.
  for (let attempt = 0; attempt < OWNER_NOTIFY_ATTEMPTS; attempt++) {
    expect(supervisor.overdueOwnerMessages(60_000)).toEqual([{ channel: "11", message: "22" }]);
    supervisor.noticeAttempt("delay", "11", "22");
    supervisor = new Supervisor(f.deps);
  }
  // Then retries are bounded, without claiming a failed send succeeded.
  expect(supervisor.overdueOwnerMessages(60_000)).toEqual([]);
  expect(f.journal().notifications?.["delay:discord:11:22"]).toEqual({ attempts: OWNER_NOTIFY_ATTEMPTS });
});

test("a due notice that was never tried (the process died before posting) does not use up an attempt", () => {
  // Given a due delay notice.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha");
  f.clock.at += 60_000;
  // When it is listed more often than the attempt limit but never posted.
  for (let i = 0; i <= OWNER_NOTIFY_ATTEMPTS; i++) expect(supervisor.overdueOwnerMessages(60_000)).toEqual([{ channel: "11", message: "22" }]);
  // Then it is still due, and no attempt was recorded.
  expect(new Supervisor(f.deps).overdueOwnerMessages(60_000)).toEqual([{ channel: "11", message: "22" }]);
  expect(f.journal().notifications?.["delay:discord:11:22"]).toBeUndefined();
});

test("successful delay notices are persisted only after the caller confirms the send", () => {
  // Given a due owner notification.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha");
  f.clock.at += 60_000;
  supervisor.overdueOwnerMessages(60_000);
  expect(f.journal().notifications?.["delay:discord:11:22"]?.sent).toBeUndefined();
  // When the caller confirms success.
  supervisor.noticeSent("delay", "11", "22");
  // Then a fresh supervisor never repeats it.
  expect(new Supervisor(f.deps).overdueOwnerMessages(60_000)).toEqual([]);
  expect(f.journal().notifications?.["delay:discord:11:22"]?.sent).toBe(true);
});

test.each(["INBOUND_EDIT", "INBOUND_DELETE"])("%s is urgent without starting original-message ack tracking", (name) => {
  // Given a distinct owner edit/delete notice.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  // When it is queued.
  supervisor.enqueue(`discord:11:22:${name}`, `${name} 11 22 changed`);
  // Then it wakes the lead but cannot masquerade as the original request.
  expect(eventPriority(`${name} 11 22 changed`)).toBe("urgent");
  expect(f.journal().awaitingAck).toEqual([]);
});

test("handled CLI persists task count and reply coverage through the real command surface", async () => {
  // Given a tracked owner message and a config isolated to this test.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha beta");
  const config = join(f.state.dir, "config.json");
  writeFileSync(config, JSON.stringify(f.deps.config));
  // When the lead declares two tasks and links one reply through the CLI.
  const child = Bun.spawn([process.execPath, "src/cli.ts", "handled", "11", "22", "--tasks", "2", "--reply"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, DORI_CONFIG: config, DORI_STATE_DIR: f.state.dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then the real parser records exactly one covered task, not a completed two-task request.
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim().split(" ")).toEqual(["HANDLED_LINKED", "11", "22"]);
  supervisor.handledTick();
  expect(f.journal().awaitingAck[0]).toMatchObject({ tasks: 2, reply: true });
  expect(f.journal().awaitingAck[0]?.handledAt).toBeUndefined();
});

test("immutable handled receipts are cumulative and retain the declared task count", () => {
  // Given independent declarations queued before either can be consumed.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha beta");
  recordHandled(f.state.dir, "11", "22", f.clock.now(), { tasks: 2, lanes: ["alpha"] });
  recordHandled(f.state.dir, "11", "22", f.clock.now(), { lanes: ["beta"] });
  expect(pendingAcks(f.state.dir)).toHaveLength(2);
  // When the supervisor ingests both receipts.
  supervisor.handledTick();
  // Then both links and the task declaration reach the fsynced state before receipt removal.
  expect(f.journal().awaitingAck[0]?.lanes?.toSorted()).toEqual(["alpha", "beta"]);
  expect(f.journal().awaitingAck[0]).toMatchObject({ tasks: 2, handledAt: f.clock.now() });
  expect(pendingAcks(f.state.dir)).toEqual([]);
});

test("unfinished requests never expire with the orphan-receipt retention period", () => {
  // Given an acked owner request with no linked work.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha");
  recordAck(f.state.dir, "11", "22", f.clock.now());
  supervisor.ackTick(60_000);
  // When the old ack-retention period passes.
  f.clock.at += ACK_KEEP_MS + 1;
  new Supervisor(f.deps).handledTick();
  // Then the request is retained and escalates rather than silently disappearing.
  expect(f.journal().awaitingAck[0]?.handledAt).toBeUndefined();
  expect(f.journal().events.filter((event) => event.line.startsWith("UNHANDLED "))).toHaveLength(1);
});

test("receipt ordering cannot make a multi-task request handled with one lane", () => {
  // Given task and lane declarations with timestamps and immutable names in either filesystem order.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:11:22", "INBOUND 11 22 owner alpha beta");
  recordHandled(f.state.dir, "11", "22", f.clock.now() + 20, { lanes: ["alpha"] });
  recordAck(f.state.dir, "11", "22", f.clock.now() + 10, 2);
  // When both declarations are consumed together.
  supervisor.handledTick();
  // Then the earliest read time and highest task count win, independent of receipt filenames.
  expect(f.journal().awaitingAck[0]).toMatchObject({ tasks: 2, ackedAt: f.clock.now() + 10, lanes: ["alpha"] });
  expect(f.journal().awaitingAck[0]?.handledAt).toBeUndefined();
});

test("LAUNCH_READY snapshots the persisted launch queue before the hold clears", async () => {
  // Given two held launches that a restarted lead must recover.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  recordLaunchVerdict(f.state.dir, { ok: false, reasons: ["host full"] }, f.clock.now());
  for (const key of ["alpha", "beta"]) {
    enqueueLaunch(f.state.dir, {
      key, title: key, done: `merged owner/${key}#1`, brief: `/briefs/${key}.md`,
      cwd: `/repo/${key}`, repos: [`owner/${key}`], thread: `discord:11/${key}`,
      queuedAt: new Date(f.clock.now()).toISOString(), reasons: ["host full"],
    });
  }
  const expectedQueue = launchQueueText(launchQueue(f.state.dir));
  const deps = {
    ...f.deps,
    run: async (argv: readonly string[]) => argv[0] === "df"
      ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
      : f.deps.run(argv),
  };
  const guard = supervisorSweeps(deps, f.state.dir).find(([name]) => name === "guard");
  if (!guard) throw new Error("guard sweep missing");
  // When the actual guard sweep journals readiness and clears the hold.
  let sequence = 0;
  await guard[1](async (line) => { supervisor.enqueue(`guard:${sequence++}`, line); });
  // Then the durable event retains the complete formatter output and the queue remains recoverable.
  const ready = f.journal().events.find((event) => event.line.startsWith("LAUNCH_READY "))?.line;
  expect(ready?.endsWith(expectedQueue)).toBe(true);
  expect(ready?.split(expectedQueue)).toHaveLength(2);
  expect(launchQueue(f.state.dir)).toHaveLength(2);
});
