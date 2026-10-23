import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import { laneQuotaTick, modelProvider, providerQuota, type QuotaLane, quotaScreenHit } from "../src/quota-stall.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const BLOCKED_LINE = "Error: All Claude accounts for anthropic-subscription are currently blocked";
const accounts = (...blocked: boolean[]) => JSON.stringify({ status: "not_ready", reason: "provider_not_found", accounts: blocked.map((b, i) => ({ name: `a${i}`, blocked: b })) });

let state: ReturnType<typeof withState>;
let world: World;
let auth: Record<string, string>;
beforeEach(() => {
  state = withState();
  world = newWorld();
  auth = {};
});
afterEach(() => state.done());

/** fakeRunner plus `omo auth check`, answering from `auth` by provider with omo's non-zero exit. */
const runner = (): Runner => {
  const base = fakeRunner(world);
  return async (argv, opts) => {
    if (argv[0] === "omo" && argv[1] === "auth") {
      world.calls.push([...argv]);
      return { code: 1, out: auth[argv[argv.indexOf("--provider") + 1] ?? ""] ?? "", err: "" };
    }
    return base(argv, opts);
  };
};
const deps = (patch = {}) => ({ ...depsFor(world, fakeClock(0), state.dir, patch), run: runner() });
const lane: Lane = { key: "quota-lane", title: "q", thread: "chat:1/2", pane: "w:p7", brief: "/b.md", done: "merged a/b#1", openedAt: new Date(0).toISOString() };
const authCalls = () => world.calls.filter((c) => c[0] === "omo");
const sent = () => world.calls.filter((c) => c[0] === "herdr" && c[2] === "send-text");

test("quota screen lines are found; tips, echoed briefs, recalled memory and prose are not", () => {
  expect(quotaScreenHit(`working\n  ✗ ${BLOCKED_LINE}\n❯ `)).toBe(BLOCKED_LINE);
  expect(quotaScreenHit("Usage limit reached\n")).toBe("Usage limit reached");
  expect(quotaScreenHit("Error: rate limit exceeded for model\n")).toBe("Error: rate limit exceeded for model");
  expect(quotaScreenHit("Tip: Hit a rate limit? Switch models with /model\nWant the full story on any tip? Ask me about it.\n❯ ")).toBeUndefined();
  expect(quotaScreenHit("ulw set goal and work. Read and execute the lane brief at /x.md in full. Usage limit reached handling.\n❯ ")).toBeUndefined();
  expect(quotaScreenHit('<recalled-memory source="x">\nUsage limit reached last week\n</recalled-memory>\n❯ ')).toBeUndefined();
  expect(quotaScreenHit("I added quota stall detection; the rate limit wording is in the docs.\n❯ ")).toBeUndefined();
});

test("a provider is blocked only when every account is: one healthy account is omo's own fallback", async () => {
  const check = defaultConfig("/h").quotaCheck;
  auth["anthropic-subscription"] = accounts(true, false);
  expect(await providerQuota(runner(), check, "anthropic-subscription")).toEqual({ blocked: false, detail: "1/2 anthropic-subscription accounts blocked" });
  auth["anthropic-subscription"] = accounts(true, true);
  expect(await providerQuota(runner(), check, "anthropic-subscription")).toEqual({ blocked: true, detail: "2/2 anthropic-subscription accounts blocked" });
  expect((await providerQuota(runner(), check, "unknown")).blocked).toBe(false);
  expect(authCalls().at(-1)).toEqual(["omo", "auth", "check", "--provider", "unknown", "--json", "--no-refresh"]);
});

test("a quotaCheck asking for credentials is refused and never run", async () => {
  const quota = await providerQuota(runner(), ["omo", "auth", "check", "--provider", "{provider}", "--json", "--credentials"], "p");
  expect(quota.blocked).toBe(false);
  expect(authCalls()).toEqual([]);
});

test("a lane stalled on quota emits LANE_QUOTA_STALL once per stretch, again after it recovers, and is never steered", async () => {
  const d = deps();
  const run = d.run;
  let pauseTries = 0;
  d.run = async (argv, opts) => {
    // The first pause is unconfirmed; the retry and subsequent goal commands are confirmed.
    if (argv[4] === "/goal pause" && ++pauseTries > 1) world.screen += "\nGoal paused\n";
    if (argv[4] === "/goal resume") world.screen += "\nGoal active\n";
    return run(argv, opts);
  };
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true, true);
  expect(await laneQuotaTick(d)).toEqual([`LANE_QUOTA_STALL quota-lane w:p7 reset=unknown 2/2 anthropic-subscription accounts blocked: ${BLOCKED_LINE} | PAUSE_UNVERIFIED quota-lane /goal pause unconfirmed; lane left working`]);
  // The retried pause is reported too: the lead learns the lane is now paused.
  expect(await laneQuotaTick(d)).toEqual([expect.stringMatching(/^LANE_QUOTA_STALL quota-lane w:p7 .* \| PAUSED quota-lane goal paused$/)]);
  expect(await laneQuotaTick(d)).toEqual([]);
  auth["anthropic-subscription"] = accounts(true, false);
  expect(await laneQuotaTick(d)).toEqual(["LANE_QUOTA_CLEARED quota-lane w:p7 1/2 anthropic-subscription accounts blocked; auto-resumed"]);
  expect((await d.registry.read("quota-lane"))?.lastQuotaStall).toBeUndefined();
  auth["anthropic-subscription"] = accounts(true, true);
  expect(await laneQuotaTick(d)).toHaveLength(1);
  // Only goal commands are typed, including the retry; the lane's work is never steered.
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "send-text").map((c) => c[4])).toEqual(["/goal pause", "/goal pause", "/goal resume", "/goal pause"]);
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "run")).toBe(false);
  expect((await d.registry.read("quota-lane"))?.model).toBeUndefined();
});

test("one blocked account with a healthy fallback, a clean screen, or a remote or paused lane is no stall", async () => {
  const d = deps();
  await d.registry.write(lane);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true, false);
  expect(await laneQuotaTick(d)).toEqual([]);
  auth["anthropic-subscription"] = accounts(true, true);
  world.screen = "working on it\n❯ ";
  expect(await laneQuotaTick(d)).toEqual([]);
  // Without a screen hit omo's accounts are never asked.
  expect(authCalls()).toHaveLength(1);
  world.screen = `${BLOCKED_LINE}\n❯ `;
  await d.registry.write({ ...lane, machine: "mac" });
  expect(await laneQuotaTick(d)).toEqual([]);
  await d.registry.write({ ...lane, status: "paused" });
  expect(await laneQuotaTick(d)).toEqual([]);
});

test("a bare model name is checked under the provider its family implies", async () => {
  expect(["claude-opus-4", "gpt-5", "o3", "o4-mini", "codex-mini", "gemini-2.5-pro", "grok-4", "deepseek-v4", "anthropic/claude-opus-4", "llama-3-70b", "opus"].map(modelProvider))
    .toEqual(["anthropic-subscription", "openai", "openai", "openai", "openai", "google", "xai", "deepseek", "anthropic", undefined, undefined]);
  const d = deps();
  await d.registry.write({ ...lane, model: "claude-opus-4" });
  world.screen = `${BLOCKED_LINE}\n❯ `;
  auth["anthropic-subscription"] = accounts(true, true);
  expect(await laneQuotaTick(d)).toEqual([`LANE_QUOTA_STALL quota-lane w:p7 reset=unknown 2/2 anthropic-subscription accounts blocked: ${BLOCKED_LINE} | PAUSE_UNVERIFIED quota-lane /goal pause unconfirmed; lane left working`]);
  expect(authCalls().map((c) => c[4])).toEqual(["anthropic-subscription"]);
});

test("a quota hit on a model whose provider cannot be inferred is LANE_QUOTA_UNKNOWN once per stretch, never a silent skip", async () => {
  const d = deps();
  await d.registry.write({ ...lane, model: "llama-3-70b" });
  world.screen = `${BLOCKED_LINE}\n❯ `;
  const unknown = `LANE_QUOTA_UNKNOWN quota-lane w:p7 no provider known for model llama-3-70b: ${BLOCKED_LINE}`;
  expect(await laneQuotaTick(d)).toEqual([unknown]);
  expect(await laneQuotaTick(d)).toEqual([]);
  world.screen = "working on it\n❯ ";
  expect(await laneQuotaTick(d)).toEqual([]);
  expect((await d.registry.read("quota-lane") as QuotaLane | null)?.lastQuotaUnknown).toBeUndefined();
  world.screen = `${BLOCKED_LINE}\n❯ `;
  expect(await laneQuotaTick(d)).toEqual([unknown]);
  expect(authCalls()).toEqual([]);
  expect(sent()).toEqual([]);
});

test("the lane's own model picks the provider that is checked", async () => {
  const d = deps();
  await d.registry.write({ ...lane, model: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast" });
  world.screen = "Error: rate limit exceeded\n❯ ";
  auth.opengateway = accounts(true);
  expect(await laneQuotaTick(d)).toEqual(["LANE_QUOTA_STALL quota-lane w:p7 reset=unknown 1/1 opengateway accounts blocked: Error: rate limit exceeded | PAUSE_UNVERIFIED quota-lane /goal pause unconfirmed; lane left working"]);
  expect(authCalls().map((c) => c[4])).toEqual(["opengateway"]);
});
