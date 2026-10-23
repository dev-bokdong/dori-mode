// One supervisor pass over a done-claimed lane whose window has passed (the automatic close).
// argv: <stateDir> <worldDir> <killAt> <mode: watch|close>. The process SIGKILLs itself right after its killAt-th step;
// a step is an operation row write, an effect on the world, or a registry write. killAt -1 never kills and prints
// {"steps": n, "lines": [...]}. The world (panes, worktree directories, effect log) lives in worldDir.
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../../src/config.ts";
import { closeLane, type FlowDeps, watchTick } from "../../src/done-flow.ts";
import { openOperations, type OperationStore } from "../../src/operations.ts";
import { Registry } from "../../src/registry.ts";
import type { Ran, Runner } from "../../src/run.ts";
import { fakeClock, TEST_STORE } from "../fakes.ts";

const [stateDir = "", worldDir = "", killArg = "-1", mode = "watch"] = process.argv.slice(2);
const killAt = Number(killArg);
let steps = 0;
const step = (): void => {
  steps++;
  if (steps === killAt) process.kill(process.pid, "SIGKILL");
};
if (killAt === 0) process.kill(process.pid, "SIGKILL");

const worldFile = join(worldDir, "world.json");
const effect = (line: string): void => { appendFileSync(join(worldDir, "effects.log"), `${line}\n`); step(); };
const panes = (): { pane_id: string; workspace_id: string }[] => (JSON.parse(readFileSync(worldFile, "utf8")) as { panes: { pane_id: string; workspace_id: string }[] }).panes;
const repo = join(worldDir, "repo");
const wtRoot = join(worldDir, "wt");

const runner: Runner = async (argv) => {
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if (cmd === "gh") return ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc1234567890" } }));
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) {
    const wts = existsSync(wtRoot) ? readdirSync(wtRoot) : [];
    return ok([`worktree ${repo}\nbranch refs/heads/main`, ...wts.map((name) => `worktree ${join(wtRoot, name)}\nbranch refs/heads/${name}`)].join("\n\n"));
  }
  if (cmd === "git" && argv.includes("worktree") && argv.includes("remove")) {
    const wt = argv.at(-1) ?? "";
    rmSync(wt, { recursive: true, force: true });
    effect(`worktree-remove ${wt}`);
    return ok();
  }
  if (cmd === "git" && argv.includes("status")) return ok("");
  if (cmd === "git" && argv.includes("rev-list")) return ok("0");
  if (cmd === "notify") { effect(`thread-done ${a1}`); return ok(); }
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: panes() } }));
  if (cmd === "herdr" && a1 === "pane" && a2 === "close") {
    writeFileSync(worldFile, JSON.stringify({ panes: panes().filter((p) => p.pane_id !== argv[3]) }));
    effect(`pane-close ${argv[3]}`);
    return ok();
  }
  if (cmd === "herdr") return ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

class StepRegistry extends Registry {
  override async update(...args: Parameters<Registry["update"]>): ReturnType<Registry["update"]> {
    const stored = await super.update(...args);
    step();
    return stored;
  }
}

const config = { ...defaultConfig("/home/test"), stateDir, defaultCwd: repo, leadPane: "lead:p1", store: TEST_STORE, hooks: { threadDone: ["notify", "{thread}", "{text}"] } };
const inner = openOperations(config);
const operations: OperationStore = {
  get: (id) => inner.get(id),
  put: (op) => { inner.put(op); step(); },
  list: (filter) => inner.list(filter),
  close: () => inner.close(),
};
const deps: FlowDeps = { run: runner, clock: fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), registry: new StepRegistry(stateDir), config, operations };
const lines: string[] = [];
if (mode === "close") {
  const lane = await deps.registry.read("demo-lane");
  if (lane) lines.push(...(await closeLane(deps, lane, "closed by the lead")).lines);
} else {
  lines.push(...(await watchTick(deps)));
}
inner.close();
console.log(JSON.stringify({ steps, lines }));
