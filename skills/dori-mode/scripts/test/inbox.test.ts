import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { defaultConfig, deliveryConfigError, loadConfig } from "../src/config.ts";
import { EVENT_LOG, InboxError, readCursorFile, take, takeCursor, takeOutput, takesDir, writeCursorFile } from "../src/inbox.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = (cursor: number | null = 0): string => {
  const s = withState();
  cleanups.push(s.done);
  if (cursor !== null) writeCursorFile(s.dir, cursor);
  return s.dir;
};
const line = (id: string, text: string): string => `${JSON.stringify({ id, line: text })}\n`;
const log = (dir: string, text: string): void => { appendFileSync(join(dir, EVENT_LOG), text); };
const receipts = (dir: string): string[] => (existsSync(takesDir(dir)) ? readdirSync(takesDir(dir)) : []);
const NOW = 1_800_000_000_000;

test("take prints from the cursor to the last complete line and its receipt covers exactly that; a second take is empty", () => {
  const dir = state();
  log(dir, line("a", "WAIT_DONE one") + line("b", "LANE_REPORT k question why?") + '{"id":"c","li');
  const first = take(dir, { maxBytes: 16_384, now: NOW });
  expect(takeOutput(first)).toEqual(["a\tWAIT_DONE one", "b\tLANE_REPORT k question why?"]);
  expect(first.offset).toBe(Buffer.byteLength(line("a", "WAIT_DONE one") + line("b", "LANE_REPORT k question why?")));
  expect(receipts(dir)).toHaveLength(1);
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual(["INBOX_EMPTY"]);
  expect(receipts(dir)).toHaveLength(1);
  // The partial line completes: the next take prints it alone.
  log(dir, 'ne":"WAIT_DONE three"}\n');
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual(["c\tWAIT_DONE three"]);
});

test("a backlog past --max-bytes prints whole lines then INBOX_MORE, the receipt covers only those, and one oversized line goes alone", () => {
  const dir = state();
  const lines = [line("a", "x".repeat(40)), line("b", "y".repeat(40)), line("c", "z".repeat(40))];
  log(dir, lines.join(""));
  const size = Buffer.byteLength(lines[0] ?? "");
  const first = take(dir, { maxBytes: size + 10, now: NOW });
  expect(takeOutput(first)).toEqual([`a\t${"x".repeat(40)}`, `INBOX_MORE 2 ${2 * size}`]);
  expect(first.offset).toBe(size);
  expect(takeOutput(take(dir, { maxBytes: 5, now: NOW }))).toEqual([`b\t${"y".repeat(40)}`, `INBOX_MORE 1 ${size}`]);
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW }))).toEqual([`c\t${"z".repeat(40)}`]);
});

test("--peek prints without a receipt, and without a published cursor take refuses instead of printing the whole log", () => {
  const dir = state();
  log(dir, line("a", "WAIT_DONE one"));
  expect(takeOutput(take(dir, { maxBytes: 16_384, now: NOW, peek: true }))).toEqual(["a\tWAIT_DONE one"]);
  expect(receipts(dir)).toEqual([]);
  const bare = state(null);
  log(bare, line("a", "WAIT_DONE one"));
  expect(() => take(bare, { maxBytes: 16_384, now: NOW })).toThrow(InboxError);
});

test("the take cursor is the max over the cursor file and every receipt, so a crash in the consume order never reprints", () => {
  const dir = state(100);
  mkdirSync(takesDir(dir), { recursive: true });
  // Crash after the store moved but before the cursor file: the receipts still carry the offset.
  writeFileSync(join(takesDir(dir), `${NOW}-b.json`), JSON.stringify({ offset: 150, at: NOW }));
  writeFileSync(join(takesDir(dir), `${NOW + 1}-a.json`), JSON.stringify({ offset: 120, at: NOW + 1 }));
  expect(takeCursor(dir)).toBe(150);
  // Crash after the cursor file but before the receipts were dropped.
  writeCursorFile(dir, 150);
  expect(takeCursor(dir)).toBe(150);
});

test("the supervisor consumes take receipts in every mode: cursor file first, then the receipts are dropped", async () => {
  const s = withState();
  cleanups.push(s.done);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "w", agent: "omo", agent_status: "working" });
  const supervisor = new Supervisor(depsFor(world, fakeClock(NOW), s.dir));
  cleanups.push(() => { supervisor.close(); });
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await supervisor.flush();
  expect(readCursorFile(s.dir)).toBe(0);
  const taken = take(s.dir, { maxBytes: 16_384, now: NOW });
  supervisor.ackTick(60_000);
  expect(readCursorFile(s.dir)).toBe(taken.offset);
  expect(receipts(s.dir)).toEqual([]);
});

test("delivery config: the defaults load, unsafe timings are refused, partial keys keep the defaults", async () => {
  const base = defaultConfig().delivery;
  expect(base.mode).toBe("tail");
  expect(deliveryConfigError(base)).toBeUndefined();
  expect(deliveryConfigError({ ...base, push: { ...base.push, ackSec: 5 } })).toContain("ackSec");
  expect(deliveryConfigError({ ...base, push: { ...base.push, escalateMin: 1, ackSec: 45, retries: 2 } })).toContain("escalateMin");
  expect(deliveryConfigError({ ...base, mode: "loud" as never })).toContain("delivery.mode");
  expect(deliveryConfigError({ ...base, restartMaxPerHour: 0 })).toContain("restartMaxPerHour");
  const dir = state();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ delivery: { mode: "shadow", push: { ackSec: 60, debounceMs: 2000 } } }));
  const loaded = await loadConfig(path, dir);
  expect(loaded.delivery).toEqual({ ...base, mode: "shadow", push: { ...base.push, ackSec: 60 } });
});

test("the sqlite store keeps inbox and forcedRestarts, and a version 3 database is migrated to hold them", () => {
  const dir = state();
  const path = join(dir, SQLITE_FILE);
  const created = new SqliteStore(path, { create: true });
  const db = new Database(path);
  db.exec("ALTER TABLE lead_state DROP COLUMN inbox; ALTER TABLE lead_state DROP COLUMN forced_restarts; UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  db.close();
  created.close();
  const journal = {
    events: [],
    inbox: { takenOffset: 42, mode: "push+tail", sessionSince: NOW, push: { at: NOW, upto: 84, attempts: 2, batch: "b1", first: NOW - 1 } },
    forcedRestarts: [{ at: NOW, cause: "forced" }],
  };
  const store = new SqliteStore(path);
  store.save(journal, "full");
  store.close();
  const reread = new SqliteStore(path);
  const back = reread.read(false);
  reread.close();
  expect({ inbox: back.inbox, forcedRestarts: back.forcedRestarts }).toEqual({ inbox: journal.inbox, forcedRestarts: journal.forcedRestarts });
});
