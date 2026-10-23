import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { defaultConfig, fill, isEmergencyModel, leadChain, leadCommand, leadModels, loadConfig, providerOf } from "../src/config.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.defaultCwd).toBe("/home/ana/code/my-project");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.agentCommand).toEqual(["omo", "--model", "{model}", "{prompt}"]);
});

test("a stray leadModel key in the config file is ignored, and the default model is the subscription one", async () => {
  const path = join(state.dir, "stray.json");
  await Bun.write(path, JSON.stringify({ leadModel: "old/model" }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.defaultModel).toBe("anthropic-subscription/claude-opus-5-5");
});

test("an old config's removed feature flags load fine: the keys are dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-flags.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7, operations: false, laneReports: true, superviseTasks: false, store: "json" }));
  // A fresh process, so the once-per-process warning is not already spent by another test file.
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ closeAfterMin: a.closeAfterMin, store: b.store, leftover: ["operations", "laneReports", "superviseTasks"].filter((k) => k in a || k in b) }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ closeAfterMin: 7, store: "json", leftover: [] });
  const warnings = err.split("\n").filter((line) => line.startsWith("CONFIG_FLAGS_REMOVED "));
  expect(warnings).toEqual([`CONFIG_FLAGS_REMOVED superviseTasks, operations, laneReports in ${path}: these flags were removed and their behavior is always on; the keys are ignored and can be deleted`]);
});

test("an old config's task-tracker keys (memoryCheck.toodoMcp/toodoTokenFile, ciToodoWorkspaces) load without error", async () => {
  const path = join(state.dir, "old-tracker.json");
  await Bun.write(path, JSON.stringify({
    memoryCheck: { repo: "~/memory", maxKb: 9, toodoMcp: "http://127.0.0.1:1/mcp", toodoTokenFile: "~/token" },
    ciToodoWorkspaces: { "acme/app": 3 },
  }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.memoryCheck.repo).toBe("/home/ana/memory");
  expect(c.memoryCheck.maxKb).toBe(9);
  expect(c.ciMergeBase).toBe("dev");
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

test("leadCommand handles --flag=value templates and a template without --model", () => {
  const config = { ...defaultConfig("/home/test"), defaultModel: "m/lane", leadModel: "m/lead", leadThinking: "high" };
  expect(leadCommand({ ...config, agentCommand: ["omo", "--model={model}", "--thinking=medium", "{prompt}"] }, "@p"))
    .toEqual(["omo", "--model=m/lead", "--thinking=high", "@p"]);
  expect(leadCommand({ ...config, agentCommand: ["omo", "--model={model}", "{prompt}"] }, "@p")).toEqual(["omo", "--model=m/lead", "--thinking", "high", "@p"]);
  expect(leadCommand({ ...config, agentCommand: ["agent", "{prompt}"] }, "@p")).toEqual(["agent", "--thinking", "high", "@p"]);
});

test("the configured lead context cap overrides the default", async () => {
  const local = withState();
  try {
    const path = join(local.dir, "cap.json");
    await Bun.write(path, JSON.stringify({ leadContextCapTokens: 42_000 }));
    const c = await loadConfig(path, "/home/ana");
    expect(c.leadContextCapTokens).toBe(42_000);
  } finally { local.done(); }
});

test("leadModel as an array is an ordered chain; an entry's own thinking wins over leadThinking, blanks are skipped", () => {
  const base = { ...defaultConfig("/home/test"), defaultModel: "m/lane", leadThinking: "low" };
  const chain = [" anthropic-subscription/claude-opus-5-5 ", "", { model: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast", thinking: "high" }, { model: " " }];
  expect(leadModels({ ...base, leadModel: chain })).toEqual([
    { model: "anthropic-subscription/claude-opus-5-5", thinking: "low" },
    { model: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast", thinking: "high" },
  ]);
  expect(leadModels({ ...base, leadModel: "m/lead" })).toEqual([{ model: "m/lead", thinking: "low" }]);
  expect(leadModels({ ...base, leadModel: [] })).toEqual([{ model: "m/lane", thinking: "low" }]);
  const template = ["omo", "--model", "{model}", "--thinking", "medium", "{prompt}"];
  expect(leadCommand({ ...base, agentCommand: template, leadModel: chain }, "@p", 1)).toEqual(["omo", "--model", "opengateway/deepseek/deepseek-v4.1-flash-ultrafast", "--thinking", "high", "@p"]);
  expect(leadCommand({ ...base, agentCommand: template, leadModel: chain }, "@p")).toEqual(["omo", "--model", "anthropic-subscription/claude-opus-5-5", "--thinking", "low", "@p"]);
  // An index past a shortened chain stays on its last entry.
  expect(leadCommand({ ...base, agentCommand: template, leadModel: chain }, "@p", 9)[2]).toBe("opengateway/deepseek/deepseek-v4.1-flash-ultrafast");
  expect(providerOf("opengateway/deepseek/x")).toBe("opengateway");
  expect(providerOf("bare-model")).toBeUndefined();
});

test("emergency models follow the lead chain once, flagged; quotaGate keys merge over the defaults", async () => {
  const path = join(state.dir, "emergency.json");
  await Bun.write(path, JSON.stringify({ leadModel: ["a/one", "og/anthropic/claude-opus-5-5"], leadEmergencyModels: ["og/anthropic/claude-opus-5-5:max", { model: "or/anthropic/claude-opus-5.5", thinking: "high" }, ""], quotaGate: { holdLanesHeadroomPct: 70, holdLanes5hPct: 80 } }));
  const c = await loadConfig(path, "/home/ana");
  expect(leadChain(c)).toEqual([{ model: "a/one" }, { model: "og/anthropic/claude-opus-5-5" }, { model: "or/anthropic/claude-opus-5.5", thinking: "high", emergency: true }]);
  expect(leadModels(c).map((m) => m.model)).toEqual(["a/one", "og/anthropic/claude-opus-5-5"]);
  expect(isEmergencyModel(c, "og/anthropic/claude-opus-5-5")).toBe(true);
  expect(isEmergencyModel(c, "or/anthropic/claude-opus-5.5:max")).toBe(true);
  expect(isEmergencyModel(c, "anthropic-subscription/claude-opus-5-5")).toBe(false);
  // A key of the removed fixed-percent gate is dropped.
  expect(c.quotaGate).toEqual({ holdLanesHeadroomPct: 70, briefHeadroomPct: 25, pollMin: 5 });
  expect(leadCommand(c, "@p", 2)).toEqual(["omo", "--model", "or/anthropic/claude-opus-5.5", "--thinking", "high", "@p"]);
});

test("a leadModel chain loads from the config file as written", async () => {
  const path = join(state.dir, "chain.json");
  await Bun.write(path, JSON.stringify({ leadModel: ["a/one", { model: "b/two", thinking: "high" }] }));
  const c = await loadConfig(path, "/home/ana");
  expect(leadModels(c).map((m) => m.model)).toEqual(["a/one", "b/two"]);
  expect(c.quotaCheck).toEqual(["omo", "auth", "check", "--provider", "{provider}", "--json", "--no-refresh"]);
  expect(c.leadPrimaryRetryMin).toBe(15);
});
