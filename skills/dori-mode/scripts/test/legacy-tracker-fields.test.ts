import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { closeLane, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { openOperations, type OperationStore, plan } from "../src/operations.ts";
import type { Lane } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, TEST_STORE, withState, type World } from "./fakes.ts";

// dori-mode once bound lanes to a task tracker (`toodoTask` on the lane, `toodo-reconcile` operation rows). State
// written by those versions must keep working: the field and the rows are inert and never block a close or a pass.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let store: OperationStore;

beforeEach(() => {
  state = withState();
  if (TEST_STORE === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  store = openOperations({ stateDir: state.dir, store: TEST_STORE });
});
afterEach(() => { store.close(); state.done(); });

test("a lane stored with toodoTask and an open toodo-reconcile row from an old version close and pass cleanly", async () => {
  const w: World = newWorld();
  w.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  const base = depsFor(w, fakeClock(T0), state.dir);
  const run: FlowDeps["run"] = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "close") w.panes = w.panes.filter((p) => p.pane_id !== argv[3]);
    return base.run(argv, opts);
  };
  const deps: FlowDeps = { ...base, run, exists: () => false, operations: store };
  const old = { key: "old-lane", title: "old", thread: "none", pane: "w:p1", brief: "/b.md", done: "merged acme/app#7", cwd: "/repo", openedAt: new Date(T0).toISOString(), toodoTask: 211 };
  await deps.registry.write(old as Lane);
  plan(store, T0, { lane: "gone-lane", action: "toodo-reconcile", target: "5" });

  expect((await deps.registry.read("old-lane"))?.key).toBe("old-lane");
  const closed = await closeLane(deps, old as Lane, "Done: merged");
  expect(closed.closed).toBe(true);
  expect(closed.lines.join("\n")).not.toMatch(/toodo/i);
  expect(store.list({ lane: "old-lane" }).map((op) => op.action)).not.toContain("toodo-reconcile");

  const lines = await watchTick(deps);
  expect(lines.filter((l) => l.startsWith("LANE_WATCH_WARN") || l.startsWith("OPERATION_"))).toEqual([]);
  expect(store.list().filter((op) => op.action === "toodo-reconcile").map((op) => op.state)).toEqual(["planned"]);
});
