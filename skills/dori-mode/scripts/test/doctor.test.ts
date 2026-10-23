import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeQuotaState } from "../src/claude-quota.ts";
import { defaultConfig } from "../src/config.ts";
import { type Check, type DoctorDeps, doctorExit, renderDoctor, runDoctor, tokenFrom } from "../src/doctor.ts";
import { gatewayView, writeGatewayStatus } from "../src/gateway-status.ts";
import { pendingLeadRestart } from "../src/lead-restart.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { Registry } from "../src/registry.ts";
import type { Ran } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const TOKEN = "secret-token-xyz";
const NOW = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const no = (out = "", code = 1): Ran => ({ code, out, err: "" });
const pane = JSON.stringify({ result: { panes: [{ pane_id: "lead:p1", workspace_id: "w" }] } });
const happyRun: Record<string, Ran> = {
  "systemctl --user is-enabled herdr-server.service": ok("enabled"),
  "systemctl --user is-active herdr-server.service": ok("active"),
  "systemctl --user is-enabled dori-supervisor.service": ok("enabled"),
  "systemctl --user is-active dori-supervisor.service": ok("active"),
  "systemctl --user is-enabled dori-presence.service": no("disabled"),
  "systemctl --user is-active dori-presence.service": no("inactive", 3),
  "pgrep -f (dori|cli\\.ts) presence": no(),
  "herdr workspace list": ok("{}"),
  "pgrep -f herdr server": ok("101"),
  "systemctl --user show dori-supervisor.service --property=WorkingDirectory --value": ok("/work"),
  "herdr pane list": ok(pane),
  "gh --version": ok("gh 2"), "gh auth status": ok(), "jq --version": ok("jq-1.7"), "bun --version": ok("1.4"),
};
const resp = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
const happyHttp: Record<string, ReturnType<typeof resp>> = {
  "/users/@me": resp(200, { username: "Dori" }),
  "/users/@me/guilds": resp(200, [{ id: "200" }]),
  "/applications/@me": resp(200, { flags: 1 << 18 }),
  "/channels/500/messages?limit=1": resp(200, []),
  "/applications/100/guilds/200/commands": resp(200, [{ name: "quota" }, { name: "status" }]),
};

type Patch = { run?: Record<string, Ran>; http?: Record<string, ReturnType<typeof resp>>; gateway?: "live" | "none" | "stale" | "nocontent" | "down"; free?: number; deps?: Partial<DoctorDeps> };
const fixture = (patch: Patch = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const table = { ...happyRun, ...patch.run };
  const routes = { ...happyHttp, ...patch.http };
  const calls: string[] = [];
  const requests: HttpRequest[] = [];
  const clock = fakeClock(NOW);
  const run = async (argv: readonly string[]): Promise<Ran> => {
    const line = argv.join(" ");
    calls.push(line);
    if (argv[0] === "df") return ok(`Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 ${Math.round((patch.free ?? 100) * 1024 * 1024)} 1% /`);
    return table[line] ?? { code: 127, out: "", err: `unexpected ${line}` };
  };
  const http: Http = async (req) => {
    requests.push(req);
    return routes[req.url.replace("https://discord.com/api/v10", "")] ?? resp(404, {});
  };
  const g = patch.gateway ?? "live";
  if (g !== "none") {
    writeGatewayStatus(state.dir, {
      pid: 1, at: g === "stale" ? NOW - 120_000 : NOW - 3_000,
      connected: g !== "down", messageContent: g !== "nocontent",
    });
  }
  mkdirSync(join(state.dir, "memory", "system"), { recursive: true });
  writeFileSync(join(state.dir, "memory", "system", "human.md"), "## Open\n- one item\n");
  const deps: DoctorDeps = {
    run, http, clock, configPath: "/home/test/config.json", envPath: "/home/test/.dori/env", token: TOKEN, tokenSource: "file", exists: () => true, home: state.dir,
    config: {
      ...defaultConfig("/home/test"), stateDir: state.dir, defaultCwd: state.dir, leadPane: "lead:p1", laneWorkspace: "w1",
      memoryCheck: { ...defaultConfig("/home/test").memoryCheck, repo: join(state.dir, "memory") },
      discordChannels: ["500"], discord: { applicationId: "100", guildId: "200", ownerId: "300" },
    },
    ...patch.deps,
  };
  return { deps, calls, requests };
};
const find = (checks: readonly Check[], id: string): Check => {
  const hit = checks.find((c) => c.id === id);
  if (!hit) throw new Error(`no check ${id}: ${checks.map((c) => c.id).join(", ")}`);
  return hit;
};

test("a healthy machine is all OK, exits 0 and prints the summary line", async () => {
  const f = fixture();
  const checks = await runDoctor(f.deps);
  expect(checks.filter((c) => c.level !== "OK")).toEqual([]);
  expect(doctorExit(checks)).toBe(0);
  expect(renderDoctor(checks)).toContain(`DOCTOR ok=${checks.length} warn=0 fail=0`);
});

test("doctor only reads: no unit changes and Discord is GET only", async () => {
  const f = fixture();
  await runDoctor(f.deps);
  expect(f.calls.filter((c) => /^systemctl --user (enable|disable|start|stop|restart|daemon-reload)/.test(c) || /^kill /.test(c))).toEqual([]);
  expect(f.requests.length).toBeGreaterThan(0);
  expect(f.requests.every((r) => r.method === "GET")).toBe(true);
});

test("doctor warns when a lead restart is pending without consuming it or touching the warm lead", async () => {
  const f = fixture();
  const request = { id: "restart-doctor-177", at: NOW, models: [{ model: "qa/lead", thinking: "high" }, { model: "qa/fallback" }] };
  writeFileSync(join(f.deps.config.stateDir, "lead-restart.json"), JSON.stringify(request));
  const checks = await runDoctor(f.deps);
  const check = find(checks, "lead restart");
  expect(check.level).toBe("WARN");
  for (const value of [request.id, "qa/lead", "high", "qa/fallback"]) expect(check.detail).toContain(value);
  expect(doctorExit(checks)).toBe(0);
  expect(pendingLeadRestart(f.deps.config.stateDir)).toEqual(request);
  expect(f.calls).toEqual(expect.arrayContaining(["herdr pane list"]));
  expect(f.calls.filter((c) => c.startsWith("herdr ") && c !== "herdr pane list" && c !== "herdr workspace list")).toEqual([]);
});

test("an inactive supervisor is FAIL with the enable command and exit 1; not-found points at setup", async () => {
  const down = fixture({ run: { "systemctl --user is-active dori-supervisor.service": no("inactive", 3) } });
  const checks = await runDoctor(down.deps);
  expect(find(checks, "unit dori-supervisor")).toMatchObject({ level: "FAIL", fix: "systemctl --user enable --now dori-supervisor.service" });
  expect(doctorExit(checks)).toBe(1);
  const missing = fixture({ run: { "systemctl --user is-enabled herdr-server.service": no("not-found", 4) } });
  expect(find(await runDoctor(missing.deps), "unit herdr-server")).toMatchObject({ level: "FAIL", fix: "dori setup --autostart" });
});

test("a legacy presence unit or a stray process is WARN (exit stays 0) with its own fix", async () => {
  const unit = fixture({ run: { "systemctl --user is-enabled dori-presence.service": ok("enabled"), "systemctl --user is-active dori-presence.service": ok("active") } });
  const a = await runDoctor(unit.deps);
  expect(find(a, "legacy presence")).toMatchObject({ level: "WARN", fix: "systemctl --user disable --now dori-presence.service" });
  expect(doctorExit(a)).toBe(0);
  const proc = fixture({ run: { "pgrep -f (dori|cli\\.ts) presence": ok("4242") } });
  const b = await runDoctor(proc.deps);
  expect(find(b, "legacy presence")).toMatchObject({ level: "WARN", fix: "kill 4242" });
  expect(doctorExit(b)).toBe(0);
});

test("herdr: unreachable and duplicate servers are FAIL", async () => {
  const down = fixture({ run: { "herdr workspace list": no("", 1) } });
  expect(find(await runDoctor(down.deps), "herdr")).toMatchObject({ level: "FAIL", fix: "systemctl --user start herdr-server.service" });
  const dup = fixture({ run: { "pgrep -f herdr server": ok("101\n202") } });
  expect(find(await runDoctor(dup.deps), "herdr")).toMatchObject({ level: "FAIL", detail: "2 herdr server processes" });
});

test("missing WorkingDirectory, missing dirs, missing config keys and a missing lead pane are FAIL", async () => {
  const wd = fixture({ run: { "systemctl --user show dori-supervisor.service --property=WorkingDirectory --value": ok("") } });
  expect(find(await runDoctor(wd.deps), "supervisor WorkingDirectory").detail).toContain("200/CHDIR");
  const dirs = fixture({ deps: { exists: (p) => p === "/work" } });
  const c = await runDoctor(dirs.deps);
  expect(find(c, "stateDir")).toMatchObject({ level: "FAIL" });
  expect(find(c, "defaultCwd").fix).toStartWith("mkdir -p ");
  const keys = fixture({ deps: { config: { ...fixture().deps.config, laneWorkspace: "", discordChannels: [], discord: { applicationId: "x", guildId: "200", ownerId: "300" } } } });
  const k = find(await runDoctor(keys.deps), "config");
  expect(k.level).toBe("FAIL");
  expect(k.detail).toContain("laneWorkspace");
  expect(k.detail).toContain("discordChannels");
  expect(k.detail).toContain("discord.applicationId");
  const lead = fixture({ run: { "herdr pane list": ok(JSON.stringify({ result: { panes: [] } })) } });
  expect(find(await runDoctor(lead.deps), "leadPane")).toMatchObject({ level: "FAIL", fix: "dori lead-restart" });
  const bad = fixture({ deps: { configError: "Unexpected token" } });
  expect(find(await runDoctor(bad.deps), "config")).toMatchObject({ level: "FAIL" });
});

test("a set but blank leadModel or leadThinking is WARN; set or absent says nothing", async () => {
  const config = fixture().deps.config;
  const blank = find(await runDoctor(fixture({ deps: { config: { ...config, leadModel: " ", leadThinking: "high" } } }).deps), "lead command");
  expect(blank).toMatchObject({ level: "WARN" });
  expect(blank.detail).toStartWith("leadModel set but blank");
  const set = await runDoctor(fixture({ deps: { config: { ...config, leadModel: "m/lead", leadThinking: "high" } } }).deps);
  expect(set.find((c) => c.id === "lead command")).toBeUndefined();
});

test("a leadModel chain is listed; unusable entries WARN, and a quotaCheck with --credentials is FAIL", async () => {
  const config = fixture().deps.config;
  const chain = find(await runDoctor(fixture({ deps: { config: { ...config, leadModel: ["a/one", { model: "b/two", thinking: "high" }] } } }).deps), "lead model chain");
  expect(chain).toMatchObject({ level: "OK", detail: "a/one -> b/two (thinking high)" });
  const checks = await runDoctor(fixture({ deps: { config: { ...config, leadModel: ["bare", { model: "b/two" }] } } }).deps);
  expect(find(checks, "lead model chain")).toMatchObject({ level: "WARN", detail: "unusable entries #1 are skipped" });
  expect(checks.find((c) => c.id === "lead command")).toBeUndefined();
  const creds = await runDoctor(fixture({ deps: { config: { ...config, leadModel: ["a/one", "b/two"], quotaCheck: ["omo", "auth", "check", "--provider", "{provider}", "--credentials"] } } }).deps);
  expect(find(creds, "quota check").level).toBe("FAIL");
  expect((await runDoctor(fixture().deps)).find((c) => c.id === "lead model chain")).toBeUndefined();
});

test("token: rejected is FAIL, absent is FAIL with no Discord call, env-only is WARN; it is never printed", async () => {
  const rejected = fixture({ http: { "/users/@me": resp(401, { message: "401: Unauthorized" }) } });
  const a = await runDoctor(rejected.deps);
  expect(find(a, "discord token")).toMatchObject({ level: "FAIL", detail: "token rejected (401)" });
  expect(a.find((c) => c.id === "bot in guild")).toBeUndefined();
  const none = fixture({ deps: { token: undefined, tokenSource: undefined } });
  const b = await runDoctor(none.deps);
  expect(find(b, "discord token").level).toBe("FAIL");
  expect(none.requests).toHaveLength(0);
  const env = fixture({ deps: { tokenSource: "env" } });
  const c = await runDoctor(env.deps);
  expect(find(c, "discord token").level).toBe("WARN");
  for (const checks of [a, b, c]) expect(renderDoctor(checks)).not.toContain(TOKEN);
  const ok1 = fixture();
  expect(renderDoctor(await runDoctor(ok1.deps))).not.toContain(TOKEN);
  expect(ok1.requests.every((r) => r.headers?.Authorization === `Bot ${TOKEN}`)).toBe(true);
});

test("bot outside the guild and unreadable channels are FAIL", async () => {
  const f = fixture({ http: { "/users/@me/guilds": resp(200, [{ id: "999" }]), "/channels/500/messages?limit=1": resp(403, {}) } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "bot in guild").level).toBe("FAIL");
  expect(find(checks, "channels")).toMatchObject({ level: "FAIL", detail: "500: no access" });
});

test("Message Content intent: either flag is OK, none is WARN with the Developer Portal step", async () => {
  expect(find(await runDoctor(fixture({ http: { "/applications/@me": resp(200, { flags: 1 << 19 }) } }).deps), "message content intent").level).toBe("OK");
  const f = fixture({ http: { "/applications/@me": resp(200, { flags: 0 }) } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "message content intent")).toMatchObject({ level: "WARN" });
  expect(find(checks, "message content intent").fix).toContain("Developer Portal");
  expect(doctorExit(checks)).toBe(0);
});

test("slash commands: a missing /status or /quota is WARN with the restart fix", async () => {
  const f = fixture({ http: { "/applications/100/guilds/200/commands": resp(200, [{ name: "quota" }]) } });
  expect(find(await runDoctor(f.deps), "slash commands")).toMatchObject({ level: "WARN", detail: "not registered: /status", fix: "systemctl --user restart dori-supervisor.service" });
  const none = fixture({ http: { "/applications/100/guilds/200/commands": resp(200, []) } });
  expect(find(await runDoctor(none.deps), "slash commands").detail).toBe("not registered: /quota, /status");
});

test("gateway: live OK; no file, stale and disconnected FAIL; without Message Content WARN", async () => {
  expect(find(await runDoctor(fixture({ gateway: "live" }).deps), "gateway").level).toBe("OK");
  for (const g of ["none", "stale", "down"] as const) expect(find(await runDoctor(fixture({ gateway: g }).deps), "gateway")).toMatchObject({ level: "FAIL", fix: "systemctl --user restart dori-supervisor.service" });
  expect(find(await runDoctor(fixture({ gateway: "nocontent" }).deps), "gateway").level).toBe("WARN");
});

test("tools and disk: missing gh auth, jq or bun are FAIL; free space under the guard is WARN", async () => {
  const f = fixture({ run: { "gh auth status": no("", 1), "jq --version": { code: 127, out: "", err: "" }, "bun --version": { code: 127, out: "", err: "" } } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "gh")).toMatchObject({ level: "FAIL", fix: "gh auth login" });
  expect(find(checks, "jq").level).toBe("FAIL");
  expect(find(checks, "bun").level).toBe("FAIL");
  const low = fixture({ free: 5 });
  const d = find(await runDoctor(low.deps), "disk");
  expect(d.level).toBe("WARN");
  expect(d.detail).toContain("diskFreeMinGb is 50");
});

test("an unreachable Discord API is a bounded FAIL, not a crash", async () => {
  const f = fixture();
  const deps: DoctorDeps = { ...f.deps, http: async () => { throw new Error("offline"); } };
  expect(find(await runDoctor(deps), "discord token")).toMatchObject({ level: "FAIL", detail: "Discord API unreachable" });
});

test("tokenFrom reads the env file forms and gatewayView ages with the injected clock", () => {
  expect(tokenFrom("A=1\nDORI_DISCORD_TOKEN=abc\n")).toBe("abc");
  expect(tokenFrom('export DORI_DISCORD_TOKEN="q q"')).toBe("q q");
  expect(tokenFrom("DORI_DISCORD_TOKEN=")).toBeUndefined();
  expect(tokenFrom(undefined)).toBeUndefined();
  const s = { pid: 1, at: 1000, connected: true, messageContent: true };
  expect(gatewayView(s, 1000 + 59_000).state).toBe("live");
  expect(gatewayView(s, 1000 + 61_000).state).toBe("stale");
});

test("memory check: memoryCheck.repo or omo's repo for defaultCwd, WARN over maxKb or when nothing is found", async () => {
  const f = fixture();
  const real = { ...f.deps, exists: existsSync };
  expect(find(await runDoctor(real), "memory check").level).toBe("OK");
  const discovered = { ...real, config: { ...real.config, memoryCheck: { ...real.config.memoryCheck, repo: "" } } };
  const missing = find(await runDoctor(discovered), "memory check");
  expect(missing.level).toBe("WARN");
  expect(missing.fix).toContain("memoryCheck.repo");
  const agent = join(f.deps.home, ".omo", "memory", "agents", `lead-${createHash("sha256").update(f.deps.config.defaultCwd).digest("hex").slice(0, 8)}`, "repo", "system");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "human.md"), "x".repeat(16 * 1024));
  const over = find(await runDoctor(discovered), "memory check");
  expect(over.level).toBe("WARN");
  expect(over.detail).toContain(agent);
  expect(over.detail).toContain("over memoryCheck.maxKb 15");
});

test("item 6: doctor fails on lanes whose recovery is exhausted and warns on lanes still pending recovery", async () => {
  const f = fixture();
  const registry = new Registry(f.deps.config.stateDir);
  const base = { title: "t", thread: "none", brief: "/b", done: "d", openedAt: new Date(NOW).toISOString() };
  await registry.write({ ...base, key: "dead-lane", recoveryPending: true, recoveryAttempts: 3, recoveryExhausted: true } as Parameters<Registry["write"]>[0]);
  await registry.write({ ...base, key: "held-lane", recoveryPending: true, recoveryBlocked: "quota 1/1 p accounts blocked" } as Parameters<Registry["write"]>[0]);
  await registry.write({ ...base, key: "fine-lane" });
  const checks = (await runDoctor(f.deps)).filter((c) => c.id === "lane recovery");
  expect(checks.map((c) => [c.level, c.detail])).toEqual([
    ["FAIL", "exhausted, not relaunched or nudged: dead-lane (3 attempts)"],
    ["WARN", "pending, not nudged: held-lane (quota 1/1 p accounts blocked)"],
  ]);
  expect(doctorExit(await runDoctor(f.deps))).toBe(1);
});

test("claude quota shows the cached read with the 5h lane hold line in force, near the reset or not", async () => {
  const f = fixture();
  expect(find(await runDoctor(f.deps), "claude quota")).toEqual({ id: "claude quota", level: "OK", detail: "no usage read yet (dori quota reads it)" });
  writeQuotaState(f.deps.config.stateDir, { mode: "brief", holdsLanes: true, usage: { at: NOW - 2 * 60_000, accounts: [{ name: "a", fiveHour: { usedPct: 95, resetAt: NOW + 61 * 60_000 }, weekly: { usedPct: 40 } }] } });
  expect(find(await runDoctor(f.deps), "claude quota").detail).toBe("brief, headroom 24% (hold-lanes < 50%, brief < 25%), a 5h 95% 7d 40%, lanes held, read 2m ago");
  writeQuotaState(f.deps.config.stateDir, { mode: "hold-lanes", holdsLanes: true, usage: { at: NOW, accounts: [{ name: "a", fiveHour: { usedPct: 85, resetAt: NOW + 3 * 3_600_000 } }, { name: "b", fiveHour: { usedPct: 100 } }] } });
  expect(find(await runDoctor(f.deps), "claude quota").detail).toBe("hold-lanes, headroom 25% (hold-lanes < 50%, brief < 25%), a 5h 85% 7d ?, b 5h 100% 7d ?, lanes held, read 0m ago");
});
