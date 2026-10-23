import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { run, RUN_KILL_GRACE_MS, type Ran, type Runner } from "../src/run.ts";
import { checkSignal } from "../src/signals.ts";
import { unreportedCorruptWaits, Waits } from "../src/waits.ts";
import { fakeClock, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const state = () => {
  const s = withState();
  cleanups.push(s.done);
  return s.dir;
};

test("timeout returns within the grace even when a descendant left the process group and still holds the pipes", async () => {
  const marker = "7.31";
  try {
    const started = performance.now();
    const result = await run(["bash", "-c", `setsid sleep ${marker} & sleep 30`], { timeoutMs: 300 });
    expect(result).toMatchObject({ code: 124, timedOut: true });
    expect(performance.now() - started).toBeLessThan(300 + RUN_KILL_GRACE_MS + 1_000);
  } finally {
    Bun.spawn(["pkill", "-f", `sleep ${marker}`]);
  }
});

test("a command that exits while a detached descendant holds its pipes returns its own code and output after the grace", async () => {
  const marker = "7.32";
  try {
    const started = performance.now();
    const result = await run(["bash", "-c", `echo hi; setsid sleep ${marker} & exit 3`], { timeoutMs: 20_000 });
    expect(result).toEqual({ code: 3, out: "hi", err: "" });
    expect(performance.now() - started).toBeLessThan(RUN_KILL_GRACE_MS + 1_000);
  } finally {
    Bun.spawn(["pkill", "-f", `sleep ${marker}`]);
  }
});

test("timeout kills the grandchild holding stdout and stderr", async () => {
  const pidFile = join(state(), "grandchild.pid");
  const result = await run(["sh", "-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile], { timeoutMs: 300 });
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  try {
    // Poll process state with a bounded deadline, without a fixed delay.
    const deadline = Date.now() + 1_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      const probe = Bun.spawn(["kill", "-0", String(pid)], { stdout: "ignore", stderr: "ignore" });
      alive = await probe.exited === 0;
      // A killed orphan may remain a zombie until the host's PID 1 reaps it.
      if (alive && process.platform === "linux") {
        try { alive = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; }
        catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; alive = false; }
      }
    }
    expect(alive).toBe(false);
    expect(result).toMatchObject({ code: 124, timedOut: true });
  } finally {
    try { process.kill(pid, "SIGKILL"); }
    catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e; }
  }
});

const failures: readonly { readonly name: string; readonly until: string; readonly result: Ran }[] = [
  { name: "GitHub authentication", until: "merged acme/app#1", result: { code: 1, out: "", err: "authentication required" } },
  { name: "GitHub issue lookup", until: "closed acme/app#1", result: { code: 1, out: "", err: "network unavailable" } },
  { name: "missing command", until: 'command ["missing-command"]', result: { code: 127, out: "", err: "not found" } },
  { name: "timeout exit", until: 'command ["check"]', result: { code: 124, out: "", err: "timeout" } },
];

test.each([...failures])("operational $name failures reach WAIT_FAILED through checkSignal", async ({ until, result }) => {
  const dir = state();
  const waits = new Waits(dir, 2);
  const clock = fakeClock(1_800_000_000_000);
  waits.register({ key: "review", until, note: "notify", cwd: dir }, clock.now());
  const runner: Runner = async () => result;
  const events: string[] = [];
  for (let i = 0; i < 2; i++) {
    await waits.tick(clock.now, runner, (_id, line) => { events.push(line); });
    clock.at += 60_000;
  }
  expect(events).toHaveLength(1);
  expect(events[0]?.split(" ")[0]).toBe("WAIT_FAILED");
  expect(waits.list()).toEqual([]);
});

test("network exceptions returned by checkSignal count as check failures", async () => {
  const dir = state();
  const waits = new Waits(dir, 1);
  waits.register({ key: "web", until: "url https://example.test", note: "notify", cwd: dir }, 0);
  const events: string[] = [];
  await waits.tick(() => 0, run, (_id, line) => { events.push(line); }, (wait) =>
    checkSignal(wait.until, run, { http: async () => { throw new Error("offline"); } }));
  expect(events[0]?.split(" ")[0]).toBe("WAIT_FAILED");
});

test("a real missing executable reaches WAIT_FAILED", async () => {
  const dir = state();
  const waits = new Waits(dir, 1);
  waits.register({ key: "missing", until: 'command ["/nonexistent/pr61-check"]', note: "notify", cwd: dir }, 0);
  const events: string[] = [];
  await waits.tick(() => 0, run, (_id, line) => { events.push(line); });
  expect(events[0]?.split(" ")[0]).toBe("WAIT_FAILED");
});

test.each([
  { until: "merged acme/app#1", result: { code: 0, out: '{"state":"OPEN","mergeCommit":null}', err: "" } },
  { until: "closed acme/app#1", result: { code: 0, out: '{"state":"OPEN"}', err: "" } },
  { until: "published example@1.0.0", result: { code: 1, out: "", err: "npm error code E404" } },
  { until: 'command ["check"]', result: { code: 1, out: "", err: "not ready" } },
])("an unmet condition remains distinct from a failed check: $until", async ({ until, result }) => {
  const checked = await checkSignal(until, async () => result);
  expect(checked.ok).toBe(false);
  expect(checked.error).toBeUndefined();
});

test("ordinary unmet signals reset rather than increment operational failures", async () => {
  const dir = state();
  const waits = new Waits(dir, 2);
  const clock = fakeClock(0);
  waits.register({ key: "pending", until: 'command ["check"]', note: "notify", cwd: dir }, 0);
  await waits.tick(clock.now, async () => ({ code: 127, out: "", err: "missing" }), () => {});
  expect(waits.list()[0]?.failures).toBe(1);
  clock.at += 60_000;
  await waits.tick(clock.now, async () => ({ code: 1, out: "", err: "not ready" }), () => {});
  expect(waits.list()[0]?.failures).toBeUndefined();
});

test("CLI quarantine is reported once by a reconstructed waits store", async () => {
  const dir = state();
  writeFileSync(join(dir, "waits.json"), "{broken");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "wait", "--list"], {
    env: { ...process.env, DORI_STATE_DIR: dir, DORI_CONFIG: join(dir, "missing.json") },
    stdout: "pipe", stderr: "pipe",
  });
  const [, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  const events: { id: string; line: string }[] = [];
  await new Waits(dir).tick(() => 0, run, (id, line) => { events.push({ id, line }); });
  await new Waits(dir).tick(() => 0, run, (id, line) => { events.push({ id, line }); });
  expect(events).toHaveLength(1);
  expect(events[0]?.line.split(" ")[0]).toBe("WAITS_CORRUPT");
});

test("a failed corruption emit is retried after store reconstruction", async () => {
  const dir = state();
  writeFileSync(join(dir, "waits.json"), "{broken");
  const waits = new Waits(dir);
  waits.list();
  const ids: string[] = [];
  await waits.tick(() => 0, run, (id) => { ids.push(id); throw new Error("enqueue unavailable"); });
  await new Waits(dir).tick(() => 0, run, (id) => { ids.push(id); });
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test("quarantine discovery persists until successful reporting and also runs on the first sweep", async () => {
  const dir = state();
  expect(unreportedCorruptWaits(join(dir, "missing"))).toEqual([]);
  writeFileSync(join(dir, "waits.json"), "{broken");
  const events: string[] = [];
  await new Waits(dir).tick(() => 0, run, (id) => { events.push(id); throw new Error("offline"); });
  const pending = unreportedCorruptWaits(dir);
  expect(pending).toHaveLength(1);
  new Waits(dir).reportCorruptWaits((id) => { events.push(id); });
  expect(events).toEqual([`waits-corrupt:${pending[0]}`, `waits-corrupt:${pending[0]}`]);
  expect(unreportedCorruptWaits(dir)).toEqual([]);
  new Waits(dir).reportCorruptWaits((id) => { events.push(id); });
  expect(events).toHaveLength(2);
});
