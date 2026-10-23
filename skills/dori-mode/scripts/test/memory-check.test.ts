import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { checkMemory, itemRefs, MEMORY_CHECK_AFTER_CLOSE_MS, MEMORY_CHECK_EVERY_MS, memorySweep, needsAction, openItems, renderMemoryReport } from "../src/memory-check.ts";
import type { Lane } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { runSweeps, supervisorSweeps } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-22T00:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const HUMAN = `---
description: Person - Human
---
## Standing rules
- keep me: lane-old and acme/app#1 here are rules, not Open items

## Open
- DORI ACK: lane dori-ack merged (acme/app#7). task #82
  continues on an indented line naming lane hsj-dead
- PIPELINE: PR #9 in acme/app. task #183 still running
- QUIET: nothing finished here, lane live-lane works on it

## Facts
- facts are not Open items: dori-ack
`;

const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({
  key, title: key, thread: "discord:1", brief: "/b.md", done: `command ["gh","pr","list","-R","acme/app","--state","merged"] stdout~"number"`,
  openedAt: new Date(T0).toISOString(), ...patch,
});

/** gh pr view N -R repo: PRs 7 and 9 merged, the rest open. */
const prRunner = (calls: string[][]) => async (argv: readonly string[]): Promise<Ran> => {
  calls.push([...argv]);
  if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return { code: 0, out: JSON.stringify({ state: ["7", "9"].includes(argv[3] ?? "") ? "MERGED" : "OPEN" }), err: "" };
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

const setup = async (human = HUMAN, maxKb = 15): Promise<{ deps: FlowDeps; calls: string[][]; memory: string }> => {
  const memory = join(state.dir, "memory");
  mkdirSync(join(memory, "system"), { recursive: true });
  writeFileSync(join(memory, "system", "human.md"), human);
  const calls: string[][] = [];
  const base = depsFor(newWorld(), fakeClock(T0), join(state.dir, "state"), { memoryCheck: { repo: memory, maxKb } });
  const deps: FlowDeps = { ...base, run: prRunner(calls) };
  await deps.registry.write(lane("dori-ack", { closedAt: new Date(T0).toISOString(), status: "closed" }));
  await deps.registry.write(lane("live-lane"));
  mkdirSync(join(deps.config.stateDir, "lanes-closed"), { recursive: true });
  writeFileSync(join(deps.config.stateDir, "lanes-closed", "hsj-dead.json.dead-20261022"), JSON.stringify(lane("hsj-dead")));
  writeFileSync(join(deps.config.stateDir, "lanes-closed", "live-lane.json.old"), JSON.stringify(lane("live-lane")));
  return { deps, calls, memory };
};

test("Open items are the top-level bullets under ## Open, with their indented lines", () => {
  const items = openItems(HUMAN);
  expect(items.map((i) => i.index)).toEqual([1, 2, 3]);
  expect(items[0]?.text).toContain("indented line naming lane hsj-dead");
  expect(items.map((i) => i.text).join("\n")).not.toContain("keep me");
  expect(items.map((i) => i.text).join("\n")).not.toContain("facts are not");
});

test("references: whole-word lane keys, owner/repo#N, PR #N only when one repo is named as owner/repo", () => {
  const refs = itemRefs("lane dori-ack-2 and dori-ack; see acme/app#7 and https://github.com/acme/web/pull/3; PR #9 for app; task #5", ["dori-ack", "ack"], ["acme/app", "acme/web"]);
  expect(refs).toEqual({ lanes: ["dori-ack"], prs: ["acme/app#7", "acme/web#3"], unresolved: ["PR #9"] });
  expect(itemRefs("PR #9 in acme/app", [], ["acme/app", "acme/web"]).prs).toEqual(["acme/app#9"]);
  expect(itemRefs("repo acme/other (new): PR #2", [], ["acme/app"]).prs).toEqual(["acme/other#2"]);
  expect(itemRefs("fix lane (web #188), PR #66 merged; app is fine", [], ["acme/web", "acme/app"])).toMatchObject({ prs: [], unresolved: ["PR #66"] });
  expect(itemRefs("see /data/repos/x#1 and notes/facts.md", [], []).prs).toEqual([]);
});

test("the report names stale Open items by closed lane and merged PR, reads only, and asks for action", async () => {
  const { deps, calls, memory } = await setup();
  const file = join(memory, "system", "human.md");
  const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, files: readdirSync(memory, { recursive: true }) };
  const report = await checkMemory(deps, "/home/test");
  expect(report.stale.map((s) => [s.item.index, s.refs])).toEqual([
    [1, ["closed lane dori-ack", "closed lane hsj-dead", "merged PR acme/app#7"]],
    [2, ["merged PR acme/app#9"]],
  ]);
  expect(report.unchecked).toEqual([]);
  expect(needsAction(report)).toBe(true);
  const text = renderMemoryReport(report);
  expect(text).toContain("SIZE ");
  expect(text).toContain(": ok");
  expect(text).toContain("STALE #1");
  expect(text.split("\n").at(-1)).toStartWith("MEMORY_CHECK action needed");
  expect(calls.every((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view")).toBe(true);
  expect({ text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, files: readdirSync(memory, { recursive: true }) }).toEqual(before);
});

test("an oversized file alone needs action; a clean small file does not; failures are UNCHECKED, never stale", async () => {
  const big = await setup(`## Open\n- ${"x".repeat(2048)}\n`, 1);
  const over = await checkMemory(big.deps, "/home/test");
  expect(over.stale).toEqual([]);
  expect(needsAction(over)).toBe(true);
  expect(renderMemoryReport(over)).toContain("OVER by");
  state.done(); state = withState();
  const clean = await setup("## Open\n- QUIET: lane live-lane, task #183, acme/app#12, PR #4\n");
  const report = await checkMemory(clean.deps, "/home/test");
  expect(needsAction(report)).toBe(false);
  expect(report.unchecked).toEqual(["item 1: PR #4 (repo unclear; write owner/repo#N)"]);
  expect(renderMemoryReport(report).split("\n").at(-1)).toBe("MEMORY_CHECK clean");
});

test("without memoryCheck.repo the repo is omo's for defaultCwd; nothing found is a MemoryCheckError", async () => {
  const { deps } = await setup();
  const blank = { ...deps, config: { ...deps.config, memoryCheck: { ...deps.config.memoryCheck, repo: "" } } };
  await expect(checkMemory(blank, state.dir)).rejects.toThrow("lead memory repo not found");
  const hash = new Bun.CryptoHasher("sha256").update(deps.config.defaultCwd).digest("hex").slice(0, 8);
  const found = join(state.dir, ".omo", "memory", "agents", `repo-${hash}`, "repo");
  mkdirSync(join(found, "system"), { recursive: true });
  writeFileSync(join(found, "system", "human.md"), "## Open\n");
  expect((await checkMemory(blank, state.dir)).file).toBe(join(found, "system", "human.md"));
});

test("the sweep sends one MEMORY_CHECK per distinct finding: daily, and 15 minutes after a newly closed lane", async () => {
  const { deps } = await setup();
  const at = (ms: number): FlowDeps => ({ ...deps, clock: fakeClock(ms) });
  const first = await memorySweep(at(T0), "/home/test");
  expect(first).toHaveLength(1);
  expect(first[0]).toStartWith("MEMORY_CHECK 2 Open item(s) reference finished work: #1 closed lane dori-ack");
  expect(await memorySweep(at(T0 + MIN), "/home/test")).toEqual([]);
  // A day later the same findings stay quiet.
  expect(await memorySweep(at(T0 + MEMORY_CHECK_EVERY_MS), "/home/test")).toEqual([]);
  // live-lane closes: nothing before the grace period, then one line with the new finding.
  const t1 = T0 + MEMORY_CHECK_EVERY_MS + MIN;
  await deps.registry.write(lane("live-lane", { closedAt: new Date(t1).toISOString(), status: "closed" }));
  expect(await memorySweep(at(t1), "/home/test")).toEqual([]);
  expect(await memorySweep(at(t1 + MEMORY_CHECK_AFTER_CLOSE_MS - 1), "/home/test")).toEqual([]);
  const after = await memorySweep(at(t1 + MEMORY_CHECK_AFTER_CLOSE_MS), "/home/test");
  expect(after).toHaveLength(1);
  expect(after[0]).toContain("#3 closed lane live-lane");
  expect(await memorySweep(at(t1 + MEMORY_CHECK_AFTER_CLOSE_MS + MIN), "/home/test")).toEqual([]);
});

test("a missing memory file is one MEMORY_CHECK_WARN, retried only on the next daily turn", async () => {
  const { deps } = await setup();
  const gone = { ...deps, config: { ...deps.config, memoryCheck: { ...deps.config.memoryCheck, repo: join(state.dir, "nowhere") } } };
  const warn = await memorySweep(gone, "/home/test");
  expect(warn).toHaveLength(1);
  expect(warn[0]).toStartWith("MEMORY_CHECK_WARN ");
  expect(await memorySweep({ ...gone, clock: fakeClock(T0 + MIN) }, "/home/test")).toEqual([]);
});

test("the supervisor's sweeps include the memory sweep, so its line reaches the lead's queue", async () => {
  const { deps } = await setup();
  const queue: string[] = [];
  const sweeps = supervisorSweeps(deps, "/home/test", async () => ({ results: [], text: "" }));
  expect(sweeps.map(([name]) => name)).toContain("memory");
  await runSweeps(sweeps, async (line) => { queue.push(line); }, deps.clock.now, new Map(), () => {});
  expect(queue.filter((line) => line.startsWith("MEMORY_CHECK "))).toHaveLength(1);
});
