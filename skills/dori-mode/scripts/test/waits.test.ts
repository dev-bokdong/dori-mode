import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Waits, WAIT_CHECK_MS, WAIT_MAX_FAILURES } from "../src/waits.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { Supervisor } from "../src/supervise.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(1_800_000_000_000);
  const waits = new Waits(state.dir);
  const input = { key: "release", until: "file ready", note: "tell owner", cwd: state.dir };
  const events: { id: string; line: string }[] = [];
  const emit = (id: string, line: string) => { events.push({ id, line }); };
  return { state, clock, waits, input, events, emit };
};

test("registration uses signal syntax and survives a store reconstruction", () => {
  const f = fixture();
  const wait = f.waits.register({ ...f.input, thread: "discord:1/2", every: "15", timeout: "2" }, f.clock.now());
  expect(new Waits(f.state.dir).list()).toEqual([wait]);
  expect(wait.everyMs).toBe(15_000);
  expect(wait.deadline).toBe(f.clock.now() + 120_000);
  expect(() => f.waits.register(f.input, f.clock.now())).toThrow("already exists");
});

test("the CLI registers the parsed signal and scheduling options durably", async () => {
  const f = fixture();
  const child = Bun.spawn([
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "wait", "cli-qa", "--until", 'command ["true"]', "--note", "notify owner",
    "--thread", "discord:1/2", "--every", "15", "--timeout", "2",
  ], {
    cwd: f.state.dir,
    env: { ...process.env, DORI_CONFIG: join(f.state.dir, "missing-config.json"), DORI_STATE_DIR: f.state.dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, out: out.trim(), err }).toEqual({ code: 0, out: "WAIT_REGISTERED cli-qa", err: "" });
  const wait = new Waits(f.state.dir).list()[0];
  expect(wait).toMatchObject({ key: "cli-qa", until: 'command ["true"]', note: "notify owner", thread: "discord:1/2", everyMs: 15_000, cwd: f.state.dir });
  expect(wait?.deadline).toBe((wait?.nextAt ?? 0) + 120_000);
});

test.each([
  { key: "../escape" }, { until: "not a signal" }, { note: "" },
  { every: "0" }, { every: "NaN" }, { timeout: "-1" }, { timeout: "Infinity" },
])("invalid registration is rejected without persisting: %j", (patch) => {
  const f = fixture();
  expect(() => f.waits.register({ ...f.input, ...patch }, f.clock.now())).toThrow();
  expect(f.waits.list()).toEqual([]);
});

test("cancel persists and reusing the key gets a new event identity", () => {
  const f = fixture();
  const first = f.waits.register(f.input, f.clock.now());
  expect(f.waits.cancel(first.key)).toBe(true);
  expect(new Waits(f.state.dir).list()).toEqual([]);
  expect(f.waits.cancel(first.key)).toBe(false);
  expect(f.waits.register(f.input, f.clock.now()).id).not.toBe(first.id);
});

test("a real file signal fires once after reconstruction with its thread", async () => {
  const f = fixture();
  f.waits.register({ ...f.input, thread: "discord:1/2" }, f.clock.now());
  writeFileSync(join(f.state.dir, "ready"), "");
  await new Waits(f.state.dir).tick(f.clock.now, run, f.emit);
  await new Waits(f.state.dir).tick(f.clock.now, run, f.emit);
  expect(f.events.map((e) => e.line)).toEqual(["WAIT_DONE release tell owner thread=discord:1/2"]);
  expect(f.waits.list()).toEqual([]);
});

test("an expired deadline fires once without checking even before the next interval", async () => {
  const f = fixture();
  f.waits.register({ ...f.input, timeout: "1", every: "600" }, f.clock.now());
  await f.waits.tick(f.clock.now, run, f.emit);
  f.clock.at += 60_000;
  await f.waits.tick(f.clock.now, run, f.emit, async () => { throw new Error("must not check"); });
  await new Waits(f.state.dir).tick(f.clock.now, run, f.emit);
  expect(f.events.map((e) => e.line)).toEqual(["WAIT_TIMEOUT release tell owner"]);
});

test("failed checks respect the persisted interval", async () => {
  const f = fixture();
  f.waits.register(f.input, f.clock.now());
  let checks = 0;
  const check = async () => { checks++; return { signal: "", ok: false, detail: "pending" }; };
  await f.waits.tick(f.clock.now, run, f.emit, check);
  await new Waits(f.state.dir).tick(f.clock.now, run, f.emit, check);
  expect(checks).toBe(1);
  f.clock.at += 60_000;
  await f.waits.tick(f.clock.now, run, f.emit, check);
  expect(checks).toBe(2);
  expect(f.events).toEqual([]);
});

test("a throwing check does not prevent another wait or a later tick", async () => {
  const f = fixture();
  f.waits.register(f.input, f.clock.now());
  f.waits.register({ ...f.input, key: "healthy" }, f.clock.now());
  await f.waits.tick(f.clock.now, run, f.emit, async (wait) => {
    if (wait.key === "release") throw new Error("offline");
    return { signal: wait.until, ok: true, detail: "done" };
  });
  expect(f.events.map((e) => e.line)).toEqual(["WAIT_DONE healthy tell owner"]);
  f.clock.at += 60_000;
  writeFileSync(join(f.state.dir, "ready"), "");
  await f.waits.tick(f.clock.now, run, f.emit);
  expect(f.events).toHaveLength(2);
});

test("a check cannot fire a wait cancelled and re-registered while it ran", async () => {
  const f = fixture();
  f.waits.register(f.input, f.clock.now());
  await f.waits.tick(f.clock.now, run, f.emit, async () => {
    new Waits(f.state.dir).cancel(f.input.key);
    new Waits(f.state.dir).register(f.input, f.clock.now());
    return { signal: "", ok: true, detail: "" };
  });
  expect(f.events).toEqual([]);
  expect(f.waits.list()).toHaveLength(1);
});

test("a crash after durable enqueue replays the same outcome and ID once", async () => {
  const f = fixture();
  const world = newWorld();
  const deps = depsFor(world, f.clock, f.state.dir);
  world.panes.push({ pane_id: deps.config.leadPane, workspace_id: "test", agent: "omo", agent_status: "working" });
  const before = new Supervisor(deps);
  f.waits.register({ ...f.input, timeout: "1" }, f.clock.now());
  writeFileSync(join(f.state.dir, "ready"), "");
  await f.waits.tick(f.clock.now, run, (id, line) => {
    before.enqueue(id, line);
    throw new Error("crash before removal");
  });
  expect(f.waits.list()[0]?.outcome).toBe("WAIT_DONE");
  f.clock.at += 120_000;
  const after = new Supervisor(deps);
  await new Waits(f.state.dir).tick(f.clock.now, run, (id, line) => after.enqueue(id, line));
  await after.flush();
  const log = (await Bun.file(after.eventLog).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(log).toHaveLength(1);
  expect(log[0].line).toBe("WAIT_DONE release tell owner");
  expect(f.waits.list()).toEqual([]);
});

test("command checks receive the bounded runner timeout", async () => {
  const f = fixture();
  f.waits.register({ ...f.input, until: 'command ["true"]' }, f.clock.now());
  let timeout: number | undefined;
  await f.waits.tick(f.clock.now, async (_argv, opts) => {
    timeout = opts?.timeoutMs;
    return { code: 0, out: "", err: "" };
  }, f.emit);
  expect(timeout).toBe(WAIT_CHECK_MS);
  expect(f.events).toHaveLength(1);
});

test("a hung check is bounded and does not hold back a healthy completion", async () => {
  const f = fixture();
  f.waits.register({ ...f.input, timeout: "0.0001" }, f.clock.now());
  f.waits.register({ ...f.input, key: "healthy" }, f.clock.now());
  let aborted = false;
  await f.waits.tick(f.clock.now, run, f.emit, async (wait, signal) => {
    if (wait.key === "healthy") return { signal: "", ok: true, detail: "" };
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ signal: "", ok: false, detail: "" });
      }, { once: true });
    });
  });
  expect(aborted).toBe(true);
  expect(f.events.map((e) => e.line)).toEqual(["WAIT_DONE healthy tell owner"]);
});

test.each(["{not json", JSON.stringify({ not: "a list" }), JSON.stringify([{ id: 1 }])])("a corrupt waits.json is quarantined, reported once, and the store keeps working: %s", async (bad) => {
  const f = fixture();
  writeFileSync(join(f.state.dir, "waits.json"), bad);
  expect(f.waits.list()).toEqual([]);
  const aside = readdirSync(f.state.dir).filter((n) => n.startsWith("waits.json.corrupt-"));
  expect(aside).toHaveLength(1);
  expect(readFileSync(join(f.state.dir, aside[0] ?? ""), "utf8")).toBe(bad);
  f.waits.register(f.input, f.clock.now());
  await f.waits.tick(f.clock.now, run, f.emit, async () => ({ signal: "", ok: false, detail: "pending" }));
  await f.waits.tick(f.clock.now, run, f.emit, async () => ({ signal: "", ok: false, detail: "pending" }));
  expect(f.events.map((e) => e.line)).toEqual([`WAITS_CORRUPT waits.json did not parse and was moved to ${join(f.state.dir, aside[0] ?? "")}; every wait in it is dropped, register them again`]);
  expect(f.waits.list()).toHaveLength(1);
});

test("a wait without --timeout whose checks keep failing ends as WAIT_FAILED after the cap, once", async () => {
  const f = fixture();
  const waits = new Waits(f.state.dir, 3);
  waits.register({ ...f.input, thread: "discord:1/2" }, f.clock.now());
  const broken = async () => { throw new Error("offline"); };
  for (let i = 1; i <= 2; i++) {
    await waits.tick(f.clock.now, run, f.emit, broken);
    expect(waits.list()[0]?.failures).toBe(i);
    f.clock.at += 60_000;
  }
  await waits.tick(f.clock.now, run, f.emit, broken);
  f.clock.at += 60_000;
  await waits.tick(f.clock.now, run, f.emit, broken);
  expect(f.events.map((e) => e.line)).toEqual(["WAIT_FAILED release tell owner (3 checks in a row failed; no --timeout set) thread=discord:1/2"]);
  expect(waits.list()).toEqual([]);
});

test("a check that answers resets the failure count, and a wait with a deadline is never capped", async () => {
  const f = fixture();
  const waits = new Waits(f.state.dir, 2);
  waits.register(f.input, f.clock.now());
  waits.register({ ...f.input, key: "bounded", timeout: "600" }, f.clock.now());
  const broken = async () => { throw new Error("offline"); };
  await waits.tick(f.clock.now, run, f.emit, broken);
  f.clock.at += 60_000;
  await waits.tick(f.clock.now, run, f.emit, async () => ({ signal: "", ok: false, detail: "pending" }));
  expect(waits.list().map((w) => w.failures)).toEqual([undefined, undefined]);
  for (let i = 0; i < 3; i++) {
    f.clock.at += 60_000;
    await waits.tick(f.clock.now, run, f.emit, async (wait) => {
      if (wait.key === "bounded") throw new Error("offline");
      return { signal: "", ok: false, detail: "pending" };
    });
  }
  expect(f.events).toEqual([]);
  expect(waits.list().find((w) => w.key === "bounded")?.failures).toBe(3);
  expect(WAIT_MAX_FAILURES).toBeGreaterThan(1);
});
