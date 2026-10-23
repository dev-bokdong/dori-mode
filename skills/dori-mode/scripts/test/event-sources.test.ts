import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import {
  EMIT_DIR, EventSources, publicSpec, queueEmit, readSourceStatus, SourceError, SourceSpecs, sourceViews, validateSpec,
} from "../src/event-sources.ts";
import type { Ran, Runner } from "../src/run.ts";
import { collectStatus, renderStatus } from "../src/status.ts";
import { supervise } from "../src/supervise-loop.ts";
import { Supervisor } from "../src/supervise.ts";
import { Waits } from "../src/waits.ts";
import { depsFor, fakeClock, manualPause, newWorld, readJournal, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const done of cleanups.splice(0).reverse()) done();
});

const T0 = 1_800_000_000_000;
const ok = (out = ""): Ran => ({ code: 0, out, err: "" });

/** A Supervisor whose owner-only posts are captured, and a source registry enqueueing into it. */
const fixture = (kinds: Record<string, string>, run: Runner = async () => ok()) => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, state.dir, { eventPolicy: resolveEventPolicy({ kinds }) });
  const posted: string[] = [];
  const supervisor = new Supervisor(deps, { announce: async (text) => { posted.push(text); } });
  cleanups.push(() => { supervisor.close(); });
  const logs: string[] = [];
  const sources = new EventSources({
    stateDir: state.dir, enqueue: (id, line) => supervisor.enqueue(id, line), now: clock.now, run, policy: deps.config.eventPolicy,
    log: (line) => { logs.push(line); },
  });
  cleanups.push(() => { sources.close(); });
  const events = (): { id: string; line: string }[] => readJournal(state.dir).events;
  const settled = async () => { await supervisor.reactionsSettled(); return posted; };
  return { dir: state.dir, clock, deps, supervisor, sources, events, settled, logs };
};

test("dori emit: spooled events are journaled once per --id and delivered by their policy class", async () => {
  const f = fixture({ DEPLOY: "owner-only" });
  queueEmit(f.dir, "DEPLOY", "web v2\nrolled out", T0, "deploy-42");
  queueEmit(f.dir, "DEPLOY", "web v2 rolled out again", T0 + 1, "deploy-42");
  queueEmit(f.dir, "DEPLOY", "no id: its own event", T0 + 2);
  await f.sources.tick();
  const deploys = f.events().filter((event) => event.line.startsWith("DEPLOY "));
  expect(deploys.map((event) => event.line)).toEqual(["DEPLOY web v2 rolled out", "DEPLOY no id: its own event"]);
  expect(deploys[0]?.id).toBe("emit:deploy-42");
  // owner-only: posted to the owner's channel, never journaled for the lead's delivery.
  expect(await f.settled()).toEqual(["DEPLOY web v2 rolled out", "DEPLOY no id: its own event"]);
  expect(readdirSync(join(f.dir, EMIT_DIR))).toEqual([]);
  // A later emit with the same id is still a duplicate.
  queueEmit(f.dir, "DEPLOY", "replayed", T0 + 3, "deploy-42");
  await f.sources.tick();
  expect(f.events().filter((event) => event.line.startsWith("DEPLOY "))).toHaveLength(2);
  expect(readSourceStatus(f.dir)?.sources.emit).toMatchObject({ type: "builtin", events: 2, duplicates: 2, lastKind: "DEPLOY", lastEventAt: T0 });
});

test("a poll source runs its command every everySec and journals each matching line once, by its capture group", async () => {
  let out = "101 green\nnoise\n102 red\n";
  const calls: (readonly string[])[] = [];
  const f = fixture({ BUILD: "engine-only", "BUILD * red": "owner-only" }, async (argv) => { calls.push(argv); return ok(out); });
  new SourceSpecs(f.dir).add({ name: "ci", type: "poll", kind: "BUILD", command: ["ci-status"], everySec: 60, match: "^(\\d+) " });
  await f.sources.tick();
  expect(f.events().filter((event) => event.line.startsWith("BUILD ")).map((event) => event.line)).toEqual(["BUILD 101 green", "BUILD 102 red"]);
  // The policy table decides per kind: `BUILD * red` reaches the owner, plain BUILD stays engine-only.
  expect(await f.settled()).toEqual(["BUILD 102 red"]);
  // Not due yet: no second run.
  await f.sources.tick();
  expect(calls).toHaveLength(1);
  // Due again: build 102's line changed but its capture group did not, so it is a duplicate; 103 is new.
  f.clock.at += 60_000;
  out = "102 red (rerun)\n103 green\n";
  await f.sources.tick();
  expect(calls).toHaveLength(2);
  expect(f.events().filter((event) => event.line.startsWith("BUILD ")).map((event) => event.line)).toEqual(["BUILD 101 green", "BUILD 102 red", "BUILD 103 green"]);
  expect(readSourceStatus(f.dir)?.sources.ci).toMatchObject({ type: "poll", events: 3, duplicates: 1, lastKind: "BUILD" });
});

test("a file source tails from the end at first sight, journals new matching lines once and follows a truncation", async () => {
  const f = fixture({ ALERT: "owner-only" });
  const log = join(f.dir, "app.log");
  writeFileSync(log, "ERROR old, before the source existed\n");
  new SourceSpecs(f.dir).add({ name: "app-log", type: "file", kind: "ALERT", path: log, match: "ERROR" });
  await f.sources.tick();
  expect(f.events()).toEqual([]);
  appendFileSync(log, "info fine\nERROR disk full\nERROR half a li");
  await f.sources.tick();
  appendFileSync(log, "ne\n");
  await f.sources.tick();
  // A restart re-reads nothing: the cursor is in the status file and the ids dedupe a replay.
  const again = new EventSources({ stateDir: f.dir, enqueue: (id, line) => f.supervisor.enqueue(id, line), now: f.clock.now, run: async () => ok() });
  await again.tick();
  again.close();
  writeFileSync(log, "ERROR after rotation\n");
  await f.sources.tick();
  expect(f.events().map((event) => event.line)).toEqual(["ALERT ERROR disk full", "ALERT ERROR half a line", "ALERT ERROR after rotation"]);
  expect(await f.settled()).toEqual(["ALERT ERROR disk full", "ALERT ERROR half a line", "ALERT ERROR after rotation"]);
  expect(readSourceStatus(f.dir)?.sources["app-log"]?.cursor).toEqual({ path: log, offset: statSync(log).size });
});

const freePort = (): number => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
};

test("a webhook source accepts a POST with its secret on 127.0.0.1 only, dedupes by id and refuses a wrong secret", async () => {
  const f = fixture({ HOOK: "owner-only" });
  const port = freePort();
  const secret = "s3cret-s3cret-s3cret";
  new SourceSpecs(f.dir).add({ name: "hook", type: "webhook", kind: "HOOK", port, secret });
  await f.sources.tick();
  const url = `http://127.0.0.1:${port}/`;
  const post = (body: string, headers: Record<string, string>) => fetch(url, { method: "POST", body, headers });
  const first = await post(JSON.stringify({ text: "release v1 published", id: "r1" }), { "x-dori-secret": secret });
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ ok: true, duplicate: false });
  const repeat = await post(JSON.stringify({ text: "release v1 published", id: "r1" }), { "x-dori-secret": secret });
  expect(await repeat.json()).toEqual({ ok: true, duplicate: true });
  expect((await post(JSON.stringify({ text: "forged" }), { "x-dori-secret": "wrong-wrong-wrong-wrong" })).status).toBe(401);
  expect((await post(JSON.stringify({ text: "unsigned" }), {})).status).toBe(401);
  // GitHub-style HMAC signature of the body, deduped by X-GitHub-Delivery.
  const body = JSON.stringify({ action: "published" });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect((await post(body, { "x-hub-signature-256": signature, "x-github-delivery": "d-1" })).status).toBe(202);
  expect((await fetch(url)).status).toBe(405);
  expect(f.events().map((event) => [event.id, event.line])).toEqual([
    ["src:hook:r1", "HOOK release v1 published"],
    ["src:hook:d-1", `HOOK ${body}`],
  ]);
  expect(await f.settled()).toEqual(["HOOK release v1 published", `HOOK ${body}`]);
  f.sources.save();
  expect(readSourceStatus(f.dir)?.sources.hook).toMatchObject({ events: 2, duplicates: 1, rejected: 2 });
  // Removing the source stops its listener.
  new SourceSpecs(f.dir).remove("hook");
  await f.sources.tick();
  expect(await fetch(url, { method: "POST", body: "x" }).then(() => "open", () => "closed")).toBe("closed");
});

test("a failing source is isolated: the others keep delivering, it is reported once and shown in dori status", async () => {
  let broken = true;
  const f = fixture({}, async (argv) => argv[0] === "bad" ? (broken ? { code: 2, out: "", err: "boom: no such host" } : ok("")) : ok("GOOD 1"));
  const specs = new SourceSpecs(f.dir);
  specs.add({ name: "bad", type: "poll", kind: "BAD", command: ["bad"], everySec: 5, match: "." });
  specs.add({ name: "good", type: "poll", kind: "GOOD", command: ["good"], everySec: 5, match: "^GOOD (\\d+)" });
  specs.add({ name: "missing", type: "file", kind: "MISSING", path: join(f.dir, "nope.log"), match: "." });
  await f.sources.tick();
  f.clock.at += 5_000;
  await f.sources.tick();
  const lines = f.events().map((event) => event.line);
  expect(lines.filter((line) => line.startsWith("GOOD "))).toEqual(["GOOD GOOD 1"]);
  // One SOURCE_FAILED per source when it starts failing, not one per pass.
  const failed = lines.filter((line) => line.startsWith("SOURCE_FAILED ")).sort();
  expect(failed).toHaveLength(2);
  expect(failed[0]).toBe("SOURCE_FAILED bad poll: bad exited 2: boom: no such host; the other sources keep running (dori source list)");
  expect(failed[1]).toStartWith("SOURCE_FAILED missing file: ENOENT");
  const status = await collectStatus({ ...f.deps, run: async () => ok("active") });
  const text = renderStatus(status);
  expect(text).toContain("source bad failing");
  expect(text).toMatch(/sources: discord -, github -, sweeps -, waits -, emit -, bad\(poll\) - !failing, good\(poll\) GOOD just now, missing\(file\) - !failing/);
  // Recovered: no longer failing, and its last error stays visible.
  broken = false;
  f.clock.at += 5_000;
  await f.sources.tick();
  expect(readSourceStatus(f.dir)?.sources.bad?.failing).toBeUndefined();
  expect(readSourceStatus(f.dir)?.sources.bad?.lastError).toContain("boom");
});

test("built-ins record their events and errors through the registry; a source cannot use a built-in kind", async () => {
  const f = fixture({});
  expect(f.sources.enqueueFor("waits")("wait:1", "WAIT_DONE pr-1 merged")).toBe(true);
  expect(f.sources.enqueueFor("waits")("wait:1", "WAIT_DONE pr-1 merged")).toBe(false);
  await expect(f.sources.guard("github", Promise.reject(new Error("gh: rate limited")))).rejects.toThrow("rate limited");
  f.sources.save();
  const view = sourceViews(f.dir).sources;
  expect(view.find((s) => s.name === "waits")).toMatchObject({ events: 1, duplicates: 1, lastKind: "WAIT_DONE" });
  expect(view.find((s) => s.name === "github")).toMatchObject({ failing: true, lastError: "gh: rate limited" });
  // A built-in failure is shown, not journaled (it reports itself as before).
  expect(f.events().map((event) => event.line)).toEqual(["WAIT_DONE pr-1 merged"]);
  for (const kind of ["INBOUND", "LANE_DONE_CLAIMED", "WAIT_DONE", "GH_PR", "SOURCE_FAILED", "lower"]) {
    expect(() => queueEmit(f.dir, kind, "x", T0)).toThrow(SourceError);
    expect(() => validateSpec({ name: "x", type: "file", kind, path: "/tmp/x", match: "." })).toThrow(SourceError);
  }
});

test.each([
  [{ name: "github", type: "file", kind: "X1", path: "/x", match: "." }, "built-in source"],
  [{ name: "p", type: "poll", kind: "P1", command: [], everySec: 60, match: "." }, "argv array"],
  [{ name: "p", type: "poll", kind: "P1", command: ["x"], everySec: 1, match: "." }, "everySec"],
  [{ name: "p", type: "poll", kind: "P1", command: ["x"], everySec: 60, match: "(" }, "regular expression"],
  [{ name: "w", type: "webhook", kind: "W1", port: 80, secret: "s".repeat(16) }, "port"],
  [{ name: "w", type: "webhook", kind: "W1", port: 9000, secret: "short" }, "secret"],
  [{ name: "f", type: "file", kind: "F1", path: "relative.log", match: "." }, "absolute"],
  [{ name: "Bad Name", type: "file", kind: "F1", path: "/x", match: "." }, "source name"],
  [{ name: "t", type: "tcp", kind: "T1" }, "type must be one of"],
])("a malformed source %j is refused", (raw, text) => {
  expect(() => validateSpec(raw)).toThrow(text);
});

test("sources.json is owner-only, refuses duplicate names and ports, and list never shows a webhook secret", () => {
  const state = withState();
  cleanups.push(state.done);
  const specs = new SourceSpecs(state.dir);
  const hook = specs.add({ name: "hook", type: "webhook", kind: "HOOK", port: 9100, secret: "x".repeat(20) });
  expect(statSync(specs.path).mode & 0o777).toBe(0o600);
  expect(() => specs.add({ name: "hook", type: "file", kind: "F1", path: "/x", match: "." })).toThrow("already exists");
  expect(() => specs.add({ name: "hook2", type: "webhook", kind: "HOOK", port: 9100, secret: "y".repeat(20) })).toThrow("port 9100");
  expect(JSON.stringify(publicSpec(hook))).not.toContain("xxxx");
  expect(specs.remove("hook")).toBe(true);
  expect(specs.remove("hook")).toBe(false);
  expect(specs.list()).toEqual([]);
});

test("the real supervisor runs the built-ins and the user sources through the registry; a failing source leaves the rest working", async () => {
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
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  cleanups.push(() => { console.error = error; });
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ id: "33" }), { status: 200 }), { preconnect: fetch.preconnect }));
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, clock, state.dir, {
    discord: { applicationId: "100", guildId: "200", ownerId: "123456789012345" }, discordChannels: ["11"], defaultModel: "test/model",
  });
  const deps = {
    ...base,
    run: async (argv: readonly string[]): Promise<Ran> => {
      if (argv[0] === "df") return ok("Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200");
      if (argv[0] === "broken-poll") return { code: 1, out: "", err: "unreachable" };
      return base.run(argv);
    },
  };
  new Waits(state.dir).register({ key: "pr-1", until: "merged acme/app#1", note: "watch the PR", cwd: state.dir }, T0);
  new SourceSpecs(state.dir).add({ name: "broken", type: "poll", kind: "BROKEN", command: ["broken-poll"], everySec: 5, match: "." });
  queueEmit(state.dir, "DEPLOY", "web v3", T0, "deploy-3");
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
    token: `event-sources-test-${state.dir}`,
    http: async (request) => ({ status: 200, headers: {}, body: request.url.endsWith("/threads/active") ? JSON.stringify({ threads: [] }) : "[]" }),
    lookup: async () => "", statusLookup: async () => "",
    open: () => {
      let closed = (_code: number) => {};
      return { send: () => {}, close: () => { closed(1000); }, onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; } };
    },
    timers: { setInterval: () => 0, clearInterval: () => {} },
  }, async () => true, undefined, pause);
  const done = () => {
    const s = readSourceStatus(state.dir)?.sources;
    return s?.waits?.lastKind === "WAIT_DONE" && s.emit?.lastKind === "DEPLOY" && s.broken?.failing === true;
  };
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
  expect(lines).toContain("DEPLOY web v3");
  expect(lines.some((line: string) => line.startsWith("WAIT_DONE pr-1 "))).toBe(true);
  expect(lines.filter((line: string) => line.startsWith("SOURCE_FAILED broken "))).toHaveLength(1);
  expect(errors.some((line) => line.startsWith("SOURCE_ERROR broken "))).toBe(true);
  expect(existsSync(join(state.dir, EMIT_DIR)) ? readdirSync(join(state.dir, EMIT_DIR)) : []).toEqual([]);
}, 30_000);
