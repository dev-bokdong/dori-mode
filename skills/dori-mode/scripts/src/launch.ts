import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { fill, isEmergencyModel } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { laneRunner, readScreen, statusLookup } from "./panes.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { doneSyntaxErrors, parseSignal, splitDone } from "./signals.ts";
import { acquireStateLock } from "./state-lock.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  /** Run the lane in this existing idle shell pane instead of creating a tab. */
  readonly pane?: string;
  /** Run the lane in this workspace's idle shell pane (the only one without an agent). */
  readonly workspace?: string;
  readonly machine?: string;
  /** Allow a second open lane on the same messenger thread (`--share-thread`); the lanes are recorded in `threadSharedWith`. */
  readonly shareThread?: boolean;
  /** Allow a cwd whose git remotes name none of the Done line's repos (`--allow-repo-mismatch`). */
  readonly allowRepoMismatch?: boolean;
};

/** A lane launched with --share-thread: the keys of the other open lanes on its thread at launch time. */
export type SharedThreadLane = Lane & { readonly threadSharedWith?: readonly string[] };

export class LaunchError extends Error {}

const FAILURE_WORDS = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;
/** Without an "Error:" prefix a failure must be the start of the line, never a word inside prose. */
const FAILURE_LINE = /^(?:Cannot find module|All fallback models failed|No API key|model_not_available|unknown provider|Session crashed|(?:you(?:'ve| have) (?:hit|reached|exceeded) (?:your |the )?)?(?:(?:usage|rate) limit|quota)\s+(?:reached|exceeded|hit|exhausted|error))/i;
const LEAD_IN = /^[\s│|>•*✗✖×!⚠❌-]*/;

/**
 * The first real startup failure on a pane screen, or undefined. Tips, recalled-memory/Kibitzer
 * blocks and echoes of the launch prompt are skipped, and bare words only count after "Error:".
 */
export const startupFailure = (screen: string): string | undefined => {
  for (const line of screenLines(screen)) {
    const error = /^(?:error|fatal)\b[:\s-]*/i.exec(line);
    const hit = error ? FAILURE_WORDS.exec(line.slice(error[0].length)) : FAILURE_LINE.exec(line);
    if (hit) return hit[0];
  }
  return undefined;
};

/**
 * The screen lines that can carry an agent's own message, with their box/bullet lead-in removed. Tips, recalled-memory
 * and Kibitzer blocks (until a blank line or the closing tag) and echoes of a lane brief are left out.
 */
export function* screenLines(screen: string): Generator<string> {
  let skipping: "tip" | "memory" | undefined;
  for (const raw of screen.split("\n")) {
    const line = raw.replace(LEAD_IN, "");
    if (!line.trim()) { skipping = undefined; continue; }
    if (/^Tip:|^Want the full story on any tip/i.test(line)) { skipping = "tip"; continue; }
    if (/<recalled-memory|Kibitzer/i.test(raw)) skipping = "memory";
    if (/<\/recalled-memory>/i.test(raw)) { skipping = undefined; continue; }
    if (skipping) continue;
    if (/lane brief at /i.test(raw)) continue;
    yield line;
  }
}

/** The figma-off project config older launches wrote into lane cwds; kept only to recognise and remove it. */
export const LEGACY_LANE_MCP = `${JSON.stringify({ mcpServers: { figma: { enabled: false, url: "https://mcp.figma.com/mcp" } } }, null, 2)}\n`;

/**
 * Remove a .omo/mcp.json that is byte-for-byte the old lane file, so an old worktree stops keeping
 * figma off. A user's own file is never touched. Returns whether a file was removed.
 */
export const removeLegacyLaneMcp = async (cwd: string): Promise<boolean> => {
  const file = Bun.file(join(cwd, ".omo", "mcp.json"));
  try {
    if (!(await file.exists()) || (await file.text()) !== LEGACY_LANE_MCP) return false;
    await file.delete();
    return true;
  } catch { return false; } // unremovable: the lane still launches as before
};

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  const sharing = await threadSharers(deps, input);
  if (sharing.length && !input.shareThread) throw new LaunchError(`thread ${input.thread} already has open lane ${sharing.join(", ")}; one thread per lane, or pass --share-thread`);
};

const threadSharers = async (deps: FlowDeps, input: LaunchInput): Promise<string[]> =>
  !input.thread || input.thread === "none" ? [] : (await deps.registry.open()).filter((l) => l.key !== input.key && l.thread === input.thread).map((l) => l.key);

/** owner/repo names in the Done line's merged/closed signals, lowercased. */
export const doneRepos = (done: string): string[] => [...new Set(splitDone(done).flatMap((part) => {
  try { const s = parseSignal(part); return s.kind === "merged" || s.kind === "closed" ? [s.repo.toLowerCase()] : []; } catch { return []; }
}))];

/** owner/repo from a git remote URL (https, ssh or scp form), lowercased. */
export const remoteRepo = (url: string): string | undefined =>
  /[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]?.toLowerCase();

const gitTop = async (deps: FlowDeps, dir: string): Promise<string | undefined> => {
  const r = await deps.run(["git", "-C", dir, "rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
};

/**
 * A local lane's directory: refused when it is the git checkout (worktree) another open local lane works in, and when
 * its git remotes name none of the Done line's repos (unless allowRepoMismatch). A directory outside git is not checked.
 * Remote lanes are not checked: their directory is not on this host.
 */
export const validatePlacement = async (deps: FlowDeps, input: LaunchInput, cwd: string): Promise<void> => {
  if (input.machine) return;
  const top = await gitTop(deps, cwd);
  if (!top) return;
  for (const other of await deps.registry.open()) {
    if (other.key === input.key || other.machine) continue;
    const dir = other.cwd ?? deps.config.defaultCwd;
    if (dir === cwd || (await gitTop(deps, dir)) === top) throw new LaunchError(`${cwd} is the checkout open lane ${other.key} works in (${top}); give this lane its own worktree with --cwd`);
  }
  const want = doneRepos(input.done);
  if (!want.length || input.allowRepoMismatch) return;
  const remotes = await deps.run(["git", "-C", top, "remote", "-v"]);
  const have = [...new Set(remotes.out.split("\n").map((l) => remoteRepo(l.split(/\s+/)[1] ?? "")).filter((r): r is string => Boolean(r)))];
  if (have.length && !have.some((r) => want.includes(r))) throw new LaunchError(`${cwd} is a checkout of ${have.join(", ")}, but the Done line names ${want.join(", ")}; launch from that repo's worktree or pass --allow-repo-mismatch`);
};

/**
 * A brief's `autoClose:` declaration (a line of its own, optionally a list item): `machine` means the Done signals settle
 * the lane alone, so its claim and close never wake the lead; `lead` (or none) is the default.
 */
export const briefAutoClose = (brief: string): Lane["autoClose"] => {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?autoClose:[ \t]*(\S*?)`?[ \t]*$/im.exec(brief);
  if (!m) return undefined;
  const value = (m[1] ?? "").toLowerCase();
  if (value === "machine") return "machine";
  if (value === "lead") return undefined;
  throw new LaunchError(`the brief declares autoClose: ${m[1]}; use autoClose: machine (or lead, the default)`);
};

/**
 * A brief's `issue:` declaration (a line of its own, optionally a list item): the GitHub issue `owner/repo#N` the lane
 * was started from. CI follow-up closes it with a comment once the lane's PR is merged into ciMergeBase.
 */
export const briefIssue = (brief: string): string | undefined => {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?issue:[ \t]*(\S*?)`?[ \t]*$/m.exec(brief);
  if (!m) return undefined;
  const ref = m[1] ?? "";
  if (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ref)) throw new LaunchError(`the brief declares issue: ${ref}; use issue: owner/repo#N`);
  return ref;
};

/** The brief's autoClose and issue for a lane record. An unreadable brief declares neither. */
const autoCloseOf = async (path: string): Promise<Pick<Lane, "autoClose" | "ghIssue">> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const text = await file.text();
  const auto = briefAutoClose(text);
  const issue = briefIssue(text);
  return { ...(auto ? { autoClose: auto } : {}), ...(issue ? { ghIssue: issue } : {}) };
};

export const footer = (lane: Lane, leadPane: string): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  "- PR bodies, issues and commit messages carry no owner quotes, chat message ids, or quota, usage or cost numbers.",
  ...(lane.autoClose === "machine" ? ["- autoClose: machine. When the Done signals read back live the lane closes on its own; the lead is not woken for the claim or the close."] : []),
  ...(lane.machine
    ? [
      `- This lane runs on machine ${lane.machine}; the lead reads this pane from another host. Report at each milestone by printing this line in your own output (do not message any pane): [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>.`,
      `- When done: print [REPORT] ${lane.key} | done | <merge SHA, closed issue, version> and stay idle. The lead checks the Done signals and closes the lane; dori claim-done is not available on this machine. Each distinct report line is read once: after a [LEAD] not done, print a done line with updated evidence.`,
    ]
    : lane.reportVia === "cli"
      ? [
        `- Report to the lead with dori report, never by typing into the lead's pane: dori report ${lane.key} <milestone|progress|question|blocked> --text "<what, with links>". question and blocked wake the lead, milestone reaches it with its next update, progress is posted to your work thread.`,
        `- When done: dori report ${lane.key} done --text "<one line>" --evidence "<merge SHA, closed issue, version>" (the same claim as dori claim-done). See references/done-protocol.md.`,
      ]
      : [
        `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>, sent to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
        `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
      ]),
  "",
].join("\n");

/** Where a lane's directory lives: a remote path is kept apart from the local cwd that signals and git checks use. */
const laneDirs = (machine: string | undefined, dir: string | undefined, defaultCwd: string): Pick<Lane, "cwd" | "remoteCwd"> =>
  machine ? (dir ? { remoteCwd: dir } : {}) : { cwd: dir ?? defaultCwd };

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, ...(input.machine ? { machine: input.machine } : {}), brief: input.brief, done: input.done, ...(await autoCloseOf(input.brief)), ...laneDirs(input.machine, input.cwd, deps.config.defaultCwd), openedAt: iso(deps.clock) };
  return reserveLane(deps, input, lane);
};

/** Serialize admissions across keys: thread and checkout checks and the key reservation are one transaction. */
const reserveLane = async (deps: FlowDeps, input: LaunchInput, lane: Lane, token?: string): Promise<SharedThreadLane> => {
  const release = await acquireStateLock(join(deps.registry.dir, "launch.lock.sqlite"));
  try {
    await validateLaunch(deps, input);
    await validatePlacement(deps, input, lane.cwd ?? deps.config.defaultCwd);
    const shared = await threadSharers(deps, input);
    const draft: SharedThreadLane = { ...lane, ...(shared.length ? { threadSharedWith: shared } : {}) };
    await deps.registry.update(input.key, (current) => {
      if (current) throw new LaunchError(`lane ${input.key} is already registered`);
      // A crash leaves a visible paused reservation, not an apparently working lane that recovery might spawn.
      return token ? { ...draft, status: "paused", launchReservation: token } : draft;
    });
    return draft;
  } finally { release(); }
};

type TargetPane = { readonly pane: string; readonly tab?: string; readonly cwd?: string; readonly shell: PaneShell };

type ProcessInfo = {
  readonly shell_pid?: number;
  readonly foreground_process_group_id?: number;
  readonly foreground_processes?: readonly { readonly pid?: number; readonly name?: string; readonly argv?: readonly string[] }[];
};

export type PaneShell = "posix" | "powershell" | "cmd";

/**
 * The shell an idle pane runs, from herdr process-info: the foreground process that is the shell (or the only one).
 * Without a readable name, a drive-letter cwd (D:\...) means a Windows pane, whose default shell is PowerShell.
 */
export const paneShell = (info: ProcessInfo | undefined, cwd?: string): PaneShell => {
  const procs = info?.foreground_processes ?? [];
  const proc = procs.find((p) => p.pid !== undefined && p.pid === info?.shell_pid) ?? (procs.length === 1 ? procs[0] : undefined);
  const name = (proc?.name || proc?.argv?.[0] || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/^-/, "").replace(/\.exe$/, "") ?? "";
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  if (name) return "posix";
  return cwd && /^[A-Za-z]:[\\/]/.test(cwd) ? "powershell" : "posix";
};

type PaneInfo = { readonly pane_id: string; readonly workspace_id: string; readonly tab_id?: string; readonly agent?: string; readonly cwd?: string; readonly foreground_cwd?: string };

const parse = <T>(text: string, what: string): T => {
  try { return JSON.parse(text) as T; } catch { throw new LaunchError(`${what}: unreadable herdr output`); }
};

/** The existing pane a lane may start in: it exists, is an idle shell (no agent, no other foreground process) and no lane owns it. Throws before anything is written. */
const resolveTargetPane = async (deps: FlowDeps, input: LaunchInput): Promise<TargetPane> => {
  let id = input.pane;
  if (!id) {
    const list = await deps.run(["herdr", "pane", "list"]);
    if (list.code !== 0) throw new LaunchError(`herdr pane list failed: ${list.err || list.out}`);
    const inWs = parse<{ result: { panes: PaneInfo[] } }>(list.out, "herdr pane list").result.panes.filter((p) => p.workspace_id === input.workspace);
    if (!inWs.length) throw new LaunchError(`workspace ${input.workspace} has no panes (or does not exist)`);
    const shells = inWs.filter((p) => !p.agent);
    if (shells.length !== 1) throw new LaunchError(`workspace ${input.workspace} has ${shells.length} shell panes; pass --pane to pick one`);
    id = shells[0]?.pane_id;
  }
  if (!id) throw new LaunchError("no target pane");
  const got = await deps.run(["herdr", "pane", "get", id]);
  if (got.code !== 0) throw new LaunchError(`pane ${id} does not exist: ${got.err || got.out}`);
  const info = parse<{ result: { pane: PaneInfo } }>(got.out, `herdr pane get ${id}`).result.pane;
  if (input.workspace && info.workspace_id !== input.workspace) throw new LaunchError(`pane ${id} is in workspace ${info.workspace_id}, not ${input.workspace}`);
  if (info.agent) throw new LaunchError(`pane ${id} runs an agent (${info.agent}); a lane needs an idle shell`);
  const proc = await deps.run(["herdr", "pane", "process-info", "--pane", id]);
  if (proc.code !== 0) throw new LaunchError(`cannot read the processes of pane ${id}: ${proc.err || proc.out}`);
  const p = parse<{ result: { process_info: ProcessInfo } }>(proc.out, `herdr pane process-info ${id}`).result.process_info;
  if (p.foreground_process_group_id && p.foreground_process_group_id !== p.shell_pid) throw new LaunchError(`pane ${id} has a foreground process running; a lane needs an idle shell`);
  const owner = (await deps.registry.open()).find((l) => l.pane === id && l.machine === input.machine);
  if (owner) throw new LaunchError(`pane ${id} is already registered to lane ${owner.key}`);
  const cwd = info.foreground_cwd ?? info.cwd;
  const shell = paneShell(p, cwd);
  if (input.machine && shell === "cmd") throw new LaunchError(CMD_REFUSED(id));
  return { pane: id, ...(info.tab_id ? { tab: info.tab_id } : {}), ...(cwd ? { cwd } : {}), shell };
};

const CMD_REFUSED = (pane: string) => `pane ${pane} runs cmd.exe; start pwsh or powershell in it (or a POSIX shell) and launch again`;

/** A freshly created remote pane: its shell and directory, read leniently (an unreadable answer means POSIX, as before). */
const inspectCreated = async (deps: FlowDeps, pane: string): Promise<{ readonly shell: PaneShell; readonly cwd?: string }> => {
  const got = await deps.run(["herdr", "pane", "get", pane]);
  const proc = await deps.run(["herdr", "pane", "process-info", "--pane", pane]);
  const read = <T>(text: string): T | undefined => { try { return JSON.parse(text) as T; } catch { return undefined; } };
  const info = got.code === 0 ? read<{ result?: { pane?: PaneInfo } }>(got.out)?.result?.pane : undefined;
  const p = proc.code === 0 ? read<{ result?: { process_info?: ProcessInfo } }>(proc.out)?.result?.process_info : undefined;
  const cwd = info?.foreground_cwd ?? info?.cwd;
  return { shell: paneShell(p, cwd), ...(cwd ? { cwd } : {}) };
};

/** Marks where the brief path goes in the agent prompt when the shell computes that path. */
const BRIEF_AT = "\u0000brief\u0000";

/** A PowerShell single-quoted literal: nothing inside expands; a quote (including the typographic ones PowerShell also accepts) is doubled. */
export const psQuote = (arg: string): string => `'${arg.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

/**
 * One PowerShell line that writes the brief to the remote temp directory and then starts the agent.
 * The brief travels as base64 bytes, so no brief character is ever parsed by the shell, and no lead-local path appears.
 * Works in Windows PowerShell 5.1 and PowerShell 7 (no `&&`).
 */
export const powershellLaunch = (argv: readonly string[], brief: string, key: string): string => {
  if (argv.some((a) => /[\r\n]/.test(a))) throw new LaunchError("the agent command must be single-line to run in a PowerShell pane");
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  // Typed non-ASCII is not reliable through a pane's line editor, so such text travels as base64 too: the line stays ASCII.
  const literal = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? psQuote(s) : `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`);
  const arg = (a: string) => (a.includes(BRIEF_AT) ? `(${a.split(BRIEF_AT).map(literal).join(" + $doriBrief + ")})` : psQuote(a) === literal(a) ? literal(a) : `(${literal(a)})`);
  return `$doriBrief = Join-Path ([IO.Path]::GetTempPath()) ${psQuote(`dori-brief-${key}.md`)}; [IO.File]::WriteAllBytes($doriBrief, [Convert]::FromBase64String('${b64(brief)}')); if ($?) { & ${argv.map(arg).join(" ")} }`;
};

/** The brief's home on a POSIX remote: a fixed path, valid on Linux and macOS, never the lead's own path. */
export const posixRemoteBrief = (key: string): string => `/tmp/dori-brief-${key}.md`;

export const launchLane = async (deps: FlowDeps, input: LaunchInput, existing?: Lane): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  if (isEmergencyModel(deps.config, model)) throw new LaunchError(`${model} is a lead-only emergency model (leadEmergencyModels); lanes never run on it`);
  if (!existing) await validateLaunch(deps, input);
  deps = { ...deps, run: laneRunner(deps.run, input) };
  const target = input.pane || input.workspace ? await resolveTargetPane(deps, input) : undefined;
  const dir = input.cwd ?? target?.cwd;
  const cwd = dir ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  let draft: SharedThreadLane = { ...(existing ?? {}), key: input.key, title: input.title, thread: input.thread ?? "none", ...(input.machine ? { machine: input.machine } : {}), brief: input.brief, done: input.done, ...(existing ? {} : await autoCloseOf(input.brief)), ...(!existing && !input.machine ? { reportVia: "cli" as const } : {}), ...laneDirs(input.machine, dir, deps.config.defaultCwd), model, openedAt: existing?.openedAt ?? iso(deps.clock) };
  const token = existing ? undefined : randomUUID();
  if (token) draft = await reserveLane(deps, input, draft, token);
  let agentAdmitted = false;
  try {
    const brief = existing ? await briefFile.text() : `${(await briefFile.text()).replace(/\s*$/, "")}\n${footer(draft, deps.config.leadPane)}`;
    if (!existing) await Bun.write(input.brief, brief);
    let pane: string;
    let tab: string | undefined;
    let shell: PaneShell = "posix";
    if (target) {
      ({ pane, tab, shell } = target);
    } else {
      // A remote tab gets only a remote directory; the lead's defaultCwd means nothing on that machine.
      const where = input.machine ? (dir ? ["--cwd", dir] : []) : ["--cwd", cwd];
      const created = await deps.run(["herdr", "tab", "create", ...(!input.machine && deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), ...where, "--label", input.key, "--no-focus"]);
      if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
      const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
      pane = made.root_pane.pane_id;
      tab = made.tab_id ?? made.root_pane.tab_id;
      if (input.machine) {
        const fresh = await inspectCreated(deps, pane);
        shell = fresh.shell;
        if (!dir && fresh.cwd) draft = { ...draft, remoteCwd: fresh.cwd };
        if (shell === "cmd") {
          if (tab) await deps.run(["herdr", "tab", "close", tab]);
          throw new LaunchError(CMD_REFUSED(pane));
        }
      }
    }
    const agentArgv = (briefPath: string): string[] => {
      const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${briefPath} in full. You are the ${input.key} lane; report as the brief's footer says.`;
      const [exe, ...args] = fill(deps.config.agentCommand, { model, prompt });
      return exe ? [exe, ...args] : [];
    };
    let command: string;
    if (!input.machine) {
      const [exe, ...args] = agentArgv(input.brief);
      await removeLegacyLaneMcp(cwd);
      // DORI_LANE_KEY tells the dori CLI it runs inside this lane, which limits it to the lane's own key and thread.
      command = (exe ? [`DORI_LANE_KEY=${input.key}`, exe, ...args] : []).map(quoteForPane).join(" ");
    } else if (shell === "powershell") {
      command = powershellLaunch(agentArgv(BRIEF_AT), brief, input.key);
    } else {
      // The brief is owned by this launch. Copy it with its footer: the remote host does not share our filesystem.
      const at = posixRemoteBrief(input.key);
      command = `printf %s ${quoteForPane(brief)} > ${quoteForPane(at)} && ${agentArgv(at).map(quoteForPane).join(" ")}`;
    }
    const lane: Lane = { ...draft, pane, ...(tab ? { tab } : {}) };
    if (token) await deps.registry.update(lane.key, (current) => {
      if (current?.launchReservation !== token) throw new LaunchError(`lane ${lane.key} lost its launch reservation`);
      return { ...current, ...lane, status: "paused", launchReservation: token };
    });
    const admitted = await deps.run(["herdr", "pane", "run", pane, command]);
    if (admitted.code !== 0) throw new LaunchError(`herdr pane run failed: ${admitted.err || admitted.out}`);
    agentAdmitted = true;
    // A relaunch writes only what this launch changed, so a pause or objection that landed meanwhile survives.
    const launched = (current: Lane): Lane => existing
      ? { ...current, ...Object.fromEntries(Object.entries(lane).filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)), key: lane.key } as Lane
      : { ...current, ...lane, status: current.status === "paused" ? lane.status : current.status, launchReservation: undefined };
    await deps.registry.update(lane.key, (current) => {
      if (token && current?.launchReservation !== token) throw new LaunchError(`lane ${lane.key} lost its launch reservation`);
      return current ? launched(current) : lane;
    });
    await deps.clock.sleep(20_000);
    const { status, error } = await statusLookup(deps.run, pane);
    // A working agent has started its task. Anything else, idle included, is scanned first: an agent that printed
    // "No API key" or a usage-limit error and stopped at its prompt reads idle but never started the work.
    if (status === "working") return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
    const screen = await readScreen(deps.run, pane, 40);
    const bad = startupFailure(screen);
    if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${bad}` };
    if (status === "idle") return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
    const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
    return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
  } catch (error) {
    if (token && !agentAdmitted) await deps.registry.releaseReservation(input.key, token);
    throw error;
  }
};

const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
