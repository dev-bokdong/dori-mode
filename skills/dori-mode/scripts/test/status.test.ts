import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { writeQuotaState } from "../src/claude-quota.ts";
import { writeGatewayStatus } from "../src/gateway-status.ts";
import { pendingLeadRestart } from "../src/lead-restart.ts";
import { Registry } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { quotaMessage } from "../src/messenger/discord-commands.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { JsonLaneReports, type LaneReportStore, SqliteLaneReports } from "../src/lane-reports.ts";
import { JOURNAL_FILE, SQLITE_FILE, SqliteStore, type StoreKind, WAKES_FILE } from "../src/store.ts";
import { collectStatus, kst, lookupStatus, renderStatus, shortModel, STATUS_MAX_CHARS, statusPages, waitFireMs, type Status, type StatusDeps } from "../src/status.ts";
import { fakeClock, withState } from "./fakes.ts";

const OPENED = "2026-10-19T00:00:00.000Z";
const NOW = Date.parse(OPENED) + 90 * 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const fixture = async (panes: unknown[] = [{ pane_id: "lead:p1", workspace_id: "w" }]) => {
  const state = withState();
  cleanups.push(state.done);
  const calls: string[] = [];
  const run = async (argv: readonly string[]): Promise<Ran> => {
    const line = argv.join(" ");
    calls.push(line);
    if (line === "herdr pane list") return ok(JSON.stringify({ result: { panes } }));
    if (line.startsWith("systemctl --user is-enabled")) return ok("enabled");
    if (line === "systemctl --user is-active dori-presence.service") return { code: 3, out: "inactive", err: "" };
    if (line.startsWith("systemctl --user is-active")) return ok("active");
    return { code: 127, out: "", err: line };
  };
  const registry = new Registry(state.dir);
  const deps: StatusDeps = { run, clock: fakeClock(NOW), registry, config: { ...defaultConfig("/home/test"), stateDir: state.dir, leadPane: "lead:p1" } };
  return { deps, registry, calls, dir: state.dir };
};
const lane = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, thread: "discord:1/2", brief: "/b", done: "d", openedAt: OPENED, ...extra });

test("status lists working lanes with model, age and last progress; paused and closed lanes are left out", async () => {
  const f = await fixture();
  await f.registry.write(lane("alpha", { model: "m/one", lastProgressPost: "Write the tests" }));
  await f.registry.write(lane("beta", { status: "paused" }));
  await f.registry.write(lane("gamma", { closedAt: OPENED }));
  const s = await collectStatus(f.deps);
  expect(s.lanes).toEqual([{ key: "alpha", model: "m/one", ageMin: 90, progress: "Write the tests" }]);
  const text = renderStatus(s);
  expect(text).toContain("| lanes 1 |");
  expect(text).toContain("  alpha one 90m | Write the tests");
  expect(text).not.toContain("beta");
});

test("status shows the Claude headroom on the ok line, and each account as a problem once the gate holds", async () => {
  const f = await fixture();
  writeQuotaState(f.dir, { mode: "ok", usage: { at: NOW - 3 * 60_000, accounts: [{ name: "a", fiveHour: { usedPct: 4 }, weekly: { usedPct: 29 } }] } });
  expect(renderStatus(await collectStatus(f.deps))).toContain("claude headroom 71% (hold-lanes < 50%, brief < 25%)");
  const accounts = [{ name: "a", fiveHour: { usedPct: 95, resetAt: NOW + 60 * 60_000 }, weekly: { usedPct: 40 } }, { name: "b", weekly: { usedPct: 100 } }];
  writeQuotaState(f.dir, { mode: "brief", usage: { at: NOW - 3 * 60_000, accounts } });
  const text = renderStatus(await collectStatus(f.deps));
  expect(text).toStartWith("DORI PROBLEM");
  expect(text).toContain("claude brief");
  expect(text).toContain(`! claude: brief headroom 24% (hold-lanes < 50%, brief < 25%), a 5h 95% (resets ${kst(NOW + 60 * 60_000)}) 7d 40%, b 7d 100%, read 3m ago, lanes held`);
});

test("status shows services, pending waits, watched repos with poll time and failures, and the gateway", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "waits.json"), JSON.stringify([{ key: "ci-pr-7", until: "merged o/r#7", note: "n", deadline: NOW + 1 }]));
  writeFileSync(join(f.dir, "github-repos.json"), JSON.stringify(["o/r"]));
  writeFileSync(join(f.dir, "github-events.json"), JSON.stringify({ repos: { "o/r": { cache: {}, pulls: {}, issues: {} } }, failures: { "o/r": NOW - 20 * 60_000 }, polledAt: NOW - 2 * 60_000 }));
  writeGatewayStatus(f.dir, { pid: 1, at: NOW - 4_000, connected: true, messageContent: true });
  const s = await collectStatus(f.deps);
  const text = renderStatus(s);
  expect(text).toContain("ok: services, gateway\n");
  expect(text).toContain("waits\n  ci-pr-7 on signal, timeout 10-19 10:30 KST (0m left) | n");
  expect(text).toContain("! github: failures: o/r 20m ago");
  expect(text).toContain("! issues: no trusted authors (githubIssueAuthors)");
  expect(text.startsWith("DORI PROBLEM 10-19 10:30 KST | github poll failing, no trusted issue authors | lanes 0 | waits 1")).toBe(true);
  expect(s.gateway.state).toBe("live");
  expect(s.waits[0]).toMatchObject({ note: "n" });
  const trusted = renderStatus(await collectStatus({ ...f.deps, config: { ...f.deps.config, githubIssueAuthors: ["octo-owner", "octo-alt"] } }));
  expect(trusted).toContain("! github: failures: o/r 20m ago");
  expect(trusted).not.toContain("issues: no trusted");
  expect(trusted).toContain("ok: services, gateway, issues 1 repos");
});

test("lead state: missing pane, and a pane with no agent is cold; cap and ttl come from config", async () => {
  const missing = await fixture([]);
  expect((await collectStatus(missing.deps)).lead).toMatchObject({ pane: "lead:p1", state: "missing", cacheTtlMin: 5, capTokens: 150_000 });
  const bare = await fixture();
  const s = await collectStatus(bare.deps);
  expect(s.lead.state).toBe("cold");
  expect(renderStatus(s)).toContain("lead lead:p1 cold - no agent running in the lead pane");
});

test("status --json shape round-trips and an empty state dir needs no files and creates none", async () => {
  const f = await fixture();
  const s = await collectStatus(f.deps);
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  expect(s).toMatchObject({ lanes: [], waits: [], github: { repos: [], failures: [] }, gateway: { state: "missing" } });
  expect(s.lead).not.toHaveProperty("pendingRestart");
  expect(await Bun.file(join(f.dir, "lanes")).exists()).toBe(false);
  expect(f.calls.every((c) => c === "herdr pane list" || c.startsWith("systemctl --user is-"))).toBe(true);
});

test("status exposes a pending lead restart when requested and leaves it queued", async () => {
  const f = await fixture();
  const request = { id: "restart-status-177", at: NOW, models: [{ model: "qa/lead", thinking: "high" }, { model: "qa/fallback" }] };
  writeFileSync(join(f.dir, "lead-restart.json"), JSON.stringify(request));
  const s = await collectStatus(f.deps);
  expect(s.lead.pendingRestart).toEqual(request);
  expect(JSON.parse(JSON.stringify(s)).lead.pendingRestart).toEqual(request);
  for (const value of [request.id, "qa/lead", "high", "qa/fallback"]) expect(renderStatus(s)).toContain(value);
  expect(pendingLeadRestart(f.dir)).toEqual(request);
  expect(f.calls.every((c) => c === "herdr pane list" || c.startsWith("systemctl --user is-"))).toBe(true);
});

test("the /status text stays far under Discord's limit even with many lanes", async () => {
  const f = await fixture();
  mkdirSync(f.registry.dir, { recursive: true });
  for (let i = 0; i < 30; i++) await f.registry.write(lane(`lane-${i}`, { model: "provider/very-long-model-name-for-testing", lastProgressPost: "x".repeat(300) }));
  const text = await lookupStatus(f.deps)();
  expect(text).toMatch(/\+\d+ more/);
  expect(text.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
  expect(quotaMessage(text, "No status available.").length).toBeLessThan(2000);
});

test("/status pages through 100 lanes: every page fits Discord, every lane is listed once, page 1 names the rest", async () => {
  const f = await fixture();
  mkdirSync(f.registry.dir, { recursive: true });
  const keys = Array.from({ length: 100 }, (_, i) => `scale-lane-${i}-${"k".repeat(40)}`);
  for (const key of keys) await f.registry.write(lane(key, { model: "provider/very-long-model-name-for-testing", lastProgressPost: "x".repeat(300), worktrees: ["/data/repos/worktrees/some-long-repository-name/branch"] }));
  const pages = statusPages(await collectStatus(f.deps));
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) {
    expect(page.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
    expect(quotaMessage(page, "No status available.").length).toBeLessThan(2000);
  }
  const listed = pages.flatMap((page) => page.split("\n").filter((line) => line.startsWith("  scale-lane-")).map((line) => line.trim().split(" ")[0]));
  expect(listed.sort()).toEqual([...keys].sort());
  expect(pages[0]).toContain(`more on pages 2-${pages.length}`);
  expect(pages[1]!.split("\n")[0]).toBe(`DORI lanes ${kst(NOW)} KST | page 2/${pages.length} | lanes 100`);
  expect(pages[1]).toEndWith("\nnext: page 3");
  expect(pages.at(-1)).not.toContain("next: page");
  // The slash command's page option picks the page; past the end it says how many there are.
  expect(await lookupStatus(f.deps)(AbortSignal.timeout(5_000), 2)).toBe(pages[1]!);
  expect(await lookupStatus(f.deps)(AbortSignal.timeout(5_000), 999)).toBe(`DORI status has ${pages.length} pages; there is no page 999.`);
});

test("few lanes stay one page, the same text as renderStatus", async () => {
  const f = await fixture();
  await f.registry.write(lane("solo"));
  const s = await collectStatus(f.deps);
  expect(statusPages(s)).toEqual([renderStatus(s)]);
});

const REPORT_STORES: readonly (readonly [StoreKind, (dir: string) => LaneReportStore])[] = [
  ["json", (dir) => new JsonLaneReports(dir)],
  ["sqlite", (dir) => { new SqliteStore(join(dir, SQLITE_FILE), { create: true }).close(); return new SqliteLaneReports(join(dir, SQLITE_FILE)); }],
];

test.each(REPORT_STORES)("%s store: status --json carries each lane's latest report row", async (store, open) => {
  const f = await fixture();
  await f.registry.write(lane("alpha"));
  await f.registry.write(lane("beta"));
  const reports = open(f.dir);
  reports.append({ lane: "alpha", generation: 0, kind: "progress", text: "step 1", at: NOW - 3_000 });
  reports.append({ lane: "gone", generation: 0, kind: "done", text: "closed lane", at: NOW - 2_500 });
  const latest = reports.append({ lane: "alpha", generation: 0, kind: "question", text: "which base?", evidence: "PR #4", at: NOW - 2_000 });
  reports.consume("alpha:0:1", NOW - 1_000, "thread");
  reports.close();
  const config = { ...f.deps.config, store };
  const on = await collectStatus({ ...f.deps, config });
  expect(on.lanes.find((l) => l.key === "alpha")?.report).toEqual(latest);
  expect(on.lanes.find((l) => l.key === "beta")).not.toHaveProperty("report");
  expect(JSON.parse(JSON.stringify(on))).toEqual(on);
});

test("status with no reports yet shows none and creates no table or file", async () => {
  for (const store of ["json", "sqlite"] as const) {
    const f = await fixture();
    await f.registry.write(lane("alpha"));
    if (store === "sqlite") new SqliteStore(join(f.dir, SQLITE_FILE), { create: true }).close();
    const s = await collectStatus({ ...f.deps, config: { ...f.deps.config, store } });
    expect(s.lanes[0]).not.toHaveProperty("report");
    expect(await Bun.file(join(f.dir, "lane-reports.json")).exists()).toBe(false);
    if (store === "sqlite") {
      const db = new Database(join(f.dir, SQLITE_FILE), { readonly: true });
      try { expect(db.query("SELECT name FROM sqlite_master WHERE name = 'lane_reports'").all()).toEqual([]); } finally { db.close(); }
    }
  }
});

test("status shows per-kind event counts over 24h, the wakes each kind triggered and calls per wake", async () => {
  const f = await fixture();
  const at = NOW - 60 * 60_000;
  writeFileSync(join(f.dir, JOURNAL_FILE), JSON.stringify({ events: [
    { id: "old", line: "INBOUND 1 0 yesterday", at: NOW - 25 * 60 * 60_000 },
    { id: "a", line: "INBOUND 1 1 hi", at }, { id: "b", line: "INBOUND 1 2 again", at },
    { id: "c", line: "GH_PR o/r#7 merged sha=1 u", at }, { id: "d", line: "NUDGED lane", at }, { id: "e", line: "NUDGED lane", at },
    { id: "f", line: "NUDGED lane", at },
  ] }));
  writeFileSync(join(f.dir, WAKES_FILE), [
    { at: NOW - 26 * 60 * 60_000, session: "s0", trigger: ["INBOUND"], kinds: {} },
    { at, session: "s1", trigger: ["INBOUND", "GH_PR * merged"], kinds: { INBOUND: 1, "GH_PR * merged": 1 } },
    { close: at, calls: 9 },
    { at: at + 1, session: "s1", trigger: ["INBOUND"], kinds: { INBOUND: 1 } },
    { close: at + 1, calls: 4 },
    { at: at + 2, session: "s2", trigger: ["(restart)"], kinds: {} },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const s = await collectStatus(f.deps);
  expect(s.events).toMatchObject({ hours: 24, wakes: 3, measured: 2, calls: 13 });
  expect(s.events.kinds).toEqual([
    { kind: "INBOUND", cls: "lead-urgent", events: 2, wakes: 2, measured: 2, calls: 13 },
    // The class is the current policy's: a merged PR is digest now, though it woke the lead when this wake was recorded.
    { kind: "GH_PR * merged", cls: "lead-digest", events: 1, wakes: 1, measured: 1, calls: 9 },
    { kind: "(restart)", events: 0, wakes: 1, measured: 0, calls: 0 },
    { kind: "NUDGED", cls: "lead-digest", events: 3, wakes: 0, measured: 0, calls: 0 },
  ]);
  const text = renderStatus(s);
  expect(text).toContain("\nwakes 24h 3, 6.5 calls/wake\n");
  expect(text).toContain("\nkinds 24h: INBOUND 2ev 2w 6.5c/w, GH_PR * merged 1ev 1w 9.0c/w, (restart) 0ev 1w ?c/w, NUDGED 3ev");
  // A kind moved by config is counted and classed under the config's table, with no code change.
  const moved = await collectStatus({ ...f.deps, config: { ...f.deps.config, eventPolicy: resolveEventPolicy({ kinds: { "NUDGED lane": "engine-only" } }) } });
  expect(moved.events.kinds.find((k) => k.kind === "NUDGED lane")).toEqual({ kind: "NUDGED lane", cls: "engine-only", events: 3, wakes: 0, measured: 0, calls: 0 });
});

const base: Status = {
  at: "2026-10-21T00:53:36.000Z",
  services: [
    { name: "herdr-server.service", enabled: "enabled", active: "active" },
    { name: "dori-supervisor.service", enabled: "enabled", active: "active" },
    { name: "dori-presence.service", enabled: "disabled", active: "inactive" },
  ],
  lead: { pane: "wL1:p4", state: "warm", idleMin: 0, tokens: 52_000, cacheTtlMin: 5, capTokens: 150_000 },
  lanes: [],
  waits: [],
  github: { repos: ["a/b", "c/d", "e/f"], lastPollAt: "2026-10-21T00:52:36.000Z", failures: [], issueAuthors: ["octo-owner"], issueRepos: ["a/b"] },
  gateway: { state: "live", text: "live, Message Content on (heartbeat 1s ago)" },
  unacked: 0,
  events: { hours: 24, wakes: 0, measured: 0, calls: 0, kinds: [] },
};

test("owner messages reminded with ACK_MISSING and still unacked make the status a problem", () => {
  const text = renderStatus({ ...base, unacked: 2 });
  expect(text.split("\n")[0]).toBe("DORI PROBLEM 10-21 09:53 KST | unacked 2 | lanes 0 | waits 0");
  expect(text).toContain("! acks: 2 owner messages handed to the lead without its read receipt (dori ack) after ACK_MISSING");
});

test("healthy status collapses to a summary, the lead line and one ok line, in KST", () => {
  const text = renderStatus({ ...base, lanes: [{ key: "ops", model: "anthropic-subscription/claude-opus-5-5", ageMin: 27, repo: "dori-mode", pr: 55, progress: "Full run" }] });
  expect(text).toBe([
    "DORI OK 10-21 09:53 KST | lanes 1 | waits 0",
    "lead wL1:p4 warm idle 0m ctx 52k/150k",
    "ok: services, gateway, github 3 repos, poll 1m ago, issues 1 repos",
    "lanes",
    "  ops opus-5-5 27m dori-mode #55 | Full run",
  ].join("\n"));
});

test("a failing service expands on its own line and the legacy unit counts only when it is active", () => {
  const down = renderStatus({ ...base, services: [{ name: "herdr-server.service", enabled: "enabled", active: "active" }, { name: "dori-supervisor.service", enabled: "enabled", active: "failed" }, base.services[2]!] });
  expect(down.split("\n")[0]).toBe("DORI PROBLEM 10-21 09:53 KST | dori-supervisor failed | lanes 0 | waits 0");
  expect(down).toContain("! services: dori-supervisor failed/enabled");
  expect(down).toContain("ok: gateway,");
  expect(down).not.toContain("ok: services");
  const legacy = renderStatus({ ...base, services: [base.services[0]!, base.services[1]!, { name: "dori-presence.service", enabled: "enabled", active: "active" }] });
  expect(legacy).toContain("! services: dori-presence (legacy, should be off) active/enabled");
});

test("wait time: a date-epoch signal is the fire time; the deadline field is only a labelled timeout; else the clipped signal", () => {
  const w = (extra: object) => ({ key: "k", until: "command [\"x\"]", ...extra });
  const epoch = Date.parse("2026-10-21T22:00:00.000Z") / 1000;
  const signal = `command ["bash","-c","[ $(date +%s) -ge ${epoch} ]"]`;
  const timeout = "2026-10-22T05:00:00.000Z";
  expect(waitFireMs(w({ until: signal, deadline: timeout }))).toBe(epoch * 1000);
  expect(waitFireMs(w({ deadline: timeout }))).toBeNull();
  const text = renderStatus({ ...base, waits: [
    w({ until: signal, deadline: timeout, note: "token refresh" }),
    w({ key: "t", until: "merged o/r#8", deadline: timeout }),
    w({ key: "m", until: "merged o/r#7" }),
  ] });
  expect(text).toContain("  k 10-22 07:00 KST (21h left) | token refresh");
  expect(text).toContain("  t on signal, timeout 10-22 14:00 KST (28h left)");
  expect(text).toContain("  m until merged o/r#7");
});

test("a (#N) in the lane title is never shown as a PR", async () => {
  const f = await fixture();
  await f.registry.write(lane("task-lane", { title: "polish dori /status (#55)", done: 'command ["gh","pr","list","-R","dev-bokdong/dori-mode","--head","b","--json","number"] stdout~"number"' }));
  const s = await collectStatus(f.deps);
  const l = s.lanes.find((x) => x.key === "task-lane");
  expect(l).toMatchObject({ repo: "dev-bokdong/dori-mode" });
  expect(l?.pr).toBeUndefined();
});

test("model names lose the provider and claude- prefix; other ids stay readable", () => {
  expect(shortModel("anthropic-subscription/claude-opus-5-5")).toBe("opus-5-5");
  expect(shortModel("claude-sonnet-5-5[1m]")).toBe("sonnet-5-5");
  expect(shortModel("anthropic/claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  expect(shortModel("openai/gpt-6.1-sol")).toBe("gpt-6.1-sol");
});

test("kst formats fixed +09:00 across a day boundary", () => {
  expect(kst(Date.parse("2026-10-21T15:05:00Z"))).toBe("10-22 00:05");
  expect(kst(Date.parse("2026-12-31T14:59:00Z"))).toBe("12-31 23:59");
});

test("collectStatus derives a lane's repo and PR from its Done signal, with no network", async () => {
  const f = await fixture();
  await f.registry.write(lane("pr-lane", { done: 'command ["gh","pr","list","-R","dev-bokdong/dori-mode","--head","b","--json","number"] see https://github.com/dev-bokdong/dori-mode/pull/55' }));
  await f.registry.write(lane("wt-lane", { worktrees: ["/data/repos/worktrees/some-repo/branch-1"] }));
  const s = await collectStatus(f.deps);
  expect(s.lanes.find((l) => l.key === "pr-lane")).toMatchObject({ repo: "dev-bokdong/dori-mode", pr: 55 });
  expect(s.lanes.find((l) => l.key === "wt-lane")).toMatchObject({ repo: "some-repo" });
});

test("item 6: lanes pending or exhausted on recovery are a status problem and marked in the lane list", async () => {
  const f = await fixture();
  await f.registry.write(lane("dead", { recoveryPending: true, recoveryAttempts: 3, recoveryExhausted: true }));
  await f.registry.write(lane("held", { recoveryPending: true }));
  await f.registry.write(lane("fine"));
  const s = await collectStatus(f.deps);
  expect(s.lanes.map((l) => [l.key, l.recovery])).toEqual(expect.arrayContaining([["dead", "exhausted"], ["held", "pending"], ["fine", undefined]]));
  const text = renderStatus(s);
  expect(text).toStartWith("DORI PROBLEM");
  expect(text).toContain("recovery exhausted 1");
  expect(text).toContain("! lanes: recovery exhausted (not relaunched or nudged): dead");
  expect(text).toContain("! lanes: recovery pending (not nudged): held");
  expect(text).toContain("  !RECOVERY-EXHAUSTED dead ");
  expect(text).toContain("  !RECOVERY-PENDING held ");
});
