import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type DeliveryConfig, defaultConfig } from "../src/config.ts";
import type { Runner } from "../src/run.ts";
import { ACK_KEEP_MS, Supervisor } from "../src/supervise.ts";
import { inputState, pointerText } from "../src/supervise-push.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { recordAck, recordHandled } from "../src/ack.ts";
import { take, takeOutput } from "../src/inbox.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

type Delivery = Partial<Omit<DeliveryConfig, "push">> & { readonly push?: Partial<DeliveryConfig["push"]> };
const delivery = (patch: Delivery = {}): DeliveryConfig => {
  const base = defaultConfig().delivery;
  return { ...base, mode: "push", ...patch, push: { ...base.push, ...patch.push } };
};

/** A screen as omo draws it (phase 0 capture): the input box between the running header and the full-width separator. */
const omo = (input: string, footer = "(\u{1F63A} OmO Native by Q Kim)"): string =>
  `\u2500\u2500 \u2022 Working (1s \u2022 esc to interrupt) ${"\u2500".repeat(40)}\n\u276f ${input}\n${"\u2500".repeat(80)}\n/repo \u2022 0/1M (0.0%) (auto)\n${footer}`;
const EMPTY = omo("");

const fixture = (extra: Record<string, unknown> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const clock: ReturnType<typeof fakeClock> = { at: 1_800_000_000_000, now: () => clock.at, sleep: async (ms: number) => { clock.at += ms; } };
  const world = newWorld();
  world.screen = EMPTY;
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
  let prompt: string | undefined;
  let onEnter: string | undefined;
  let onSend: (() => void) | undefined;
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const ok = (out = "") => ({ code: 0, out, err: "" });
    if (argv[0] === "ps" && argv[1] === "-A") return ok(pid ? `${pid} 10 /usr/bin/omo --session-id ${active}` : "");
    if (argv[0] === "ps" && argv[1] === "eww") return ok("PI_SESSION_ID=other");
    if (argv[0] === "herdr" && argv[2] === "list") return ok(JSON.stringify({ result: { panes: world.panes } }));
    if (argv[0] === "herdr" && argv[2] === "process-info") return ok(JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_processes: pid ? [{ pid, argv: ["omo", "--session-id", active] }] : [] } } }));
    if (argv[0] === "kill") {
      if (argv[2] === String(pid)) { pid = 0; pane.agent = ""; pane.agent_status = ""; }
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "run") {
      const path = /@([^'\s]+)/.exec(argv[4] ?? "")?.[1];
      prompt = path ? readFileSync(path, "utf8") : undefined;
      active = /--session-id ([\w-]+)/.exec(argv[4] ?? "")?.[1] ?? "";
      pid = 201;
      mkdirSync(join(dir, "session-holders", active), { recursive: true });
      writeFileSync(join(dir, "session-holders", active, `${pid}.json`), "{}");
      pane.agent = "omo";
      pane.agent_status = "idle";
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "wait") return ok();
    if (argv[0] === "herdr" && argv[2] === "read") return ok(world.screens?.length ? (world.screens.shift() ?? world.screen) : world.screen);
    if (argv[0] === "herdr" && argv[2] === "send-text") { onSend?.(); return ok(); }
    if (argv[0] === "herdr" && argv[2] === "send-keys") {
      if (onEnter) pane.agent_status = onEnter;
      return ok();
    }
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = { ...depsFor(world, clock, state.dir, config), run };
  return {
    state, deps, pane, clock, calls, world, file,
    texts: () => calls.filter((call) => call[0] === "herdr" && call[2] === "send-text").map((call) => call[4] ?? ""),
    enters: () => calls.filter((call) => call[0] === "herdr" && call[2] === "send-keys").length,
    launches: () => calls.filter((call) => call[0] === "herdr" && call[2] === "run"),
    prompt: () => prompt,
    onEnter: (status: string | undefined) => { onEnter = status; },
    onSend: (hook: () => void) => { onSend = hook; },
  };
};

/** Console output of `work`, kept off the test log. */
const logged = async (work: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await work(); } finally { console.log = log; console.error = error; }
  return lines;
};
const flush = (supervisor: Supervisor) => logged(() => supervisor.flush());

const inToolCall = (f: ReturnType<typeof fixture>, at: number): void => {
  const entry = (message: object, when: number) => JSON.stringify({ type: "message", timestamp: new Date(when).toISOString(), message });
  writeFileSync(f.file, `${entry({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "eval" }] }, at)}\n`);
};

test("an urgent event for an idle lead gets exactly one [dori] pointer and one Enter, its push journaled before the send", async () => {
  const f = fixture({ delivery: delivery() });
  f.onEnter("working");
  const supervisor = new Supervisor(f.deps);
  let journaled: unknown;
  f.onSend(() => { journaled = readJournal(f.state.dir).inbox?.push?.attempts; });
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  const lines = await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  const pointer = f.texts()[0] ?? "";
  expect(pointer.startsWith("[dori] supervisor: 1 new event (urgent: WAIT_DONE).")).toBe(true);
  expect(pointer.length).toBeLessThanOrEqual(200);
  expect(f.enters()).toBe(1);
  expect(journaled).toBe(1);
  expect(lines.some((line) => /^LEAD_PUSH \w+ 1 WAIT_DONE delivered attempt=1$/.test(line))).toBe(true);
});

test("tail mode, the default, never types into the lead and keeps the startup prompt's tail monitor", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  f.clock.at += 10 * 60_000;
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  expect(readJournal(f.state.dir).inbox?.takenOffset).toBe(0);
});

test("an untaken event is pushed again after ackSec though nothing is pending, and a take receipt past it stops the pushes", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual(["wait:1\tWAIT_DONE ci green"]);
  f.clock.at += 10 * 60_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(readJournal(f.state.dir).inbox.push).toBeUndefined();
});

test("a burst within one tick and more within ackSec become a single push", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  for (const i of [1, 2, 3]) supervisor.enqueue(`wait:${i}`, `WAIT_DONE job ${i}`);
  await flush(supervisor);
  f.clock.at += 5_000;
  supervisor.enqueue("lane:1", "LANE_REPORT k question which base?");
  supervisor.enqueue("lane:2", "LANE_REPORT k blocked no token");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toContain("3 new events (urgent: WAIT_DONE x3)");
});

test("a blocked lead is never typed into, a working one only with toWorking, and every state still appends", async () => {
  for (const [status, toWorking, pushes] of [["blocked", true, 0], ["working", false, 0], ["working", true, 1]] as const) {
    const f = fixture({ delivery: delivery({ push: { toWorking } }) });
    f.pane.agent_status = status;
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("wait:1", "WAIT_DONE ci green");
    await flush(supervisor);
    expect(readFileSync(join(f.state.dir, "lead-events.log"), "utf8")).toContain('"id":"wait:1"');
    expect(f.texts()).toHaveLength(pushes);
    if (status === "blocked") expect(f.enters()).toBe(0);
    // A pointer queued into a working turn never confirms by a status change; its empty input needs no second Enter.
    if (status === "working" && toWorking) expect(f.enters()).toBe(1);
  }
});

test("a working lead that turns idle gets its pointer on the next pass", async () => {
  const f = fixture({ delivery: delivery() });
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  f.pane.agent_status = "idle";
  f.clock.at += 5_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
});

test("the input guard types only into an empty input, and re-submits only our own pointer or a lone paste placeholder", async () => {
  const pointer = pointerText(1, true, ["WAIT_DONE"], 200);
  // Wrapped the way omo wraps a long line: two-space continuation lines inside the box.
  const wrapped = omo(`${pointer.slice(0, 120)}\n  ${pointer.slice(120)}`);
  expect(inputState(EMPTY)).toBe("empty");
  expect(inputState(wrapped)).toBe("ours");
  expect(inputState(omo("[paste #1 +3 lines]"))).toBe("ours");
  expect(inputState(omo("[paste #1 +3 lines] and more"))).toBe("busy");
  expect(inputState(omo("half a sentence"))).toBe("busy");
  expect(inputState(omo("\n  second line of the owner's text"))).toBe("busy");
  expect(inputState("no prompt on this screen")).toBe("busy");
  for (const [screen, texts, enters, line] of [
    [omo("half a sentence"), 0, 0, "LEAD_PUSH_INPUT_BUSY"],
    [omo("\n  second line"), 0, 0, "LEAD_PUSH_INPUT_BUSY"],
    [wrapped, 0, 1, "LEAD_PUSH_ENTER_RETRY"],
    [omo("[paste #1 +3 lines]"), 0, 1, "LEAD_PUSH_ENTER_RETRY"],
    [omo("[paste #1 +3 lines] and more"), 0, 0, "LEAD_PUSH_INPUT_BUSY"],
  ] as const) {
    const f = fixture({ delivery: delivery() });
    f.world.screen = screen;
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("wait:1", "WAIT_DONE ci green");
    const lines = await flush(supervisor);
    expect([f.texts().length, f.enters()]).toEqual([texts, enters]);
    expect(lines.some((l) => l.startsWith(line))).toBe(true);
  }
});

test("a pushed pointer still in the input after pasteCheckMs gets one more Enter, never a second one", async () => {
  const f = fixture({ delivery: delivery() });
  const pointer = pointerText(1, true, ["WAIT_DONE"], 200);
  // The quota check and the input guard read an empty input; after the send the pointer still sits there.
  f.world.screens = [EMPTY, EMPTY];
  f.world.screen = omo(pointer);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.enters()).toBe(2);
});

test("an untaken urgent event survives a ladder restart: the cursor stays, take prints it, unfinished owner messages stay inline", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 please fix the build");
  supervisor.enqueue("lane:q", "LANE_REPORT k question which base branch?");
  await flush(supervisor);
  // The owner message is acked (the lead read it on its tail), so only the lane question is untaken.
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  const before = readJournal(f.state.dir).inbox.takenOffset;
  for (let i = 0; i < 6 && !f.launches().length; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  expect(readJournal(f.state.dir).inbox.takenOffset).toBe(before);
  const prompt = f.prompt() ?? "";
  const lines = prompt.split("\n");
  expect(lines[3]).toStartWith("Run dori inbox take now");
  expect(prompt).toContain("it did not take pushed events (1 urgent event(s) untaken for 5 min)");
  expect(prompt).toContain('"id":"discord:1:1"');
  expect(prompt).not.toContain('"id":"lane:q"');
  expect(prompt).not.toContain("tail -c +");
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual([
    "discord:1:1\tINBOUND 1 1 please fix the build", "lane:q\tLANE_REPORT k question which base branch?",
  ]);
  expect(readJournal(f.state.dir).forcedRestarts).toEqual([{ at: expect.any(Number), cause: "forced" }]);
});

test("a new lead is not escalated before escalateMin after its start, and gets a pointer first (N1)", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane:q", "LANE_REPORT k question which base branch?");
  await flush(supervisor);
  for (let i = 0; i < 6 && !f.launches().length; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  // The new lead did not take: the pass that started it already gave it a pointer, and no second restart follows for escalateMin.
  const launched = f.calls.findIndex((call) => call[2] === "run");
  expect(f.calls.findLastIndex((call) => call[2] === "send-text")).toBeGreaterThan(launched);
  for (let i = 0; i < 4; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  f.clock.at += 61_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(2);
});

test("with the tail monitor on, an acked owner message leaves the untaken set and never restarts; other events only re-push", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  for (let i = 0; i < 10; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.texts()).toHaveLength(1);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  for (let i = 0; i < 10; i++) {
    // A lead in use keeps a fresh session file, so delivery stays warm instead of cold-starting it.
    utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
    await flush(supervisor);
    f.clock.at += 60_000;
  }
  expect(f.texts().length).toBeGreaterThan(2);
  expect(f.launches()).toEqual([]);
});

test("with the tail monitor on, an owner message unacked for escalateMin restarts an idle lead (the idle rule's clock is the ladder's)", async () => {
  const f = fixture({ delivery: delivery(), leadUnreadRestartMin: 1 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  f.clock.at += 2 * 60_000;
  await flush(supervisor);
  // In tail mode leadUnreadRestartMin would have restarted it already.
  expect(f.launches()).toEqual([]);
  f.clock.at += 3 * 60_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
});

test("an owner message the lead took but did not ack is left to the ack notice: no idle restart in push mode", async () => {
  const f = fixture({ delivery: delivery(), leadUnreadRestartMin: 1 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  for (let i = 0; i < 10; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toEqual([]);
});

test("a working lead is never ladder-restarted for a non-owner event, but one tool call with an unacked owner message is, on escalateMin", async () => {
  const progressing = fixture({ delivery: delivery({ tailMonitor: false }) });
  progressing.pane.agent_status = "working";
  const s1 = new Supervisor(progressing.deps);
  s1.enqueue("gh:1", "GH_PR acme/app#7 comment please rename");
  for (let i = 0; i < 12; i++) {
    progressing.world.screen = omo(`step ${"x".repeat(i)}`);
    await flush(s1);
    progressing.clock.at += 60_000;
  }
  expect(progressing.launches()).toEqual([]);

  const held = fixture({ delivery: delivery(), leadUnreadRestartMin: 30 });
  held.pane.agent_status = "working";
  inToolCall(held, held.clock.now());
  const s2 = new Supervisor(held.deps);
  s2.enqueue("discord:1:1", "INBOUND 1 1 hi");
  for (let i = 0; i < 5; i++) {
    await flush(s2);
    held.clock.at += 60_000;
  }
  expect(held.launches()).toEqual([]);
  await flush(s2);
  expect(held.launches()).toHaveLength(1);
  expect(held.prompt()).toContain("it was stuck in one tool call for 5 min");
});

test("past restartMaxPerHour the ladder refuses, logs and tells the owner once, keeps re-pushing, and the cap survives a supervisor restart", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  writeJournal(f.state.dir, { events: [], forcedRestarts: [1, 2, 3].map((i) => ({ at: f.clock.now() - i * 60_000, cause: "forced" })) });
  const announced: string[] = [];
  const hooks = { announce: async (text: string) => { announced.push(text); } };
  let supervisor = new Supervisor(f.deps, hooks);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    lines.push(...await flush(supervisor));
    f.clock.at += 60_000;
    if (i === 5) { supervisor.close(); supervisor = new Supervisor(f.deps, hooks); }
  }
  await supervisor.reactionsSettled();
  expect(f.launches()).toEqual([]);
  expect(lines.filter((line) => line.startsWith("LEAD_RESTART_CAPPED"))).toHaveLength(1);
  expect(announced.filter((text) => text.includes("not restarted again"))).toHaveLength(1);
  expect(f.texts().length).toBeGreaterThan(3);
});

test("the cap counts forced restarts and quota switches only: a demand-driven cold start is not counted (N4)", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  // A stale idle session with no waits or lanes is not warm: the urgent event goes to a cold start.
  f.clock.at += 10 * 60_000;
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
  expect(readJournal(f.state.dir).forcedRestarts).toBeUndefined();
});

test("compacted owner tracking counts as taken: no push, no escalation (N2)", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  recordAck(f.state.dir, "1", "1", f.clock.now());
  recordHandled(f.state.dir, "1", "1", f.clock.now(), { reply: true });
  supervisor.ackTick(60_000);
  f.clock.at += ACK_KEEP_MS + 60_000;
  supervisor.ackTick(60_000);
  expect(readJournal(f.state.dir).closedOwners).toContain("discord:1:1");
  for (let i = 0; i < 3; i++) {
    await flush(supervisor);
    f.clock.at += 10 * 60_000;
  }
  expect(f.texts()).toHaveLength(1);
  expect(f.launches()).toEqual([]);
});

test("an edit after the ack and a delete of an acked message are pushed; a delete of a never-acked message is not (N3)", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  const supervisor = new Supervisor(f.deps);
  const takeAll = () => take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 other");
  await flush(supervisor);
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  takeAll();
  f.clock.at += 1_000;
  supervisor.enqueue("discord:1:1:edit:1", "INBOUND_EDIT 1 1 new text");
  await flush(supervisor);
  expect(f.texts().at(-1)).toContain("INBOUND_EDIT");
  takeAll();
  supervisor.enqueue("discord:1:1:delete", "INBOUND_DELETE 1 1");
  await flush(supervisor);
  expect(f.texts().at(-1)).toContain("INBOUND_DELETE");
  takeAll();
  const pushes = f.texts().length;
  supervisor.enqueue("discord:1:2:delete", "INBOUND_DELETE 1 2");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(pushes);
});

test("after retries + 1 pushes the next one waits twice ackSec (N7)", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  for (let i = 0; i < 2; i++) {
    f.clock.at += 45_000;
    await flush(supervisor);
  }
  expect(f.texts()).toHaveLength(3);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(3);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(4);
});

test("digest traffic is pushed only once overdue, and a _WARN line never", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 120 } }), digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudge:1", "NUDGED lane silent");
  supervisor.enqueue("warn:1", "SWEEP_WARN guard slow");
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  f.clock.at += 61 * 60_000;
  // Stale session: keep the lead warm so the overdue digest is appended, not cold-started.
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toContain("(digest: NUDGED)");
});

test("push mode enqueues no ACK_MISSING but the owner still gets the ack notice", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }), ackTimeoutSec: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  f.clock.at += 61_000;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  f.clock.at += 61_000;
  expect(supervisor.ackTick(60_000)).toEqual([{ channel: "1", message: "1" }]);
  expect(readJournal(f.state.dir).events.some((event: { line: string }) => event.line.startsWith("ACK_MISSING"))).toBe(false);
});

test("nothing untaken and due makes no herdr call at all", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  const before = f.calls.length;
  f.clock.at += 60_000;
  await flush(supervisor);
  expect(f.calls.slice(before)).toEqual([]);
});

test("shadow mode logs would-push and would-escalate and types nothing", async () => {
  const f = fixture({ delivery: delivery({ mode: "shadow", tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    lines.push(...await flush(supervisor));
    f.clock.at += 60_000;
  }
  expect(f.texts()).toEqual([]);
  expect(f.launches()).toEqual([]);
  expect(lines.some((line) => /^LEAD_PUSH_SHADOW would-push \w+ 1 WAIT_DONE attempt=1$/.test(line))).toBe(true);
  expect(lines.filter((line) => line.startsWith("LEAD_PUSH_SHADOW would-escalate"))).toHaveLength(1);
});

test("a crash between the journaled push and the send pushes once more after ackSec", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  let crash = true;
  f.onSend(() => { if (crash) { crash = false; throw new Error("killed mid-send"); } });
  const first = new Supervisor(f.deps);
  first.enqueue("wait:1", "WAIT_DONE ci green");
  await expect(logged(() => first.flush())).rejects.toThrow("killed mid-send");
  first.close();
  const second = new Supervisor(f.deps);
  await flush(second);
  expect(f.texts()).toHaveLength(1);
  f.clock.at += 45_000;
  await flush(second);
  expect(f.texts()).toHaveLength(2);
});

test("entering push from tail moves the take cursor to the log's end; staying in tail keeps it (N6)", async () => {
  const f = fixture();
  const tail = new Supervisor(f.deps);
  tail.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(tail);
  tail.close();
  const again = new Supervisor(f.deps);
  again.close();
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now(), peek: true }))).toEqual(["wait:1\tWAIT_DONE ci green"]);
  const lines = await logged(async () => { new Supervisor({ ...f.deps, config: { ...f.deps.config, delivery: delivery() } }).close(); });
  expect(lines.some((line) => line.startsWith("INBOX_CURSOR_ADVANCED 0 -> "))).toBe(true);
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual(["INBOX_EMPTY"]);
});
