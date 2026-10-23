import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "../src/run.ts";
import { openEpisode } from "../src/emergency.ts";
import { PRE_SQLITE_FILE, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { importStore } from "../src/store-import.ts";
import { EXPORTED_SQLITE_FILE, exportStore } from "../src/store-export.ts";
import { Supervisor } from "../src/supervise.ts";
import { acquireSupervisor } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;

/** A lead pane that is busy, so every due event is appended to the log without a restart. */
const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const run: Runner = async (argv) => {
    if (argv[0] === "herdr" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: world.panes } }), err: "" };
    if (argv[0] === "herdr" && argv[2] === "read") return { code: 0, out: "working", err: "" };
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = (store: "json" | "sqlite") => ({ ...depsFor(world, clock, state.dir, { store }), run });
  const log = (): { id: string; line: string }[] =>
    readFileSync(join(state.dir, "lead-events.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const open = (store: "json" | "sqlite") => {
    const supervisor = new Supervisor(deps(store));
    cleanups.unshift(() => supervisor.close());
    return supervisor;
  };
  return { state, clock, log, open };
};

test("10,000 synthetic enqueues on the sqlite store take under 5 s, dedupe, and reload after a restart", () => {
  const f = fixture();
  const supervisor = f.open("sqlite");
  // Given today's traffic shape: mostly digest GitHub and sweep lines, one owner message in twenty.
  const line = (i: number) => i % 20 === 0 ? `INBOUND 11 ${i} owner message ${i}` : i % 3 ? `GH_PR o/r#${i} checks_green https://github.com/o/r/pull/${i}` : `LANE_WARN lane-${i % 100} quiet`;
  const id = (i: number) => (i % 20 === 0 ? `discord:11:${i}` : `synthetic:${i}`);
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) supervisor.enqueue(id(i), line(i));
  const elapsed = performance.now() - started;
  // Then the enqueues fit the budget, a repeat of every id adds nothing, and a new process sees all of them.
  console.log(`STORE_BENCH 10000 enqueues ${Math.round(elapsed)} ms`);
  expect(elapsed).toBeLessThan(5_000);
  for (let i = 0; i < 10_000; i += 7) supervisor.enqueue(id(i), "duplicate");
  supervisor.close();
  const store = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  const journal = store.read(false);
  store.close();
  expect(journal.events).toHaveLength(10_000);
  expect(journal.events.some((event) => event.line === "duplicate")).toBe(false);
  expect(journal.awaitingAck).toHaveLength(500);
  const after = f.open("sqlite");
  after.enqueue(id(0), "duplicate");
  after.close();
  const reread = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  expect(reread.counts().events).toBe(10_000);
  reread.close();
});

test("a restart after the import delivers nothing twice and still delivers what was pending", async () => {
  const f = fixture();
  // Given a json supervisor that delivered two events and has a third still queued.
  const before = f.open("json");
  before.enqueue("discord:11:1", "INBOUND 11 1 owner hello");
  before.enqueue("report:a", "LANE_REPORT alpha milestone");
  await before.flush();
  before.enqueue("report:b", "LANE_REPORT beta question");
  before.close();
  expect(f.log().map((event) => event.id)).toEqual(["discord:11:1", "report:a"]);
  const journal = readFileSync(join(f.state.dir, "supervisor.json"));
  // When it is imported under the barrier and the supervisor restarts on the store, twice.
  const report = importStore(f.state.dir, f.clock.now());
  expect(report.sources.log.lines).toBe(2);
  expect(report.counts.events).toBe(3);
  expect(report.counts.deliveries).toBe(2);
  for (let restart = 0; restart < 2; restart++) {
    const after = f.open("sqlite");
    after.enqueue("discord:11:1", "INBOUND 11 1 owner hello");
    after.enqueue("report:a", "LANE_REPORT alpha milestone");
    await after.flush();
    after.close();
  }
  // Then only the queued event was appended, once, and the source journal is kept read-only for audit.
  expect(f.log().map((event) => event.id)).toEqual(["discord:11:1", "report:a", "report:b"]);
  expect(existsSync(join(f.state.dir, "supervisor.json"))).toBe(false);
  expect(readFileSync(join(f.state.dir, PRE_SQLITE_FILE))).toEqual(journal);
  expect(statSync(join(f.state.dir, PRE_SQLITE_FILE)).mode & 0o777).toBe(0o400);
});

test("a delivery whose store row was lost is recovered from the log tail, not appended again", async () => {
  const f = fixture();
  const supervisor = f.open("sqlite");
  supervisor.enqueue("report:a", "LANE_REPORT alpha question which base?");
  await supervisor.flush();
  supervisor.close();
  // Given a crash after the log append but before the delivery row: the row and cursor are gone.
  const db = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  db.transaction("full", () => { db.setMeta("log_offset", "0"); });
  db.close();
  const raw = new (await import("bun:sqlite")).Database(join(f.state.dir, SQLITE_FILE));
  raw.exec("DELETE FROM deliveries");
  raw.close();
  // When the supervisor restarts and flushes.
  const after = f.open("sqlite");
  await after.flush();
  after.close();
  // Then the event is known delivered from the log and is not appended a second time.
  expect(f.log().map((event) => event.id)).toEqual(["report:a"]);
  const check = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  expect(check.deliveredIds()).toEqual(new Set(["report:a"]));
  expect(check.logCursor()).toBe(statSync(join(f.state.dir, "lead-events.log")).size);
  check.close();
});

test("the import carries every journal field and reads it back unchanged", () => {
  const state = withState();
  cleanups.push(state.done);
  // Given a journal with every mapped field set, and one event from before enqueue times existed.
  const journal = {
    events: [{ id: "old", line: "LANE_REPORT old" }, { id: "discord:11:2", line: "INBOUND 11 2 hi", at: T0 }, { id: "discord:11:2:edit:9", line: "INBOUND_EDIT 11 2 hi again", at: T0 + 1 }],
    awaitingAck: [
      { id: "discord:11:2", since: T0, reminded: true, noticed: true, ackedAt: T0 + 5, tasks: 2, lanes: ["alpha"], reply: false, handlingSince: T0 + 6, unhandledRemindedAt: T0 + 7, revision: "discord:11:2:edit:9", revisions: ["discord:11:2:edit:9"] },
      { id: "discord:11:3", handledAt: T0 + 9, deleted: true, revisions: ["discord:11:3:delete"] },
    ],
    notifications: { "delay:discord:11:2": { attempts: 1 }, "ack:discord:11:2": { attempts: 3, sent: true } },
    noticed: ["discord:11:2"],
    closedOwners: ["discord:11:0", "discord:11:0:edit:1"],
    outbox: [{ id: "lead-model:s", text: "switched", attempts: 2, retryAt: T0 + 60_000 }],
    restart: { session: "s-1", events: [{ id: "old", line: "LANE_REPORT old" }], offset: 12, phase: "submitted", strikes: 1, unconfirmed: 2, modelIndex: 1, reason: "quota", request: { id: "r", at: T0, models: [{ model: "a/b" }] }, force: true },
    leadModel: 1, primaryRetryAt: T0 + 1, primaryClearChecks: 1, quotaExhausted: { since: T0, model: "a/b", resetAt: T0 + 3_600_000 },
    models: [{ model: "a/b", thinking: "high" }], quotaStallSince: T0, leadBusySince: T0 + 2, leadScreen: { hash: "ab", since: T0 }, emergencyEpisode: T0,
  };
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify(journal));
  writeFileSync(join(state.dir, "lead-events.log"), `${JSON.stringify({ id: "old", line: "LANE_REPORT old" })}\n{"id":"partial`);
  // When it is imported.
  const report = importStore(state.dir, T0 + 100);
  // Then the read-back equals the source, the stamped time is flagged, and readers outside the supervisor see the store.
  const store = new SqliteStore(join(state.dir, SQLITE_FILE));
  expect(store.read(true)).toEqual(journal as never);
  expect(store.read(false).events[0]).toEqual({ id: "old", line: "LANE_REPORT old", at: T0 + 100 });
  expect(store.deliveredIds()).toEqual(new Set(["old"]));
  store.close();
  expect(report.syntheticAt).toBe(1);
  expect(report.sources.log.lines).toBe(1);
  expect(openEpisode(state.dir)).toBe(T0);
});

test("the import refuses while a supervisor runs, or a journal field it cannot map, and changes nothing", () => {
  const state = withState();
  cleanups.push(state.done);
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [], futureField: 1 }));
  const release = acquireSupervisor(state.dir);
  try {
    expect(() => importStore(state.dir, T0)).toThrow("STORE_SUPERVISOR_RUNNING");
  } finally { release(); }
  expect(() => importStore(state.dir, T0)).toThrow("STORE_IMPORT_UNKNOWN_FIELD");
  expect(existsSync(join(state.dir, "supervisor.json"))).toBe(true);
  expect(existsSync(join(state.dir, SQLITE_FILE))).toBe(false);
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  importStore(state.dir, T0);
  expect(() => importStore(state.dir, T0)).toThrow("STORE_EXISTS");
});

test("round trip: import, new owner message, edit, delete, completed wait and lane report, export; the json code loses and duplicates nothing", async () => {
  const f = fixture();
  // Given a json state dir with one delivered owner message and lane report, imported under the barrier.
  const before = f.open("json");
  before.enqueue("discord:11:1", "INBOUND 11 1 owner first");
  before.enqueue("report:a", "LANE_REPORT alpha milestone");
  await before.flush();
  before.close();
  importStore(f.state.dir, f.clock.now());
  // When the sqlite supervisor gets a new owner message, an edit of it, a delete of the first, a completed wait and a
  // lane report (all delivered), plus one more report still queued at the export.
  const events: [string, string][] = [
    ["discord:11:2", "INBOUND 11 2 owner second"],
    ["discord:11:2:edit:2026-10-22T01:00:00.000000+00:00", "INBOUND_EDIT 11 2 owner (owner edited an earlier message; this text replaces it) second, edited"],
    ["discord:11:1:delete", "INBOUND_DELETE 11 1 (owner deleted an earlier message; disregard it unless already acted on)"],
    ["wait:w1", "WAIT_DONE release ci green"],
    ["report:b", "LANE_REPORT beta question"],
  ];
  const sqlite = f.open("sqlite");
  for (const [id, line] of events) sqlite.enqueue(id, line);
  await sqlite.flush();
  sqlite.enqueue("report:c", "LANE_REPORT gamma blocker");
  sqlite.close();
  const stored = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  const snapshot = stored.read(false);
  stored.close();
  // The sqlite supervisor kept appending the compatibility log.
  expect(f.log().map((event) => event.id)).toEqual(["discord:11:1", "report:a", ...events.map(([id]) => id)]);
  const report = exportStore(f.state.dir, f.clock.now());
  expect(report.files.log.appended).toBe(0);
  expect(report.cursors.logOffset).toBe(statSync(join(f.state.dir, "lead-events.log")).size);
  expect(existsSync(join(f.state.dir, SQLITE_FILE))).toBe(false);
  expect(statSync(join(f.state.dir, EXPORTED_SQLITE_FILE)).mode & 0o777).toBe(0o400);
  expect(existsSync(join(f.state.dir, "github-events.json"))).toBe(true);
  // Then the json supervisor on the exported files, fed every source id again, delivers the queued report once and
  // nothing twice, and keeps every event and every owner row.
  const after = f.open("json");
  for (const [id, line] of [["discord:11:1", "INBOUND 11 1 owner first"], ["report:a", "LANE_REPORT alpha milestone"], ...events, ["report:c", "LANE_REPORT gamma blocker"]]) after.enqueue(id as string, line as string);
  await after.flush();
  after.close();
  const all = ["discord:11:1", "report:a", ...events.map(([id]) => id), "report:c"];
  expect(f.log().map((event) => event.id)).toEqual(all);
  const journal = JSON.parse(readFileSync(join(f.state.dir, "supervisor.json"), "utf8"));
  expect(journal.events.map((event: { id: string }) => event.id)).toEqual(all);
  expect(journal.awaitingAck).toEqual(snapshot.awaitingAck);
  const owners = new Map((journal.awaitingAck as { id: string; deleted?: true; revision?: string; revisions?: string[] }[]).map((entry) => [entry.id, entry]));
  expect(owners.get("discord:11:1")).toMatchObject({ deleted: true, revisions: ["discord:11:1:delete"] });
  expect(owners.get("discord:11:2")).toMatchObject({ revision: events[1]?.[0], revisions: [events[1]?.[0]] });
});

test("the export refuses while a supervisor runs or after the state dir is json again, and changes nothing", () => {
  const state = withState();
  cleanups.push(state.done);
  writeFileSync(join(state.dir, "supervisor.json"), JSON.stringify({ events: [{ id: "a", line: "LANE_REPORT a", at: T0 }] }));
  importStore(state.dir, T0);
  const database = readFileSync(join(state.dir, SQLITE_FILE));
  const release = acquireSupervisor(state.dir);
  try {
    expect(() => exportStore(state.dir, T0)).toThrow("STORE_SUPERVISOR_RUNNING");
  } finally { release(); }
  expect(readFileSync(join(state.dir, SQLITE_FILE))).toEqual(database);
  expect(existsSync(join(state.dir, "supervisor.json"))).toBe(false);
  exportStore(state.dir, T0);
  expect(() => exportStore(state.dir, T0)).toThrow("STORE_EXPORT_EXISTS");
  expect(JSON.parse(readFileSync(join(state.dir, "supervisor.json"), "utf8")).events).toEqual([{ id: "a", line: "LANE_REPORT a", at: T0 }]);
});

test("a supervisor refuses a state dir that belongs to the other store", () => {
  const f = fixture();
  writeFileSync(join(f.state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  expect(() => f.open("sqlite")).toThrow("STORE_IMPORT_PENDING");
  importStore(f.state.dir, T0);
  expect(() => f.open("json")).toThrow("STORE_MISMATCH");
});
