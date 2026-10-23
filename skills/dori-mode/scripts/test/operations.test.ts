import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Http } from "../src/messenger/http.ts";
import { type Observed, openOperations, type OperationStore, OPERATIONS_FILE, perform } from "../src/operations.ts";
import type { Lane } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { exportStore } from "../src/store-export.ts";
import { importStore } from "../src/store-import.ts";
import { depsFor, fakeClock, newWorld, TEST_STORE, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

// Every test opens a fresh state dir and a journal store (sqlite create/WAL, fsync'd writes, import/export file moves). On a
// CI runner shared with `bun test --parallel` workers that disk I/O can stall past 5 s; there is no event to wait on, so the
// budget only bounds a hang, it does not pace the test.
setDefaultTimeout(30_000);
const spec = { lane: "demo-lane", action: "pane-close", target: "w:p1" };

let state: ReturnType<typeof withState>;
let store: OperationStore;
let ran: number;
let world: Observed;
const now = () => T0;
const effect = async () => { ran++; world = "done"; return { ok: true, detail: "" }; };
const readBack = async () => world;

beforeEach(() => {
  state = withState();
  if (TEST_STORE === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  store = openOperations({ stateDir: state.dir, store: TEST_STORE });
  ran = 0;
  world = "not-done";
});
afterEach(() => { store.close(); state.done(); });

test("a verified operation never runs its effect again", async () => {
  expect((await perform(store, now, spec, effect, readBack)).op.state).toBe("verified");
  world = "not-done";
  const again = await perform(store, now, spec, effect, readBack);
  expect({ state: again.op.state, ran: again.ran, effects: ran }).toEqual({ state: "verified", ran: false, effects: 1 });
});

test("an attempted row left by a crash is reconciled by read-back: done verifies, not done retries once, unknown is ambiguous", async () => {
  const attempted = { id: "demo-lane/pane-close/w:p1", ...spec, state: "attempted" as const, detail: "attempted", attempts: 1, at: T0, updatedAt: T0 };
  store.put(attempted);
  world = "done";
  expect(await perform(store, now, spec, effect, readBack)).toMatchObject({ op: { state: "verified", attempts: 1 }, ran: false });

  store.put(attempted);
  world = "not-done";
  expect(await perform(store, now, spec, effect, readBack)).toMatchObject({ op: { state: "verified", attempts: 2 }, ran: true });
  expect(ran).toBe(1);

  store.put(attempted);
  world = "unknown";
  expect(await perform(store, now, spec, effect, async () => "unknown")).toMatchObject({ op: { state: "ambiguous" }, ran: false });
  expect(await perform(store, now, spec, effect, async () => "done")).toMatchObject({ op: { state: "ambiguous" }, ran: false });
  expect(ran).toBe(1);
});

test("an effect that fails while the read-back shows it not done is failed, and a later call may retry it", async () => {
  const failing = async () => { ran++; return { ok: false, detail: "pane busy" }; };
  expect((await perform(store, now, spec, failing, readBack)).op).toMatchObject({ state: "failed", detail: "read back not-done: pane busy" });
  expect((await perform(store, now, spec, effect, readBack)).op.state).toBe("verified");
  expect(ran).toBe(2);
});

test("operations survive a store import and export with their states", async () => {
  if (TEST_STORE === "sqlite") return;
  await perform(store, now, spec, effect, readBack);
  await perform(store, now, { ...spec, action: "thread-done", target: "discord:1/2" }, effect, async () => "unknown");
  const before = store.list();
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  importStore(state.dir, T0, () => () => {});
  expect(existsSync(join(state.dir, OPERATIONS_FILE))).toBe(false);
  const imported = openOperations({ stateDir: state.dir, store: "sqlite" });
  try { expect(imported.list()).toEqual(before); } finally { imported.close(); }
  exportStore(state.dir, T0, () => () => {});
  const exported = openOperations({ stateDir: state.dir, store: "json" });
  expect(exported.list()).toEqual(before);
});

test("a close records its effects and a second close of the same lane repeats none of them", async () => {
  const w: World = newWorld();
  w.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  const base = depsFor(w, fakeClock(T0), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
  const run: typeof base.run = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "close") w.panes = w.panes.filter((p) => p.pane_id !== argv[3]);
    return base.run(argv, opts);
  };
  let removed = false;
  const deps = { ...base, run, exists: () => !removed };
  const lane: Lane = { key: "demo-lane", title: "demo", thread: "discord:111/222", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await deps.registry.write(lane);
  const removing: typeof run = async (argv, opts) => { if (argv.includes("remove")) removed = true; return run(argv, opts); };
  const first = await closeLane({ ...deps, run: removing }, lane, "manual");
  expect(first.closed).toBe(true);
  const effects = () => w.calls.filter((c) => c.includes("remove") || c[0] === "notify" || c[2] === "close").length;
  expect(effects()).toBe(3);
  expect(store.list().map((op) => `${op.action} ${op.state}`).sort()).toEqual(["close verified", "pane-close verified", "thread-done verified", "worktree-remove verified"]);
  const second = await closeLane({ ...deps, run: removing }, lane, "manual");
  expect(second).toEqual({ closed: true, lines: ["CLOSED demo-lane already closed"] });
  expect(effects()).toBe(3);
});

/** A fake Discord API behind the real client: threads by id with their archived flag; every request is recorded. */
const fakeDiscord = (threads: Record<string, boolean>) => {
  const calls: string[] = [];
  const http: Http = async (req) => {
    const id = req.url.split("/channels/")[1] ?? "";
    calls.push(`${req.method} ${id}${req.body ? ` ${req.body}` : ""}`);
    if (!(id in threads)) return { status: 404, headers: {}, body: JSON.stringify({ message: "Unknown Channel" }) };
    if (req.method === "PATCH") threads[id] = (JSON.parse(String(req.body)) as { archived: boolean }).archived;
    return { status: 200, headers: {}, body: JSON.stringify({ id, type: 11, thread_metadata: { archived: threads[id], locked: false } }) };
  };
  return { calls, discord: new Discord(http, fakeClock(T0), "bot") };
};

const threadLane = (key: string): Lane => ({ key, title: key, thread: "discord:111/222", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString() });

test("a close archives the lane's thread, reads it back archived and never archives it twice", async () => {
  const { calls, discord } = fakeDiscord({ "222": false });
  const deps = { ...depsFor(newWorld(), fakeClock(T0), state.dir, {}), discord };
  const lane = threadLane("lane-a");
  await deps.registry.write(lane);
  const first = await closeLane(deps, lane, "manual");
  expect(first.closed).toBe(true);
  expect(first.lines.at(-1)).toContain("thread 222 archived");
  expect(calls).toEqual(["GET 222", "PATCH 222 {\"archived\":true}", "GET 222", "GET 222"]);
  expect(store.get("lane-a/thread-archive/222")?.state).toBe("verified");
  await closeLane(deps, lane, "manual");
  expect(calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(1);
});

test("a shared thread stays open until its last lane closes, and a lane in a plain channel makes no Discord call", async () => {
  const { calls, discord } = fakeDiscord({ "222": false });
  const deps = { ...depsFor(newWorld(), fakeClock(T0), state.dir, {}), discord };
  await deps.registry.write(threadLane("lane-a"));
  await deps.registry.write(threadLane("lane-b"));
  const first = await closeLane(deps, threadLane("lane-a"), "manual");
  expect(first.lines.at(-1)).toContain("thread kept open: lane lane-b still works in it");
  expect(calls).toEqual([]);
  const last = await closeLane(deps, threadLane("lane-b"), "manual");
  expect(last.lines.at(-1)).toContain("thread 222 archived");

  const off = fakeDiscord({ "333": false });
  const plain = { ...depsFor(newWorld(), fakeClock(T0), state.dir), discord: off.discord };
  // A lane working in the channel itself (no thread id) has no thread to archive.
  const lane = { ...threadLane("lane-c"), thread: "discord:333" };
  await plain.registry.write(lane);
  expect((await closeLane(plain, lane, "manual")).closed).toBe(true);
  expect(off.calls).toEqual([]);
});

test("an archive interrupted after its attempt is reconciled by read-back, and a refused archive does not stop the close", async () => {
  const { calls, discord } = fakeDiscord({ "222": true });
  const deps = { ...depsFor(newWorld(), fakeClock(T0), state.dir, {}), discord };
  const lane = threadLane("lane-a");
  await deps.registry.write(lane);
  store.put({ id: "lane-a/thread-archive/222", lane: "lane-a", action: "thread-archive", target: "222", state: "attempted", detail: "attempted", attempts: 1, at: T0, updatedAt: T0 });
  expect((await closeLane(deps, lane, "manual")).closed).toBe(true);
  expect(store.get("lane-a/thread-archive/222")).toMatchObject({ state: "verified", attempts: 1 });
  expect(calls.filter((c) => c.startsWith("PATCH"))).toEqual([]);

  // Unknown thread (404): the read-back cannot tell, the effect failed, so the row is failed and the close goes on.
  const gone = fakeDiscord({});
  const other = { ...threadLane("lane-d"), thread: "discord:111/444" };
  await deps.registry.write(other);
  const result = await closeLane({ ...deps, discord: gone.discord }, other, "manual");
  expect(result.closed).toBe(true);
  expect(result.lines.at(-1)).toContain("thread 444 not archived");
  expect(store.get("lane-d/thread-archive/444")?.state).toBe("failed");
});
