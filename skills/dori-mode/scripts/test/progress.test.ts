import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { freshnessTick } from "../src/freshness.ts";
import { extractProgress } from "../src/progress.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
// Captured with `herdr pane read <pane> --source recent --lines 60` from a live omo lane pane.
const REAL = readFileSync(new URL("./fixtures/omo-working-todo.txt", import.meta.url), "utf8");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = { key: "busy-lane", title: "busy", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
const posts = () => world.calls.filter((c) => c[0] === "notify").map((c) => c[2] ?? "");

test("the in-progress todo item and elapsed time come from a real captured omo pane", () => {
  expect(extractProgress(REAL)).toEqual({ todo: "Read lane brief dori-lean.md in full", elapsed: "3s" });
});

test("a pane without a Todo block, or without an in-progress item, yields nothing", () => {
  expect(extractProgress("just thinking\n❯ ")).toBeNull();
  expect(extractProgress(REAL.replace(/ Todo[\s\S]*?(?=──)/, ""))).toBeNull();
  expect(extractProgress(REAL.replace("[•]", "[x]"))).toBeNull();
  expect(extractProgress("")).toBeNull();
});

test("a working lane is never nudged: its todo text is posted scrubbed, at once when it changes and again every nudgeAfterMin when it does not", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.screen = REAL;
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["progress"]);
  expect(posts()).toEqual(["Read lane brief dori-lean.md in full"]);
  expect(await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).toEqual([]);
  world.screen = REAL.replace("Read lane brief dori-lean.md in full", "Fix /home/test/repo/x.ts on w3E:p1").replace("(3s", "(40s");
  expect((await freshnessTick(deps(T0 + 18 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["progress"]);
  expect(posts().at(-1)).toBe("Fix ~/repo/x.ts on (pane)");
  // 14 minutes after the last post nothing is posted, and a local lane's pane having no [REPORT] line is no event.
  expect(await freshnessTick(deps(T0 + 32 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 33 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["progress"]);
  expect(posts()).toHaveLength(3);
  expect(sent(world)).toEqual([]);
});

test("progressTemplate shapes the line in the owner's language, with the elapsed time when the status line has one", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.screen = REAL;
  const custom = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] }, progressTemplate: "진행 중: {todo} ({elapsed} 경과)" });
  await freshnessTick(custom, "/home/test");
  expect(posts()).toEqual(["진행 중: Read lane brief dori-lean.md in full (3s 경과)"]);
});

test("a failed progress post is not recorded as posted: it is retried next tick and its error is reported once", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.screen = REAL;
  const at = (ms: number, code: number) => {
    const base = deps(ms);
    return { ...base, run: async (argv: readonly string[]) => argv[0] === "notify" ? (world.calls.push([...argv]), { code, out: "", err: "HTTP 503" }) : base.run(argv) };
  };
  expect(await freshnessTick(at(T0 + 16 * MIN, 1), "/home/test")).toEqual([{ kind: "progress-failed", lane: "busy-lane", detail: "thread hook failed: HTTP 503" }]);
  expect(await freshnessTick(at(T0 + 17 * MIN, 1), "/home/test")).toEqual([]);
  expect((await freshnessTick(at(T0 + 18 * MIN, 0), "/home/test")).map((a) => a.kind)).toEqual(["progress"]);
  expect(posts()).toHaveLength(3);
  expect((await deps(T0).registry.read("busy-lane"))?.lastProgressPost).toBe("Read lane brief dori-lean.md in full");
});

test("a working lane with no Todo block is never interrupted: the lead hears NO-PROGRESS once per silence", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "working" }];
  world.screen = "thinking hard\n❯ ";
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["no-progress"]);
  expect(await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).toEqual([]);
  expect(posts()).toEqual([]);
  expect(sent(world)).toEqual([]);
});

test("an idle silent lane is still nudged, and nothing is posted from its pane", async () => {
  await deps(T0).registry.write(lane);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  world.screen = REAL;
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect(sent(world)).toHaveLength(1);
  expect(posts()).toEqual([]);
});
