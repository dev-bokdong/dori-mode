import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Http, HttpRequest } from "../src/messenger/http.ts";
import type { Ran, Runner } from "../src/run.ts";
import { Repos, ReposError } from "../src/repos.ts";
import { envGet, envSet, mergeConfig, type Prompter, renderTemplate, runSetup, saveConfig, type SetupDeps, SetupError, UNITS, NOTIFY_UNIT, FAILURE_NOTIFY } from "../src/setup.ts";
import { withState } from "./fakes.ts";

const TOKEN = "MTIz.fake-token_value";
const CHANNEL = "1100000000000000259";
const APPLICATION = "1100000000000000201";
const GUILD = "1100000000000000202";
const OWNER = "1100000000000000203";
const TEMPLATES = join(import.meta.dir, "..", "templates");

type Herdr = { workspaces: { workspace_id: string; label: string }[]; panes: { pane_id: string; workspace_id: string }[]; calls: string[][]; linger: boolean; presence?: { enabled: boolean; active: boolean } };

const fakeHerdr = (h: Herdr): Runner => async (argv) => {
  h.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const no: Ran = { code: 1, out: "", err: "not found" };
  const [cmd, a1, a2, a3] = argv;
  if (cmd === "herdr" && a1 === "workspace" && a2 === "list") return ok(JSON.stringify({ result: { workspaces: h.workspaces } }));
  if (cmd === "herdr" && a1 === "workspace" && a2 === "get") return h.workspaces.some((w) => w.workspace_id === a3) ? ok("{}") : no;
  if (cmd === "herdr" && a1 === "workspace" && a2 === "create") {
    const id = `w${h.workspaces.length + 1}`;
    h.workspaces.push({ workspace_id: id, label: argv[argv.indexOf("--label") + 1] ?? "" });
    h.panes.push({ pane_id: `${id}:p1`, workspace_id: id });
    return ok("{}");
  }
  if (cmd === "herdr" && a1 === "tab" && a2 === "create") {
    const ws = argv[argv.indexOf("--workspace") + 1] ?? "";
    const pane = `${ws}:p${h.panes.filter((p) => p.workspace_id === ws).length + 1}`;
    h.panes.push({ pane_id: pane, workspace_id: ws });
    return ok(JSON.stringify({ result: { root_pane: { pane_id: pane } } }));
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "get") return h.panes.some((p) => p.pane_id === a3) ? ok("{}") : no;
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: h.panes } }));
  if (cmd === "loginctl" && a1 === "show-user") return ok(`Linger=${h.linger ? "yes" : "no"}`);
  if (cmd === "loginctl" && a1 === "enable-linger") {
    h.linger = true;
    return ok();
  }
  if (cmd === "systemctl" && a2 === "list-unit-files") return ok(h.presence ? `dori-presence.service ${h.presence.enabled ? "enabled" : "disabled"} enabled` : "");
  if (cmd === "systemctl" && a2 === "disable" && argv.includes("--now") && argv.includes("dori-presence.service") && h.presence) {
    h.presence.enabled = false;
    h.presence.active = false;
    return ok();
  }
  if (cmd === "systemctl") return ok();
  return { code: 127, out: "", err: `unexpected ${argv.join(" ")}` };
};

const fakeDiscord = (readable: readonly string[], seen: HttpRequest[]): Http => async (req) => {
  seen.push(req);
  const id = req.url.split("/").pop() ?? "";
  if (req.headers?.Authorization !== `Bot ${TOKEN}`) return { status: 401, headers: {}, body: "{}" };
  if (req.url.endsWith("/oauth2/applications/@me")) return { status: 200, headers: {}, body: JSON.stringify({ id: APPLICATION, owner: { id: OWNER } }) };
  return readable.includes(id) ? { status: 200, headers: {}, body: JSON.stringify({ id, name: "dori", guild_id: GUILD }) } : { status: 403, headers: {}, body: '{"message":"Missing Access"}' };
};

const defaults: Prompter = { ask: async (_, c) => c, secret: async () => "", confirm: async (_, f) => f };

let state: ReturnType<typeof withState>;
let herdr: Herdr;
let log: string[];
let requests: HttpRequest[];

const deps = (patch: Partial<SetupDeps> = {}): SetupDeps => ({
  run: fakeHerdr(herdr),
  http: fakeDiscord([CHANNEL], requests),
  prompt: defaults,
  log: (l) => log.push(l),
  interactive: false,
  home: join(state.dir, "home"),
  user: "ana",
  configPath: join(state.dir, "home", ".dori", "config.json"),
  envPath: join(state.dir, "home", ".dori", "env"),
  unitDir: join(state.dir, "home", ".config", "systemd", "user"),
  templatesDir: TEMPLATES,
  bins: { dori: "/opt/bun/bin/dori", herdr: "/opt/herdr/bin/herdr", shell: "/bin/zsh" },
  ...patch,
});

beforeEach(() => {
  state = withState();
  herdr = { workspaces: [], panes: [], calls: [], linger: false };
  log = [];
  requests = [];
});
afterEach(() => state.done());

const mode = (p: string) => statSync(p).mode & 0o777;
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

test("mergeConfig keeps unknown keys and their order, and saveConfig skips a write when nothing changed", () => {
  const path = join(state.dir, "config.json");
  const existing = { custom: { x: 1 }, defaultModel: "a/b", hooks: { threadReply: ["x"] } };
  writeFileSync(path, JSON.stringify(existing));
  const next = mergeConfig(existing, { defaultModel: "c/d", discordChannels: ["1"], stateDir: undefined });
  expect(Object.keys(next)).toEqual(["custom", "defaultModel", "hooks", "discordChannels"]);
  expect(next.custom).toEqual({ x: 1 });
  expect(saveConfig(path, existing, next)).toBe(true);
  expect(mode(path)).toBe(0o600);
  expect(saveConfig(path, next, mergeConfig(next, { defaultModel: "c/d" }))).toBe(false);
  expect(readJson(path)).toEqual(next);
});

test("envSet replaces the token line in place and keeps every other line", () => {
  const text = "A=1\nexport DORI_DISCORD_TOKEN='old'\nB=2\n";
  const next = envSet(text, "DORI_DISCORD_TOKEN", "new");
  expect(next).toBe("A=1\nDORI_DISCORD_TOKEN=new\nB=2\n");
  expect(envGet(text, "DORI_DISCORD_TOKEN")).toBe("old");
  expect(envSet("", "K", "v")).toBe("K=v\n");
});

test("templates render with no placeholder left and no host-specific path, and a missing value is an error", () => {
  const values = { HOME: "/home/ana", PATH: "/usr/bin", SHELL: "/bin/zsh", DORI_BIN: "/x/dori", HERDR_BIN: "/x/herdr", ENV_FILE: "/home/ana/.dori/env", CONFIG: "/home/ana/.dori/config.json", WORK_DIR: "/home/ana/code", BOOT_PREP: "/home/ana/.dori/dori-boot-prep.sh", FAILURE_NOTIFY: "/home/ana/.dori/dori-failure-notify.sh" };
  for (const name of readdirSync(TEMPLATES)) {
    const text = readFileSync(join(TEMPLATES, name), "utf8");
    expect(text).not.toMatch(/\/home\/ubuntu|\/data\b/);
    const out = renderTemplate(text, values);
    expect(out).not.toContain("{{");
  }
  expect(renderTemplate(readFileSync(join(TEMPLATES, "dori-supervisor.service"), "utf8"), values)).toContain("ExecStartPre=/home/ana/.dori/dori-boot-prep.sh\nExecStart=/x/dori supervise");
  expect(() => renderTemplate("X={{NOPE}}", values)).toThrow(SetupError);
});

test("the supervisor unit has a watchdog, a start limit and an OnFailure owner alert that runs dori send", () => {
  const values = { HOME: "/home/ana", PATH: "/usr/bin", SHELL: "/bin/zsh", DORI_BIN: "/x/dori", HERDR_BIN: "/x/herdr", ENV_FILE: "/home/ana/.dori/env", CONFIG: "/home/ana/.dori/config.json", WORK_DIR: "/home/ana/code", BOOT_PREP: "/home/ana/.dori/dori-boot-prep.sh", FAILURE_NOTIFY: "/home/ana/.dori/dori-failure-notify.sh" };
  const unit = renderTemplate(readFileSync(join(TEMPLATES, "dori-supervisor.service"), "utf8"), values);
  const section = (name: string) => unit.split(/^\[/m).find((s) => s.startsWith(`${name}]`)) ?? "";
  for (const line of ["StartLimitIntervalSec=600", "StartLimitBurst=5", "OnFailure=dori-failure-notify@%n.service"]) expect(section("Unit")).toContain(`${line}\n`);
  for (const line of ["Type=notify", "NotifyAccess=all", "WatchdogSec=300", "Restart=always"]) expect(section("Service")).toContain(`${line}\n`);
  expect(renderTemplate(readFileSync(join(TEMPLATES, "herdr-server.service"), "utf8"), values)).toContain("OnFailure=dori-failure-notify@%n.service\n");
  const notify = renderTemplate(readFileSync(join(TEMPLATES, NOTIFY_UNIT), "utf8"), values);
  expect(notify).toContain("ExecStart=/home/ana/.dori/dori-failure-notify.sh %i\n");
  expect(notify).not.toContain("[Install]");
  const script = renderTemplate(readFileSync(join(TEMPLATES, FAILURE_NOTIFY), "utf8"), values);
  expect(script).toContain('"/x/dori" send discord --to "$channel" --text "$text"');
});

test("autostart writes the notify unit and an executable notify script but enables only the main units", async () => {
  const d = deps();
  expect(await runSetup(d, { herdr: false, autostart: true })).toBe(0);
  expect(mode(join(d.home, ".dori", FAILURE_NOTIFY))).toBe(0o755);
  expect(existsSync(join(d.unitDir, NOTIFY_UNIT))).toBe(true);
  const enable = herdr.calls.find((c) => c[0] === "systemctl" && c[2] === "enable");
  expect(enable).toEqual(["systemctl", "--user", "enable", ...UNITS]);
});

test("non-interactive setup writes env 600, config with herdr ids and units, never logs the token, and a second run changes nothing", async () => {
  const d = deps();
  await Bun.write(d.configPath, JSON.stringify({ custom: "keep me", hooks: { threadReply: ["notify", "{text}"] } }));
  const code = await runSetup(d, { token: TOKEN, channels: [CHANNEL], cwd: "~/code", autostart: true });
  expect(code).toBe(0);

  expect(mode(d.envPath)).toBe(0o600);
  expect(envGet(readFileSync(d.envPath, "utf8"), "DORI_DISCORD_TOKEN")).toBe(TOKEN);
  const cfg = readJson(d.configPath);
  expect(cfg).toMatchObject({ custom: "keep me", hooks: { threadReply: ["notify", "{text}"] }, discordChannels: [CHANNEL], defaultCwd: "~/code", stateDir: "~/.dori/state", leadPane: "w1:p2", laneWorkspace: "w2", workspaces: ["w2"], ignorePanes: ["w2:p1"] });
  expect(requests.map((r) => r.url)).toEqual([
    `https://discord.com/api/v10/channels/${CHANNEL}`,
    "https://discord.com/api/v10/oauth2/applications/@me",
    `https://discord.com/api/v10/channels/${CHANNEL}`,
  ]);
  expect(cfg.discord).toEqual({ applicationId: APPLICATION, guildId: GUILD, ownerId: OWNER });

  expect(readdirSync(d.unitDir).sort()).toEqual(["dori-failure-notify@.service", "dori-supervisor.service", "herdr-server.service"]);
  const boot = join(d.home, ".dori", "dori-boot-prep.sh");
  expect(mode(boot)).toBe(0o755);
  expect(readFileSync(join(d.unitDir, "dori-supervisor.service"), "utf8")).toContain(`EnvironmentFile=${d.envPath}`);
  const system = herdr.calls.filter((c) => c[0] !== "herdr").map((c) => c.join(" "));
  expect(system).toEqual(["loginctl show-user ana --property=Linger", "loginctl enable-linger ana", "systemctl --user daemon-reload", "systemctl --user list-unit-files dori-presence.service --no-legend --no-pager", "systemctl --user enable herdr-server.service dori-supervisor.service"]);
  expect(log.join("\n")).not.toContain(TOKEN);
  expect(log.at(-1)).toBe("SETUP_DONE");

  const before = { cfg: readFileSync(d.configPath, "utf8"), env: readFileSync(d.envPath, "utf8"), envMtime: statSync(d.envPath).mtimeMs, cfgMtime: statSync(d.configPath).mtimeMs };
  herdr.calls = [];
  log = [];
  expect(await runSetup(d, { autostart: true })).toBe(0);
  expect(readFileSync(d.configPath, "utf8")).toBe(before.cfg);
  expect(statSync(d.configPath).mtimeMs).toBe(before.cfgMtime);
  expect(statSync(d.envPath).mtimeMs).toBe(before.envMtime);
  expect(herdr.calls.some((c) => c[2] === "create")).toBe(false);
  expect(herdr.calls.some((c) => c[1] === "enable-linger")).toBe(false);
  expect(log).toContain("SETUP config unchanged: " + d.configPath);
  expect(log).toContain("SETUP herdr lead pane w1:p2 reused");
  expect(log.join("\n")).not.toContain(TOKEN);
});

test("a leadModel fallback chain in the config is kept by setup and never asked about", async () => {
  const d = deps();
  const chain = ["anthropic-subscription/claude-opus-5-5", { model: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast", thinking: "high" }];
  await Bun.write(d.configPath, JSON.stringify({ leadModel: chain }));
  const asked: string[] = [];
  const ask = d.prompt.ask;
  expect(await runSetup({ ...d, prompt: { ...d.prompt, ask: async (q, def) => { asked.push(q); return ask(q, def); } } }, { token: TOKEN, channels: [CHANNEL], cwd: "~/code" })).toBe(0);
  expect(readJson(d.configPath).leadModel).toEqual(chain);
  expect(asked.some((q) => q.startsWith("Lead model"))).toBe(false);
});

test("a missing defaultCwd, stateDir and unit dir are created, the rendered files hold no host path, and a rerun creates nothing", async () => {
  const d = deps();
  const cwd = join(state.dir, "home", "work", "deep");
  const stateDir = join(state.dir, "home", "st");
  expect(await runSetup(d, { token: TOKEN, channels: [CHANNEL], cwd, stateDir, autostart: true })).toBe(0);
  for (const dir of [cwd, stateDir, d.unitDir]) {
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(log).toContain(`SETUP created ${dir}`);
  }
  expect(readFileSync(join(d.unitDir, "dori-supervisor.service"), "utf8")).toContain(`WorkingDirectory=${cwd}\n`);
  for (const f of [...UNITS.map((u) => join(d.unitDir, u)), join(d.home, ".dori", "dori-boot-prep.sh")]) expect(readFileSync(f, "utf8")).not.toMatch(/\/home\/ubuntu|\/data\b/);
  log = [];
  expect(await runSetup(d, { autostart: true })).toBe(0);
  expect(log.some((l) => l.startsWith("SETUP created"))).toBe(false);
});

test("when a herdr server already answers, autostart enables herdr-server.service but the start hint leaves it out", async () => {
  const d = deps();
  expect(await runSetup(d, { token: TOKEN, channels: [CHANNEL], autostart: true })).toBe(0);
  const text = log.join("\n");
  expect(text).toContain("herdr server is already running");
  expect(text).toContain("systemctl --user start dori-supervisor.service\n");
  expect(herdr.calls.some((c) => c[0] === "systemctl" && c.includes("start"))).toBe(false);
});

test("a channel the bot cannot read stops a non-interactive run before anything is written", async () => {
  const d = deps();
  const run = runSetup(d, { token: TOKEN, channels: [CHANNEL, "1111111111111111111"] });
  await expect(run).rejects.toThrow(SetupError);
  expect(existsSync(d.envPath)).toBe(false);
  expect(existsSync(d.configPath)).toBe(false);
  expect(log.join("\n")).toContain("1111111111111111111 FAILED: the bot cannot see this channel (403 Missing Access)");
});

test("setup persists optional repo answers and rereads the chosen state directory on rerun", async () => {
  const currents: string[] = [];
  let answer: string | undefined = " Owner/Repo, OTHER/Repo owner/repo ";
  const prompt: Prompter = {
    ...defaults,
    ask: async (q, current) => {
      if (!q.startsWith("GitHub repos")) return current;
      currents.push(current);
      return answer ?? current;
    },
  };
  const d = deps({ prompt, interactive: true });
  const stateDir = "~/custom-state";
  expect(await runSetup(d, { stateDir, herdr: false })).toBe(0);
  const repos = new Repos(join(d.home, "custom-state"));
  expect(repos.list()).toEqual(["owner/repo", "other/repo"]);
  repos.add("external/change");
  answer = undefined;
  expect(await runSetup(d, { herdr: false })).toBe(0);
  expect(currents).toEqual(["", "owner/repo,other/repo,external/change"]);
  expect(repos.list()).toEqual(["owner/repo", "other/repo", "external/change"]);
});

test("a blank optional repo answer persists an empty list", async () => {
  const d = deps();
  expect(await runSetup(d, { herdr: false })).toBe(0);
  const dir = join(d.home, ".dori", "state");
  expect(existsSync(join(dir, "github-repos.json"))).toBe(true);
  expect(new Repos(dir).list()).toEqual([]);
});

test("invalid setup repo input leaves the stored list and config intact", async () => {
  const d = deps();
  expect(await runSetup(d, { herdr: false })).toBe(0);
  const repos = new Repos(join(d.home, ".dori", "state"));
  repos.add("keep/repo");
  const before = readFileSync(d.configPath, "utf8");
  const prompt: Prompter = { ...defaults, ask: async (q, current) => q.startsWith("GitHub repos") ? "https://github.com/owner/repo" : current };
  await expect(runSetup({ ...d, prompt }, { herdr: false })).rejects.toThrow(ReposError);
  expect(repos.list()).toEqual(["keep/repo"]);
  expect(readFileSync(d.configPath, "utf8")).toBe(before);
});

test("issue authors are optional, saved lowercased as githubIssueAuthors, kept on rerun, and validated", async () => {
  const d = deps();
  expect(await runSetup(d, { herdr: false })).toBe(0);
  expect("githubIssueAuthors" in readJson(d.configPath)).toBe(false);
  expect(await runSetup(d, { herdr: false, issueAuthors: ["Octo-Owner", "octo-alt"] })).toBe(0);
  expect(readJson(d.configPath).githubIssueAuthors).toEqual(["octo-owner", "octo-alt"]);
  expect(await runSetup(d, { herdr: false })).toBe(0);
  expect(readJson(d.configPath).githubIssueAuthors).toEqual(["octo-owner", "octo-alt"]);
  const before = readFileSync(d.configPath, "utf8");
  await expect(runSetup(d, { herdr: false, issueAuthors: ["bad_login"] })).rejects.toThrow(SetupError);
  expect(readFileSync(d.configPath, "utf8")).toBe(before);
});

test("each system step asks first: declining linger and enable runs neither", async () => {
  const answers: Record<string, boolean> = {};
  const prompt: Prompter = {
    ...defaults,
    confirm: async (q, f) => {
      if (q.includes("linger")) return (answers.linger = false);
      if (q.includes("Enable the units")) return (answers.enable = false);
      return q.startsWith("Start herdr") ? true : f;
    },
  };
  const d = deps({ prompt, interactive: true });
  expect(await runSetup(d, { token: TOKEN, channels: [CHANNEL], herdr: false })).toBe(0);
  expect(answers).toEqual({ linger: false, enable: false });
  const system = herdr.calls.filter((c) => c[0] !== "herdr").map((c) => c.join(" "));
  expect(system).toEqual(["loginctl show-user ana --property=Linger", "systemctl --user daemon-reload", "systemctl --user list-unit-files dori-presence.service --no-legend --no-pager"]);
  expect(herdr.calls.some((c) => c[0] === "herdr")).toBe(false);
});

test.each([true, false])("legacy presence migration accepted=%s respects confirmation and preserves the unit file", async (accepted) => {
  // Given an installed and running legacy unit, with an explicit migration answer.
  herdr.presence = { enabled: true, active: true };
  const migration = ["systemctl", "--user", "disable", "--now", "dori-presence.service"];
  const confirmations: boolean[] = [];
  const normal = fakeHerdr(herdr);
  const d = deps({
    interactive: true,
    prompt: {
      ...defaults,
      confirm: async (q, fallback) => {
        if (!q.includes(migration.join(" "))) return fallback;
        confirmations.push(accepted);
        return accepted;
      },
    },
    run: async (argv) => {
      if (argv[2] === "disable") expect(confirmations).toEqual([true]);
      return normal(argv);
    },
  });
  const legacyPath = join(d.unitDir, "dori-presence.service");
  const legacyContent = "[Service]\nExecStart=/old/dori presence discord\n";
  await Bun.write(legacyPath, legacyContent);

  // When setup migrates this installation.
  const code = await runSetup(d, { herdr: false, autostart: true });

  // Then only an accepted migration disables and stops presence, without deleting it.
  expect(code).toBe(0);
  expect(confirmations).toEqual([accepted]);
  expect(herdr.calls.filter((c) => c[2] === "disable")).toEqual(accepted ? [migration] : []);
  expect(herdr.presence).toEqual({ enabled: !accepted, active: !accepted });
  expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
  expect(herdr.calls.filter((c) => c[2] === "enable")).toEqual([["systemctl", "--user", "enable", "herdr-server.service", "dori-supervisor.service"]]);
});

test("non-interactive autostart migrates a legacy unit found outside the output directory", async () => {
  // Given a systemd-visible legacy unit and the same default confirmations as --yes.
  herdr.presence = { enabled: true, active: true };
  const d = deps();
  expect(existsSync(join(d.unitDir, "dori-presence.service"))).toBe(false);

  // When autostart is explicitly requested.
  const code = await runSetup(d, { herdr: false, autostart: true });

  // Then the legacy process stops and only the supervised units are installed.
  expect(code).toBe(0);
  expect(herdr.presence).toEqual({ enabled: false, active: false });
  expect(readdirSync(d.unitDir).sort()).toEqual(["dori-failure-notify@.service", "dori-supervisor.service", "herdr-server.service"]);
});

test.each(["list-unit-files", "disable", "daemon-reload", "enable"])("autostart reports a failed systemctl %s step", async (failedStep) => {
  // Given an installed legacy unit and one failed external operation.
  herdr.presence = { enabled: true, active: true };
  const normal = fakeHerdr(herdr);
  const failed: string[][] = [];
  const d = deps({
    run: async (argv) => {
      if (argv[0] === "systemctl" && argv[2] === failedStep) {
        herdr.calls.push([...argv]);
        failed.push([...argv]);
        return { code: 5, out: "", err: "EACCES" };
      }
      return normal(argv);
    },
  });

  // When setup attempts autostart.
  const code = await runSetup(d, { herdr: false, autostart: true });

  // Then it reports the failed command and returns the existing partial-failure code.
  expect(code).toBe(2);
  expect(failed).toHaveLength(1);
  expect(log.filter((l) => l.startsWith("SETUP FAILED (5): ")).map((l) => l.slice("SETUP FAILED (5): ".length)))
    .toEqual(failed.map((argv) => `${argv.join(" ")}: EACCES`));
  expect(log.at(-1)?.split(": ").at(-1)).toBe("systemctl");
  if (failedStep === "list-unit-files" || failedStep === "disable") {
    expect(herdr.presence).toEqual({ enabled: true, active: true });
  }
  if (failedStep === "list-unit-files") expect(herdr.calls.some((c) => c[2] === "enable")).toBe(false);
});

test("Discord setup discovers metadata, asks the owner with the application owner default and keeps configured ids", async () => {
  const asked: string[] = [];
  const chosen = "1100000000000000299";
  const d = deps({
    prompt: {
      ...defaults,
      ask: async (q, current) => {
        if (q.startsWith("Discord owner")) { asked.push(current); return chosen; }
        return current;
      },
    },
  });
  expect(await runSetup(d, { token: TOKEN, channels: [CHANNEL], herdr: false })).toBe(0);
  expect(asked).toEqual([OWNER]);
  expect(readJson(d.configPath).discord).toEqual({ applicationId: APPLICATION, guildId: GUILD, ownerId: chosen });
  const before = readFileSync(d.configPath, "utf8");
  const idempotent = deps({
    http: async (req) => req.url.endsWith("/oauth2/applications/@me")
      ? { status: 200, headers: {}, body: JSON.stringify({ id: "1100000000000000288", owner: { id: "1100000000000000277" } }) }
      : { status: 200, headers: {}, body: JSON.stringify({ id: CHANNEL, guild_id: "1100000000000000266" }) },
    prompt: { ...defaults, ask: async (q, current) => { if (q.startsWith("Discord owner")) asked.push(current); return current; } },
  });
  expect(await runSetup(idempotent, { herdr: false })).toBe(0);
  expect(asked).toEqual([OWNER, chosen]);
  expect(readFileSync(d.configPath, "utf8")).toBe(before);
  expect(log.join("\n")).not.toContain(TOKEN);
});

test.each([401, 403, 500])("Discord application discovery HTTP %s writes no config or secret", async (status) => {
  const normal = fakeDiscord([CHANNEL], requests);
  const d = deps({ http: async (req) => req.url.endsWith("/oauth2/applications/@me") ? { status, headers: {}, body: TOKEN } : normal(req) });
  await expect(runSetup(d, { token: TOKEN, channels: [CHANNEL], herdr: false })).rejects.toThrow(`HTTP ${status}`);
  expect(existsSync(d.configPath)).toBe(false);
  expect(existsSync(d.envPath)).toBe(false);
  expect(log.join("\n")).not.toContain(TOKEN);
});
