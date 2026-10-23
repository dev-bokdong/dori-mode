import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { gateVerdict, headroomNote, readQuotaState, stateHoldsLanes } from "./claude-quota.ts";
import { configPath, defaultConfig, leadModels, loadConfig, providerOf, type DoriConfig } from "./config.ts";
import { gatewayView, readGatewayStatus } from "./gateway-status.ts";
import { githubSummary } from "./github-events.ts";
import { pendingLeadRestart } from "./lead-restart.ts";
import { MEMORY_FILE, resolveMemoryRepo } from "./memory-check.ts";
import { fetchHttp, type Http } from "./messenger/http.ts";
import { listPanes } from "./panes.ts";
import type { RecoveryLane } from "./recover.ts";
import { Registry, statusOf } from "./registry.ts";
import { type Clock, realClock, type Runner, run } from "./run.ts";
import { LEGACY_PRESENCE, SERVICES, unitState } from "./status.ts";

export type Level = "OK" | "WARN" | "FAIL";
export type Check = { readonly id: string; readonly level: Level; readonly detail: string; readonly fix?: string };

export type DoctorDeps = {
  readonly run: Runner;
  readonly http: Http;
  readonly clock: Clock;
  readonly config: DoriConfig;
  readonly configPath: string;
  readonly configError?: string;
  readonly envPath: string;
  readonly token?: string;
  readonly tokenSource?: "file" | "env";
  readonly exists: (path: string) => boolean;
  /** Where omo memory is looked for when memoryCheck.repo is blank. */
  readonly home: string;
};

const ok = (id: string, detail: string): Check => ({ id, level: "OK", detail });
const warn = (id: string, detail: string, fix: string): Check => ({ id, level: "WARN", detail, fix });
const fail = (id: string, detail: string, fix: string): Check => ({ id, level: "FAIL", detail, fix });

const T = { timeoutMs: 5_000 };
const API = "https://discord.com/api/v10";
const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const RESTART = "systemctl --user restart dori-supervisor.service";

export const tokenFrom = (envText: string | undefined): string | undefined => {
  const m = /^\s*(?:export\s+)?DORI_DISCORD_TOKEN=(.*)$/m.exec(envText ?? "");
  const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return v || undefined;
};

const units = async (d: DoctorDeps): Promise<Check[]> => {
  const checks: Check[] = [];
  const [herdrUnit, supUnit] = await Promise.all(SERVICES.map((name) => unitState(d.run, name)));
  const [legacy, procs] = await Promise.all([unitState(d.run, LEGACY_PRESENCE), d.run(["pgrep", "-f", "(dori|cli\\.ts) presence"], T)]);
  for (const u of [herdrUnit, supUnit]) {
    if (!u) continue;
    const id = `unit ${u.name.replace(/\.service$/, "")}`;
    if (u.enabled === "enabled" && u.active === "active") checks.push(ok(id, "enabled, active"));
    else if (u.enabled === "not-found" || u.active === "unknown") checks.push(fail(id, `not installed (${u.enabled}/${u.active})`, "dori setup --autostart"));
    else checks.push(fail(id, `${u.enabled}, ${u.active}`, `systemctl --user enable --now ${u.name}`));
  }
  const pids = procs.code === 0 ? procs.out.split("\n").filter(Boolean) : [];
  const unitOn = legacy.enabled === "enabled" || ["active", "activating"].includes(legacy.active);
  if (unitOn) checks.push(warn("legacy presence", `${LEGACY_PRESENCE} is ${legacy.enabled}/${legacy.active}; two gateways risk double replies`, `systemctl --user disable --now ${LEGACY_PRESENCE}`));
  else if (pids.length) checks.push(warn("legacy presence", `stray 'dori presence' process (pid ${pids.join(", ")})`, `kill ${pids.join(" ")}`));
  else checks.push(ok("legacy presence", "none running"));
  return checks;
};

const herdr = async (d: DoctorDeps): Promise<Check[]> => {
  const up = await d.run(["herdr", "workspace", "list"], T);
  if (up.code !== 0) return [fail("herdr", "server not reachable", "systemctl --user start herdr-server.service")];
  const procs = await d.run(["pgrep", "-f", "herdr server"], T);
  const n = procs.code === 0 ? procs.out.split("\n").filter(Boolean).length : 0;
  return [n > 1
    ? fail("herdr", `${n} herdr server processes`, "keep the unit's server and stop the others: pgrep -af 'herdr server'")
    : ok("herdr", "reachable, one server")];
};

const paths = async (d: DoctorDeps): Promise<Check[]> => {
  const wd = await d.run(["systemctl", "--user", "show", "dori-supervisor.service", "--property=WorkingDirectory", "--value"], T);
  const dir = wd.out.trim();
  const checks: Check[] = [];
  if (wd.code !== 0 || !dir) checks.push(fail("supervisor WorkingDirectory", "unit has no WorkingDirectory (status 200/CHDIR)", "dori setup --autostart"));
  else checks.push(d.exists(dir) ? ok("supervisor WorkingDirectory", dir) : fail("supervisor WorkingDirectory", `${dir} does not exist`, `mkdir -p ${dir}`));
  for (const [name, path] of [["defaultCwd", d.config.defaultCwd], ["stateDir", d.config.stateDir]] as const) {
    checks.push(d.exists(path) ? ok(name, path) : fail(name, `${path} does not exist`, `mkdir -p ${path}`));
  }
  return checks;
};

const isDiscord = (d: DoctorDeps): boolean => Boolean(d.config.discord) || d.config.discordChannels.length > 0 || d.token !== undefined;

const config = async (d: DoctorDeps): Promise<Check[]> => {
  if (d.configError) return [fail("config", `${d.configPath} does not load: ${d.configError}`, "fix the JSON, or dori setup")];
  if (!d.exists(d.configPath)) return [fail("config", `${d.configPath} is missing`, "dori setup")];
  const c = d.config;
  const missing = [
    ...(c.leadPane ? [] : ["leadPane"]), ...(c.laneWorkspace ? [] : ["laneWorkspace"]), ...(c.defaultModel ? [] : ["defaultModel"]),
    ...(c.discordChannels.length ? [] : ["discordChannels"]),
    ...(isDiscord(d) ? (["applicationId", "guildId", "ownerId"] as const).filter((k) => !/^\d+$/.test(c.discord?.[k] ?? "")).map((k) => `discord.${k}`) : []),
  ];
  const checks: Check[] = [missing.length
    ? fail("config", `missing or invalid: ${missing.join(", ")}`, "dori setup")
    : ok("config", "required keys present")];
  // Set but blank falls back to defaultModel / agentCommand's thinking, which is rarely what was meant.
  const blank = (["leadModel", "leadThinking"] as const).filter((k) => {
    const value: unknown = c[k];
    return k in c && !Array.isArray(value) && !(typeof value === "string" && value.trim());
  });
  if (blank.length) checks.push(warn("lead command", `${blank.join(", ")} set but blank; the lead uses the lane default`, `set a value or remove ${blank.join(", ")} from ${d.configPath}`));
  checks.push(...leadChain(d));
  const pending = pendingLeadRestart(c.stateDir);
  if (pending) checks.push(warn("lead restart", `request ${pending.id}: ${pending.models.map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> ")}; applies at the next idle boundary, even below the context cap`, "wait for the lead to become idle; the supervisor applies the queued restart"));
  if (c.leadPane) {
    try {
      const found = (await listPanes(d.run)).some((p) => p.pane_id === c.leadPane);
      checks.push(found ? ok("leadPane", `${c.leadPane} exists in herdr`) : fail("leadPane", `${c.leadPane} is not a herdr pane`, "dori lead-restart"));
    } catch {
      checks.push(fail("leadPane", "cannot list herdr panes", "systemctl --user start herdr-server.service"));
    }
  }
  return checks;
};

/** A leadModel array: every entry usable, with a provider the quota check can name, and a quotaCheck without credentials. */
const leadChain = (d: DoctorDeps): Check[] => {
  const raw: unknown = d.config.leadModel;
  if (!Array.isArray(raw)) return [];
  const fix = `each leadModel entry is "provider/model" or {"model": "provider/model", "thinking": "..."} in ${d.configPath}`;
  const bad = raw.flatMap((entry: unknown, i) => {
    const model = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && "model" in entry && typeof entry.model === "string" ? entry.model : "";
    const thinking = typeof entry === "object" && entry !== null && "thinking" in entry ? entry.thinking : undefined;
    return !model.trim() || !providerOf(model.trim()) || (thinking !== undefined && typeof thinking !== "string") ? [`#${i + 1}`] : [];
  });
  const checks: Check[] = [bad.length
    ? warn("lead model chain", `unusable entries ${bad.join(", ")} are skipped`, fix)
    : ok("lead model chain", leadModels(d.config).map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> "))];
  if (d.config.quotaCheck.some((part) => part.startsWith("--credentials"))) {
    checks.push(fail("quota check", "quotaCheck asks for --credentials; it is refused and quota stalls are never detected", `remove --credentials from quotaCheck in ${d.configPath}`));
  } else if (!d.config.quotaCheck.some((part) => part.includes("{provider}"))) {
    checks.push(warn("quota check", "quotaCheck has no {provider}; every provider gets the same answer", `put {provider} in quotaCheck in ${d.configPath}`));
  }
  return checks;
};

const discord = async (d: DoctorDeps): Promise<Check[]> => {
  if (!isDiscord(d)) return [ok("discord", "not configured; skipped")];
  if (!d.token) return [fail("discord token", `DORI_DISCORD_TOKEN is not in ${d.envPath}`, "dori setup --token-file FILE")];
  const get = (path: string) => d.http({ method: "GET", url: `${API}${path}`, headers: { Authorization: `Bot ${d.token}` }, signal: AbortSignal.timeout(10_000) })
    .catch(() => ({ status: 0, headers: {}, body: "" }));
  const json = (body: string): unknown => { try { return JSON.parse(body); } catch { return undefined; } };
  const checks: Check[] = [];
  const me = await get("/users/@me");
  if (me.status !== 200) {
    const why = me.status === 0 ? "Discord API unreachable" : me.status === 401 ? "token rejected (401)" : `HTTP ${me.status}`;
    return [fail("discord token", why, me.status === 0 ? "check the network, then rerun dori doctor" : "dori setup --token-file FILE (reset the token in the Developer Portal if needed)")];
  }
  const name = (json(me.body) as { username?: unknown } | undefined)?.username;
  checks.push(d.tokenSource === "env"
    ? warn("discord token", "works, but only from the shell environment; the units read the env file", `add DORI_DISCORD_TOKEN to ${d.envPath} (dori setup --token-file FILE)`)
    : ok("discord token", `works${typeof name === "string" ? ` (bot ${name})` : ""}`));
  const dc = d.config.discord;
  const [guilds, app, chans] = await Promise.all([
    get("/users/@me/guilds"), get("/applications/@me"),
    Promise.all(d.config.discordChannels.map(async (id) => [id, (await get(`/channels/${id}/messages?limit=1`)).status] as const)),
  ]);
  if (dc) {
    const list = json(guilds.body);
    checks.push(guilds.status === 200 && Array.isArray(list) && list.some((g) => (g as { id?: unknown }).id === dc.guildId)
      ? ok("bot in guild", dc.guildId)
      : fail("bot in guild", guilds.status === 200 ? `bot is not in guild ${dc.guildId}` : `guild list HTTP ${guilds.status}`, "invite the bot: Developer Portal > OAuth2 > URL Generator (bot + applications.commands)"));
  }
  const bad = chans.filter(([, status]) => status !== 200);
  checks.push(bad.length
    ? fail("channels", bad.map(([id, s]) => `${id}: ${s === 403 ? "no access" : s === 404 ? "unknown channel" : `HTTP ${s}`}`).join("; "), "give the bot View Channel + Read Message History on each channel, or fix discordChannels")
    : ok("channels", `${chans.length} readable`));
  const flags = (json(app.body) as { flags?: unknown } | undefined)?.flags;
  checks.push(app.status !== 200 || typeof flags !== "number"
    ? warn("message content intent", `cannot read application flags (HTTP ${app.status})`, "check in the Developer Portal > Bot > Message Content Intent")
    : flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)
      ? ok("message content intent", "enabled")
      : warn("message content intent", "not enabled; inbound text falls back to REST and can be empty", `Developer Portal > your application > Bot > enable Message Content Intent, then ${RESTART}`));
  if (dc) {
    const cmds = await get(`/applications/${dc.applicationId}/guilds/${dc.guildId}/commands`);
    const names = Array.isArray(json(cmds.body)) ? (json(cmds.body) as { name?: unknown }[]).map((c) => c.name) : [];
    const gone = ["quota", "status"].filter((n) => !names.includes(n));
    checks.push(cmds.status !== 200
      ? warn("slash commands", `cannot list guild commands (HTTP ${cmds.status})`, RESTART)
      : gone.length ? warn("slash commands", `not registered: ${gone.map((n) => `/${n}`).join(", ")}`, RESTART) : ok("slash commands", "/quota and /status registered"));
  }
  return checks;
};

const gateway = (d: DoctorDeps): Check[] => {
  const v = gatewayView(readGatewayStatus(d.config.stateDir), d.clock.now());
  if (v.state === "live") return [ok("gateway", v.text)];
  if (v.state === "no-content") return [warn("gateway", v.text, "enable Message Content Intent in the Developer Portal, then " + RESTART)];
  return [fail("gateway", v.text, RESTART)];
};

const issues = (d: DoctorDeps): Check[] => {
  const gh = githubSummary(d.config.stateDir);
  const poll = gh.polledAt === undefined ? "never polled" : `last poll ${new Date(gh.polledAt).toISOString().slice(0, 19)}Z`;
  const detail = `${gh.issueRepos.length} repos with an issue baseline, ${poll}`;
  return [d.config.githubIssueAuthors.length
    ? ok("github issues", `trusted authors ${d.config.githubIssueAuthors.join(", ")}; ${detail}`)
    : ok("github issues", `no trusted authors (githubIssueAuthors; set with dori setup), new issues stay digest; ${detail}`)];
};

/** memoryCheck: the lead's human.md is found and within maxKb. */
const memory = (d: DoctorDeps): Check[] => {
  const m = d.config.memoryCheck;
  const repo = resolveMemoryRepo(d.config, d.home);
  const file = repo ? `${repo}/${MEMORY_FILE}` : undefined;
  const limit = Math.round(m.maxKb * 1024);
  const checks: Check[] = [];
  if (!file || !d.exists(file)) {
    checks.push(warn("memory check", file ? `${file} does not exist` : `no omo memory repo for ${d.config.defaultCwd}; dori memory check and its sweep are off`, `set memoryCheck.repo to the lead's omo memory repo in ${d.configPath}`));
  } else {
    const bytes = statSync(file).size;
    checks.push(bytes > limit
      ? warn("memory check", `${file} is ${(bytes / 1024).toFixed(1)}KB, over memoryCheck.maxKb ${m.maxKb}`, "dori memory check, then the lead condenses human.md")
      : ok("memory check", `${file} ${(bytes / 1024).toFixed(1)}KB of ${m.maxKb}KB`));
  }
  return checks;
};

const tools = async (d: DoctorDeps): Promise<Check[]> => {
  const [gh, auth, jq, bun, df] = await Promise.all([
    d.run(["gh", "--version"], T), d.run(["gh", "auth", "status"], T), d.run(["jq", "--version"], T), d.run(["bun", "--version"], T),
    d.run(["df", "-Pk", [d.config.stateDir, d.config.defaultCwd].find((p) => d.exists(p)) ?? "/"], T),
  ]);
  const checks: Check[] = [
    gh.code !== 0 ? fail("gh", "not installed", "install gh: https://cli.github.com")
      : auth.code !== 0 ? fail("gh", "not authenticated", "gh auth login") : ok("gh", "installed, authenticated"),
    jq.code === 0 ? ok("jq", jq.out) : fail("jq", "not installed", "sudo apt install jq"),
    bun.code === 0 ? ok("bun", bun.out) : fail("bun", "not installed", "curl -fsSL https://bun.sh/install | bash"),
  ];
  const free = Number(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3]) / 1024 / 1024;
  const min = d.config.guard.diskFreeMinGb;
  checks.push(df.code !== 0 || !Number.isFinite(free) ? warn("disk", "cannot read free space", "df -h")
    : free < min ? warn("disk", `${free.toFixed(1)} GB free, guard.diskFreeMinGb is ${min}`, "free disk space or lower guard.diskFreeMinGb in config.json")
    : ok("disk", `${free.toFixed(1)} GB free (guard ${min})`));
  return checks;
};

/** Open lanes waiting on recovery (freshness skips them): exhausted is a FAIL, still pending a WARN. Nothing when none. */
const recovery = async (d: DoctorDeps): Promise<Check[]> => {
  const registry = new Registry(d.config.stateDir);
  if (!d.exists(registry.dir)) return [];
  let lanes: RecoveryLane[];
  try { lanes = (await registry.open()).filter((l) => l.recoveryPending && statusOf(l) !== "closed"); }
  catch (e) { return [warn("lane recovery", `cannot read lanes: ${e instanceof Error ? e.message : String(e)}`, `check ${registry.dir}`)]; }
  const exhausted = lanes.filter((l) => l.recoveryExhausted);
  const pending = lanes.filter((l) => !l.recoveryExhausted);
  return [
    ...(exhausted.length ? [fail("lane recovery", `exhausted, not relaunched or nudged: ${exhausted.map((l) => `${l.key} (${l.recoveryAttempts ?? 0} attempts)`).join(", ")}`, "inspect each lane's pane, then relaunch it by hand or dori close <key>")] : []),
    ...(pending.length ? [warn("lane recovery", `pending, not nudged: ${pending.map((l) => `${l.key}${l.recoveryBlocked ? ` (${l.recoveryBlocked})` : ""}`).join(", ")}`, "the supervisor's recover sweep retries; dori recover <key> runs it now")] : []),
  ];
};

/** The last Claude usage read (the supervisor's cache) with its summed headroom; informational, never WARN. */
const claudeQuota = (d: DoctorDeps): Check[] => {
  const s = readQuotaState(d.config.stateDir);
  if (!s) return [ok("claude quota", "no usage read yet (dori quota reads it)")];
  const pct = (w: { readonly usedPct: number } | undefined): string => (w ? `${w.usedPct}%` : "?");
  const age = Math.max(0, Math.round((d.clock.now() - s.usage.at) / 60_000));
  const accounts = s.usage.accounts.map((a) => `${a.name} 5h ${pct(a.fiveHour)} 7d ${pct(a.weekly)}`).join(", ");
  return [ok("claude quota", `${s.mode}, ${headroomNote(gateVerdict(s.usage, d.config.quotaGate))}, ${accounts}, lanes ${stateHoldsLanes(s) ? "held" : "allowed"}, read ${age}m ago`)];
};

/** Read-only: every probe is a status query or a GET. */
export const runDoctor = async (d: DoctorDeps): Promise<Check[]> =>
  (await Promise.all([units(d), herdr(d), paths(d), config(d), discord(d), Promise.resolve(gateway(d)), Promise.resolve(issues(d)), Promise.resolve(memory(d)), Promise.resolve(claudeQuota(d)), tools(d), recovery(d)])).flat();

export const doctorExit = (checks: readonly Check[]): number => (checks.some((c) => c.level === "FAIL") ? 1 : 0);

export const renderDoctor = (checks: readonly Check[]): string => {
  const count = (l: Level) => checks.filter((c) => c.level === l).length;
  return [
    ...checks.flatMap((c) => [`${c.level.padEnd(4)} ${c.id}: ${c.detail}`, ...(c.fix && c.level !== "OK" ? [`     fix: ${c.fix}`] : [])]),
    `DOCTOR ok=${count("OK")} warn=${count("WARN")} fail=${count("FAIL")}`,
  ].join("\n");
};

export const realDoctorDeps = async (): Promise<DoctorDeps> => {
  const path = configPath();
  let cfg = defaultConfig();
  let configError: string | undefined;
  try { cfg = await loadConfig(path); } catch (e) { configError = e instanceof Error ? e.message : String(e); }
  const envPath = join(homedir(), ".dori", "env");
  const fromFile = tokenFrom(existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined);
  const token = fromFile ?? process.env.DORI_DISCORD_TOKEN;
  return {
    run, http: fetchHttp, clock: realClock, config: cfg, configPath: path, ...(configError ? { configError } : {}), envPath,
    ...(token ? { token, tokenSource: fromFile ? "file" as const : "env" as const } : {}), exists: existsSync, home: homedir(),
  };
};

/** Prints the report and returns the exit code. */
export const doctorMain = async (log: (line: string) => void = console.log): Promise<number> => {
  const checks = await runDoctor(await realDoctorDeps());
  log(renderDoctor(checks));
  return doctorExit(checks);
};
