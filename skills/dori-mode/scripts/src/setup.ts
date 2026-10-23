import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultConfig, expandHome, type DiscordConfig } from "./config.ts";
import type { Http } from "./messenger/http.ts";
import { listPanes } from "./panes.ts";
import { Repos } from "./repos.ts";
import type { Runner } from "./run.ts";

export class SetupError extends Error {}

export const TOKEN_KEY = "DORI_DISCORD_TOKEN";
export const LEAD_WORKSPACE = "Dori";
export const LANES_WORKSPACE = "lanes";
export const UNITS = ["herdr-server.service", "dori-supervisor.service"] as const;
export const BOOT_PREP = "dori-boot-prep.sh";
/** Started by OnFailure= of the units above; never enabled itself. */
export const NOTIFY_UNIT = "dori-failure-notify@.service";
export const FAILURE_NOTIFY = "dori-failure-notify.sh";

/** How setup asks. The non-interactive prompter answers every question with its default. */
export type Prompter = {
  readonly ask: (question: string, current: string) => Promise<string>;
  /** Reads a secret without echo. An empty answer keeps the stored one. */
  readonly secret: (question: string, isSet: boolean) => Promise<string>;
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>;
};

export type SetupDeps = {
  readonly run: Runner;
  readonly http: Http;
  readonly prompt: Prompter;
  readonly log: (line: string) => void;
  readonly interactive: boolean;
  readonly home: string;
  readonly user: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly unitDir: string;
  readonly templatesDir: string;
  readonly bins: { readonly dori: string; readonly herdr?: string; readonly shell: string };
};

export type SetupInput = {
  readonly token?: string;
  readonly channels?: readonly string[];
  readonly model?: string;
  readonly cwd?: string;
  readonly stateDir?: string;
  /** GitHub logins whose new issues start work (githubIssueAuthors). */
  readonly issueAuthors?: readonly string[];
  /** Create or reuse the herdr lead pane and lanes workspace (default yes). */
  readonly herdr?: boolean;
  /** Install and enable the systemd user units (default no). */
  readonly autostart?: boolean;
};

type Json = Record<string, unknown>;

export const writeFileAtomic = (path: string, content: string, mode: number): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", mode);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
};

export const readConfigObject = (path: string): Json => {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SetupError(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it or move it away, then run setup again`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SetupError(`${path} must hold a JSON object`);
  return parsed as Json;
};

export const mergeConfig = (existing: Json, patch: Json): Json => {
  const out: Json = { ...existing };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out;
};

export const saveConfig = (path: string, existing: Json, next: Json): boolean => {
  if (existsSync(path) && JSON.stringify(existing) === JSON.stringify(next)) return false;
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return true;
};

const envLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);

export const envGet = (text: string, key: string): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const m = envLine(key).exec(line);
    if (m) return (m[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
};

export const envSet = (text: string, key: string, value: string): string => {
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const at = lines.findIndex((l) => envLine(key).test(l));
  const entry = `${key}=${value}`;
  if (at >= 0) lines[at] = entry;
  else lines.push(entry);
  return `${lines.join("\n")}\n`;
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

export type ChannelCheck = { readonly id: string; readonly ok: boolean; readonly detail: string };

export const verifyChannel = async (http: Http, token: string, id: string): Promise<ChannelCheck> => {
  if (!/^\d{15,22}$/.test(id)) return { id, ok: false, detail: "not a channel id (Discord ids are 17-20 digits; right-click the channel, Copy Channel ID)" };
  try {
    const r = await http({ method: "GET", url: `https://discord.com/api/v10/channels/${id}`, headers: { Authorization: `Bot ${token}` } });
    if (r.status === 200) {
      const name = (JSON.parse(r.body) as { name?: string }).name;
      return { id, ok: true, detail: name ? `#${name}` : "readable" };
    }
    const why: Record<number, string> = {
      401: "the bot token was rejected (401); check the token in the Developer Portal",
      403: "the bot cannot see this channel (403 Missing Access); invite it to the server and allow View Channel and Read Message History",
      404: "no such channel (404), or it is in a server the bot is not in",
    };
    return { id, ok: false, detail: why[r.status] ?? `Discord answered HTTP ${r.status}` };
  } catch (e) {
    return { id, ok: false, detail: `request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
};

export const parseChannels = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

const herdrJson = async (run: Runner, argv: readonly string[]): Promise<Json> => {
  const r = await run(["herdr", ...argv]);
  if (r.code !== 0) throw new SetupError(`herdr ${argv.join(" ")} failed: ${r.err || r.out}`);
  try {
    return JSON.parse(r.out) as Json;
  } catch {
    return {};
  }
};

const workspaceByLabel = async (run: Runner, label: string): Promise<string | undefined> => {
  const list = (await herdrJson(run, ["workspace", "list"])) as { result?: { workspaces?: { label?: string; workspace_id?: string }[] } };
  return list.result?.workspaces?.find((w) => w.label === label)?.workspace_id;
};

export const ensureWorkspace = async (run: Runner, label: string): Promise<{ id: string; created: boolean }> => {
  const found = await workspaceByLabel(run, label);
  if (found) return { id: found, created: false };
  await herdrJson(run, ["workspace", "create", "--label", label, "--no-focus"]);
  const id = await workspaceByLabel(run, label);
  if (!id) throw new SetupError(`cannot create herdr workspace ${label}`);
  return { id, created: true };
};

const exists = async (run: Runner, kind: "pane" | "workspace", id: string): Promise<boolean> => Boolean(id) && (await run(["herdr", kind, "get", id])).code === 0;

export type HerdrResult = { readonly patch: Json; readonly lines: string[] };

/**
 * Same steps as the boot prep script: keep the lead pane and lanes workspace from the config when they still exist,
 * otherwise create them. A new lanes workspace starts with a shell pane that is not a lane, so it goes on ignorePanes.
 */
export const ensureHerdr = async (run: Runner, current: Json, leadCwd: string): Promise<HerdrResult> => {
  const lines: string[] = [];
  const patch: Json = {};
  const lead = str(current.leadPane);
  if (lead && (await exists(run, "pane", lead))) lines.push(`SETUP herdr lead pane ${lead} reused`);
  else {
    const ws = await ensureWorkspace(run, LEAD_WORKSPACE);
    const tab = (await herdrJson(run, ["tab", "create", "--workspace", ws.id, "--cwd", leadCwd, "--label", "dori-lead", "--no-focus"])) as { result?: { root_pane?: { pane_id?: string } } };
    const pane = tab.result?.root_pane?.pane_id;
    if (!pane) throw new SetupError("herdr tab create returned no pane id for the lead");
    patch.leadPane = pane;
    lines.push(`SETUP herdr lead pane ${pane} created in workspace ${LEAD_WORKSPACE} (${ws.id})${lead ? `; ${lead} was gone` : ""}`);
  }
  const oldLanes = str(current.laneWorkspace);
  const known = strings(current.workspaces);
  const ignore = strings(current.ignorePanes);
  let lanes = oldLanes;
  if (oldLanes && (await exists(run, "workspace", oldLanes))) lines.push(`SETUP herdr lanes workspace ${oldLanes} reused`);
  else {
    const ws = await ensureWorkspace(run, LANES_WORKSPACE);
    lanes = ws.id;
    patch.laneWorkspace = lanes;
    if (ws.created) {
      const shells = (await listPanes(run)).filter((p) => p.workspace_id === lanes).map((p) => p.pane_id);
      patch.ignorePanes = [...new Set([...ignore, ...shells])];
    }
    lines.push(`SETUP herdr lanes workspace ${lanes} ${ws.created ? "created" : "found by label"}${oldLanes ? `; ${oldLanes} was gone` : ""}`);
  }
  const workspaces = [lanes, ...known.filter((w) => w !== lanes && w !== oldLanes)];
  if (JSON.stringify(workspaces) !== JSON.stringify(known)) patch.workspaces = workspaces;
  if (patch.ignorePanes === undefined && !Array.isArray(current.ignorePanes)) patch.ignorePanes = ignore;
  return { patch, lines };
};

export const renderTemplate = (text: string, values: Readonly<Record<string, string>>): string =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined) throw new SetupError(`template value {{${name}}} is missing`);
    if (/[\n\r]/.test(v)) throw new SetupError(`template value {{${name}}} spans lines`);
    return v;
  });

export const templateValues = (d: SetupDeps, workDir: string): Record<string, string> => {
  if (!d.bins.herdr) throw new SetupError("herdr is not on PATH; install it (https://herdr.dev) before turning on autostart");
  const bins = [dirname(d.bins.dori), dirname(d.bins.herdr), join(d.home, ".bun", "bin"), join(d.home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    HOME: d.home,
    PATH: [...new Set(bins)].join(":"),
    SHELL: d.bins.shell,
    DORI_BIN: d.bins.dori,
    HERDR_BIN: d.bins.herdr,
    ENV_FILE: d.envPath,
    CONFIG: d.configPath,
    WORK_DIR: workDir,
    BOOT_PREP: join(dirname(d.envPath), BOOT_PREP),
    FAILURE_NOTIFY: join(dirname(d.envPath), FAILURE_NOTIFY),
  };
};

export const renderAutostart = (d: SetupDeps, workDir: string): Map<string, { content: string; mode: number }> => {
  const values = templateValues(d, workDir);
  const out = new Map<string, { content: string; mode: number }>();
  for (const unit of [...UNITS, NOTIFY_UNIT]) out.set(join(d.unitDir, unit), { content: renderTemplate(readFileSync(join(d.templatesDir, unit), "utf8"), values), mode: 0o644 });
  out.set(values.BOOT_PREP as string, { content: renderTemplate(readFileSync(join(d.templatesDir, BOOT_PREP), "utf8"), values), mode: 0o755 });
  out.set(values.FAILURE_NOTIFY as string, { content: renderTemplate(readFileSync(join(d.templatesDir, FAILURE_NOTIFY), "utf8"), values), mode: 0o755 });
  return out;
};

const str = (v: unknown): string => (typeof v === "string" && !v.startsWith("<") ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !x.startsWith("<")) : []);

const askToken = async (d: SetupDeps, stored: string | undefined, given: string | undefined): Promise<string | undefined> => {
  const typed = (await d.prompt.secret("Discord bot token", Boolean(given ?? stored))).trim();
  const token = typed || given || stored;
  if (token && !/^[\w.-]+$/.test(token)) throw new SetupError("the bot token has characters a Discord token never has (spaces, quotes or newlines); paste it again");
  return token;
};

const askChannels = async (d: SetupDeps, token: string | undefined, initial: readonly string[]): Promise<string[]> => {
  let current = [...initial];
  for (;;) {
    const channels = parseChannels(await d.prompt.ask("Main Discord channel id(s), comma separated", current.join(",")));
    if (!channels.length || !token) {
      if (channels.length) d.log("SETUP channels not verified: no bot token yet");
      return channels;
    }
    const checks = await Promise.all(channels.map((id) => verifyChannel(d.http, token, id)));
    for (const c of checks) d.log(`SETUP channel ${c.id} ${c.ok ? "ok" : "FAILED"}: ${c.detail}`);
    if (checks.every((c) => c.ok)) return channels;
    if (!d.interactive) throw new SetupError(`the bot cannot read channel(s) ${checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}; nothing was written`);
    if (await d.prompt.confirm("Keep these channels anyway?", false)) return channels;
    current = channels;
  }
};

const askDiscord = async (d: SetupDeps, token: string, channel: string, existing: unknown): Promise<DiscordConfig> => {
  const metadata = async (path: string): Promise<Json> => {
    let result;
    try {
      result = await d.http({ method: "GET", url: `https://discord.com/api/v10${path}`, headers: { Authorization: `Bot ${token}` } });
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      throw new SetupError(`cannot read Discord ${path}; nothing was written`);
    }
    if (result.status !== 200) throw new SetupError(`Discord ${path} answered HTTP ${result.status}; nothing was written`);
    const value: unknown = JSON.parse(result.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SetupError(`Discord ${path} returned invalid metadata`);
    return value as Json;
  };
  const app = await metadata("/oauth2/applications/@me");
  const room = await metadata(`/channels/${channel}`);
  const prior = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Json : {};
  const owner = app.owner && typeof app.owner === "object" && "id" in app.owner ? str(app.owner.id) : "";
  const applicationId = str(prior.applicationId) || str(app.id);
  const guildId = str(prior.guildId) || str(room.guild_id);
  const ownerId = (await d.prompt.ask("Discord owner user id for slash commands", str(prior.ownerId) || owner)).trim();
  if (![applicationId, guildId, ownerId].every((id) => /^\d{15,22}$/.test(id))) {
    throw new SetupError("Discord application, guild and owner ids must be snowflakes; use a server channel and a Discord owner user id");
  }
  return { applicationId, guildId, ownerId };
};

export const runSetup = async (d: SetupDeps, input: SetupInput = {}): Promise<number> => {
  const problems: string[] = [];
  const raw = readConfigObject(d.configPath);
  const envText = existsSync(d.envPath) ? readFileSync(d.envPath, "utf8") : "";
  const base = defaultConfig(d.home);

  const storedToken = envGet(envText, TOKEN_KEY) || undefined;
  const token = await askToken(d, storedToken, input.token);
  const channels = await askChannels(d, token, input.channels ?? strings(raw.discordChannels));
  const discord = token && channels[0] ? await askDiscord(d, token, channels[0], raw.discord) : undefined;
  const defaultModel = (await d.prompt.ask("Default model for lanes (and the lead unless a lead model is set)", input.model ?? (str(raw.defaultModel) || base.defaultModel))).trim();
  // A fallback chain (array) is edited in config.json; setup keeps it as written.
  const chain = Array.isArray(raw.leadModel) ? raw.leadModel : undefined;
  const leadModel = chain ? "" : (await d.prompt.ask("Lead model (empty = same as the lane default)", str(raw.leadModel))).trim();
  const defaultCwd = (await d.prompt.ask("Default working directory for new lanes", input.cwd ?? (str(raw.defaultCwd) || "~"))).trim();
  const stateDir = (await d.prompt.ask("State directory", input.stateDir ?? (str(raw.stateDir) || "~/.dori/state"))).trim();
  const repos = new Repos(expandHome(stateDir, d.home));
  const watchedRepos = (await d.prompt.ask("GitHub repos to watch (owner/repo, comma separated; optional)", repos.list().join(",")))
    .split(/[\s,]+/).filter(Boolean);
  const issueAuthors = parseChannels((await d.prompt.ask(
    "GitHub accounts whose new issues start work automatically (comma separated; optional)",
    (input.issueAuthors ?? strings(raw.githubIssueAuthors)).join(","),
  )).toLowerCase());
  const badAuthor = issueAuthors.find((a) => !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(a));
  if (badAuthor) throw new SetupError(`${badAuthor} is not a GitHub login; nothing was written`);
  const workDir = expandHome(defaultCwd, d.home);
  for (const dir of [workDir, expandHome(stateDir, d.home)]) ensureDir(d, dir);
  repos.replace(watchedRepos);

  if (token) {
    const next = envSet(envText, TOKEN_KEY, token);
    const changed = next !== envText || !existsSync(d.envPath) || modeOf(d.envPath) !== 0o600;
    if (changed) writeFileAtomic(d.envPath, next, 0o600);
    d.log(`SETUP env ${TOKEN_KEY} ${token === storedToken ? "kept" : "saved"} in ${d.envPath} (mode 600)${changed ? "" : ", unchanged"}`);
  } else d.log(`SETUP env no bot token; set ${TOKEN_KEY} later by running dori setup again`);

  let config = mergeConfig(raw, {
    discordChannels: channels, defaultModel, leadModel: chain ?? (leadModel || undefined), defaultCwd, stateDir, discord,
    // Keep configs that never set it byte-identical.
    githubIssueAuthors: issueAuthors.length || Array.isArray(raw.githubIssueAuthors) ? issueAuthors : undefined,
  });
  d.log(`SETUP config ${saveConfig(d.configPath, raw, config) ? "written" : "unchanged"}: ${d.configPath}`);

  let serverUp = false;
  if (await d.prompt.confirm("Create or reuse the herdr lead pane and lanes workspace?", input.herdr ?? true)) {
    if (!d.bins.herdr) {
      problems.push("herdr");
      d.log("SETUP herdr not found on PATH; install it (https://herdr.dev) and run dori setup again");
    } else if ((await d.run(["herdr", "workspace", "list"])).code !== 0) {
      problems.push("herdr");
      d.log("SETUP herdr server not reachable; start `herdr server` (or the herdr-server unit) and run dori setup again");
    } else {
      serverUp = true;
      try {
        const h = await ensureHerdr(d.run, config, workDir);
        for (const l of h.lines) d.log(l);
        const before = config;
        config = mergeConfig(config, h.patch);
        d.log(`SETUP config ${saveConfig(d.configPath, before, config) ? "updated with herdr ids" : "already has the herdr ids"}`);
      } catch (e) {
        problems.push("herdr");
        d.log(`SETUP herdr failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else d.log("SETUP herdr skipped");

  if (await d.prompt.confirm("Start herdr and the supervisor automatically at boot (systemd user units)?", input.autostart ?? false)) {
    problems.push(...(await autostart(d, workDir, serverUp)));
  } else d.log("SETUP autostart skipped");

  d.log(problems.length ? `SETUP_DONE with problems: ${[...new Set(problems)].join(", ")}` : "SETUP_DONE");
  return problems.length ? 2 : 0;
};

const ensureDir = (d: SetupDeps, dir: string): void => {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  d.log(`SETUP created ${dir}`);
};

const autostart = async (d: SetupDeps, workDir: string, serverUp: boolean): Promise<string[]> => {
  const problems: string[] = [];
  const files = renderAutostart(d, workDir);
  if (!(await d.prompt.confirm(`Write ${UNITS.join(", ")} to ${d.unitDir} and the boot prep script?`, true))) {
    d.log("SETUP autostart units not written; stopping autostart here");
    return problems;
  }
  ensureDir(d, d.unitDir);
  for (const [path, f] of files) {
    const same = existsSync(path) && readFileSync(path, "utf8") === f.content && modeOf(path) === f.mode;
    if (!same) writeFileAtomic(path, f.content, f.mode);
    d.log(`SETUP wrote ${path}${same ? " (unchanged)" : ""}`);
  }
  const step = async (question: string, argv: string[]): Promise<void> => {
    if (!(await d.prompt.confirm(`${question}\n  runs: ${argv.join(" ")}`, true))) {
      d.log(`SETUP skipped: ${argv.join(" ")}`);
      return;
    }
    const r = await d.run(argv);
    if (r.code === 0) d.log(`SETUP ran: ${argv.join(" ")}`);
    else {
      problems.push(argv[0] ?? "step");
      d.log(`SETUP FAILED (${r.code}): ${argv.join(" ")}: ${(r.err || r.out).slice(0, 300)}`);
    }
  };
  const linger = await d.run(["loginctl", "show-user", d.user, "--property=Linger"]);
  if (linger.code === 0 && linger.out.includes("Linger=yes")) d.log(`SETUP linger already on for ${d.user}`);
  else await step("Turn on linger so your user units run after boot without a login?", ["loginctl", "enable-linger", d.user]);
  await step("Reload systemd user units?", ["systemctl", "--user", "daemon-reload"]);
  const legacy = "dori-presence.service";
  const probe = ["systemctl", "--user", "list-unit-files", legacy, "--no-legend", "--no-pager"];
  const installed = await d.run(probe);
  if (installed.code !== 0) {
    d.log(`SETUP FAILED (${installed.code}): ${probe.join(" ")}: ${(installed.err || installed.out).slice(0, 300)}`);
    return [...problems, "systemctl"];
  }
  if (installed.out.split(/\s+/).includes(legacy)) {
    await step("Disable and stop the legacy presence unit? The supervisor now owns Discord presence and slash commands.", ["systemctl", "--user", "disable", "--now", legacy]);
  }
  await step("Enable the units so they start at boot?", ["systemctl", "--user", "enable", ...UNITS]);
  if (serverUp) {
    d.log("SETUP herdr server is already running (started by hand?); herdr-server.service is enabled but not started so it does not fight for the socket");
    d.log(`SETUP start the rest now with: systemctl --user start ${UNITS.filter((u) => u !== "herdr-server.service").join(" ")}`);
  } else d.log(`SETUP start them now with: systemctl --user start ${UNITS.join(" ")}`);
  return problems;
};
