import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { freshnessTick } from "../src/freshness.ts";
import { JsonLaneReports, type LaneReportStore, SqliteLaneReports, UNFENCED_GENERATION } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const STORES: readonly (readonly [string, (dir: string) => LaneReportStore])[] = [
  ["json", (dir) => new JsonLaneReports(dir)],
  ["sqlite", (dir) => {
    new SqliteStore(join(dir, SQLITE_FILE), { create: true }).close();
    return new SqliteLaneReports(join(dir, SQLITE_FILE));
  }],
];

const lane = (key: string, pane: string): Lane => ({
  key, title: key, thread: "chat:team/9", pane, brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0,
});

test.each(STORES)("%s store: 100 lanes reporting rows cost the freshness sweep no herdr call; once rows stop for nudgeAfterMin the pane is read again", async (_name, open) => {
  const state = withState();
  cleanups.push(state.done);
  const store = open(state.dir);
  cleanups.push(() => { store.close(); });
  const world = newWorld();
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  for (let i = 0; i < 100; i++) {
    const key = `lane-${i}`;
    await deps(T0).registry.write(lane(key, `w:p${i}`));
    store.append({ lane: key, generation: UNFENCED_GENERATION, kind: "progress", text: `step ${i}`, at: T0 + 10 * MIN });
  }
  // Silent by replies past both nudgeAfterMin (15) and postAfterMin (20), but every lane wrote a row 11 min ago: nothing to read or post.
  expect(await freshnessTick(deps(T0 + 21 * MIN), "/home/test", undefined, store)).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "herdr")).toEqual([]);
  // Without the store the same tick nudges every lane and reads every pane for its last [REPORT] line, as before.
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).filter((a) => a.kind === "nudged")).toHaveLength(100);
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "read")).toHaveLength(100);
});

test("a lane with no row, or whose last row is older than nudgeAfterMin, keeps the screen-based nudge counted from that row", async () => {
  const state = withState();
  cleanups.push(state.done);
  const store = new JsonLaneReports(state.dir);
  const world = newWorld();
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(lane("no-rows", "w:p1"));
  await deps(T0).registry.write(lane("old-row", "w:p2"));
  store.append({ lane: "old-row", generation: UNFENCED_GENERATION, kind: "milestone", text: "tests green", at: T0 + 5 * MIN });
  // 16 min after T0: no-rows is silent; old-row's row is 11 min old, so it is still heard.
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test", undefined, store)).map((a) => `${a.kind} ${a.lane}`)).toEqual(["nudged no-rows"]);
  // 20 min after its row, old-row falls back to the pane and is nudged, its silence counted from the row.
  const acts = await freshnessTick(deps(T0 + 25 * MIN), "/home/test", undefined, store);
  expect(acts.map((a) => `${a.kind} ${a.lane}`)).toEqual(["nudged old-row"]);
  expect(acts[0]?.detail).toStartWith("20 min silent");
});
