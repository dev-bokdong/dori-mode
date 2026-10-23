import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { adoptLane, LaunchError } from "../src/launch.ts";
import { closedLaneKeys } from "../src/memory-check.ts";
import { type Lane, Registry, statusOf, withStatus } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "none", pane: `${key}:p1`, brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), ...patch });
const closed = (key: string): Lane => withStatus(lane(key), "closed", "done", new Date(T0).toISOString(), { closedAt: new Date(T0).toISOString() });

test("with 1,000 closed lanes on disk, open() reads only the open lanes", async () => {
  const registry = new Registry(state.dir);
  for (const key of ["open-a", "open-b", "open-c"]) await registry.write(lane(key));
  mkdirSync(registry.archiveDir, { recursive: true });
  // Unparseable on purpose: open() fails if it reads any archived file.
  for (let i = 0; i < 1_000; i++) writeFileSync(join(registry.archiveDir, `closed-${i}.json`), "{not json");
  expect((await registry.open()).map((l) => l.key).sort()).toEqual(["open-a", "open-b", "open-c"]);
  expect(registry.archivedKeys()).toHaveLength(1_000);
});

test("closing a lane moves its file to the archive, where read, update and patch still find it", async () => {
  const registry = new Registry(state.dir);
  await registry.write(lane("done-lane"));
  await registry.update("done-lane", (current) => current ? withStatus(current, "closed", "done", new Date(T0).toISOString(), { closedAt: new Date(T0).toISOString() }) : undefined);
  expect(existsSync(registry.path("done-lane"))).toBe(false);
  expect(existsSync(registry.archivePath("done-lane"))).toBe(true);
  expect(await registry.open()).toEqual([]);
  const read = await registry.read("done-lane");
  expect(read && statusOf(read)).toBe("closed");
  const patched = await registry.patch("done-lane", { lastFreshnessNote: "kept" });
  expect(patched?.version).toBe((read?.version ?? 0) + 1);
  expect(existsSync(registry.path("done-lane"))).toBe(false);
  expect((await registry.read("done-lane"))?.lastFreshnessNote).toBe("kept");
  expect((await registry.list()).map((l) => l.key)).toEqual(["done-lane"]);
});

test("the old layout migrates: closed files in lanes/ are archived and lanes-closed/ moves verbatim to lanes-archive/legacy", async () => {
  const lanesDir = join(state.dir, "lanes");
  const oldClosed = join(state.dir, "lanes-closed");
  mkdirSync(lanesDir, { recursive: true });
  mkdirSync(oldClosed, { recursive: true });
  writeFileSync(join(lanesDir, "old-closed.json"), JSON.stringify(closed("old-closed")));
  writeFileSync(join(lanesDir, "still-open.json"), JSON.stringify(lane("still-open")));
  writeFileSync(join(oldClosed, "hsj-dead.json.dead-20261022"), JSON.stringify(lane("hsj-dead")));
  writeFileSync(join(oldClosed, "still-open.json.old"), JSON.stringify(lane("still-open")));
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  expect((await deps.registry.open()).map((l) => l.key)).toEqual(["still-open"]);
  expect(readdirSync(lanesDir).filter((f) => f.endsWith(".json"))).toEqual(["still-open.json"]);
  expect(existsSync(oldClosed)).toBe(false);
  expect(readdirSync(deps.registry.legacyDir).sort()).toEqual(["hsj-dead.json.dead-20261022", "still-open.json.old"]);
  expect((await deps.registry.read("old-closed"))?.closedAt).toBeDefined();
  await expect(adoptLane(deps, { key: "old-closed", title: "again", brief: "/b.md", done: "merged acme/app#2", pane: "w:p9" })).rejects.toThrow(LaunchError);
  await expect(adoptLane(deps, { key: "old-closed", title: "again", brief: "/b.md", done: "merged acme/app#2", pane: "w:p9" })).rejects.toThrow("already registered");
  expect(await closedLaneKeys(deps)).toEqual(["hsj-dead", "old-closed"]);
});
