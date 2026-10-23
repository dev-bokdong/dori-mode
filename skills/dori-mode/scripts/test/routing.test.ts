import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { canLaunch, enqueueLaunch, idleLaneFor, launchHeld, launchQueue } from "../src/routing.ts";
import { withState } from "./fakes.ts";

const t = defaultConfig("/home/test").guard;
const roomy = { load1: 200, memFreePct: 45, diskFreeGb: 300, swapFreeGb: 2, panes: 6 };

test("a busy CPU alone does not stop a launch; only memory, disk and pane count do", () => {
  expect(canLaunch(roomy, t)).toEqual({ ok: true, reasons: [] });
});

test("low memory, low disk or a full pane budget each hold the launch and say why", () => {
  expect(canLaunch({ ...roomy, memFreePct: 12 }, t).reasons).toEqual(["memory free 12% < 20%"]);
  expect(canLaunch({ ...roomy, diskFreeGb: 9 }, t).reasons).toEqual(["disk free 9 GB < 50 GB"]);
  const both = canLaunch({ ...roomy, panes: 20, diskFreeGb: 9 }, t);
  expect(both.ok).toBe(false);
  expect(both.reasons).toHaveLength(2);
});

test("an idle working lane on the same repo is preferred over opening a new one", () => {
  const lane = (key: string, cwd: string, pane: string, status?: Lane["status"]): Lane => ({ key, title: key, thread: "none", brief: "", done: "", cwd, pane, openedAt: "2026-01-01T00:00:00Z", ...(status ? { status } : {}) });
  const lanes = [lane("busy", "/repo/a", "w:p1"), lane("idle-other", "/repo/b", "w:p2"), lane("claimed", "/repo/a", "w:p3", "done-claimed"), lane("idle-same", "/repo/a", "w:p4")];
  const idle = new Set(["w:p2", "w:p3", "w:p4"]);
  expect(idleLaneFor(lanes, "/repo/a", idle)?.key).toBe("idle-same");
  expect(idleLaneFor(lanes, "/repo/c", idle)).toBeNull();
});

test("a corrupt hold file is moved aside and remains blocked with no queue", () => {
  const state = withState();
  try {
    const path = join(state.dir, "launch-hold.json");
    const original = "{not-json";
    writeFileSync(path, original);
    expect(launchHeld(state.dir)).toBe(true);
    const asideName = readdirSync(state.dir).find((name) => name.startsWith("launch-hold.json.corrupt-"));
    expect(asideName).toBeDefined();
    const aside = join(state.dir, asideName!);
    expect(existsSync(aside)).toBe(true);
    expect(readFileSync(aside, "utf8")).toBe(original);
    expect(launchQueue(state.dir)).toEqual([]);
    enqueueLaunch(state.dir, {
      key: "new", title: "new", done: "done", brief: "brief",
      queuedAt: "2026-01-01T00:00:00Z", reasons: ["held"],
    });
    expect(launchHeld(state.dir)).toBe(true);
    expect(launchQueue(state.dir).map((item) => item.key)).toEqual(["new"]);
  } finally {
    state.done();
  }
});

test("invalid queue entries are dropped while valid entries survive", () => {
  const state = withState();
  try {
    const path = join(state.dir, "launch-hold.json");
    const valid = {
      key: "kept", title: "kept", done: "done", brief: "brief",
      queuedAt: "2026-01-01T00:00:00Z", reasons: ["held"],
    };
    writeFileSync(path, JSON.stringify({ blocked: true, queue: [valid, { key: "bad" }] }));
    expect(launchQueue(state.dir)).toEqual([valid]);
    expect(launchHeld(state.dir)).toBe(true);
  } finally {
    state.done();
  }
});
