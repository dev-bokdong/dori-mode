import { afterEach, beforeEach, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { claimDone, closeLane, closedWorktreeSweep, discoverWorktrees, objectDone, unpushedWork, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { githubTargets } from "../src/github-events.ts";
import { adoptLane, footer, launchLane, paneShell } from "../src/launch.ts";
import { herdrArgv, laneRunner } from "../src/panes.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { run as realRun } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, newWorld, withState, type World, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MACHINE = "build host";
let state: ReturnType<typeof withState>;
let world: World;
let calls: string[][];
beforeEach(() => { state = withState(); withSqliteStore(state.dir); world = newWorld(); calls = []; });
afterEach(() => state.done());

const lane = (patch: Partial<Lane> = {}): Lane => ({
  key: "remote-lane", title: "remote", thread: "none", pane: "w:p3", machine: MACHINE,
  brief: join(state.dir, "brief.md"), cwd: "/remote-only/repo", done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(), ...patch,
});

const deps = (remote = true) => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  const run: Runner = async (argv, opts) => {
    calls.push([...argv]);
    const selected = argv[0] === "herdr" && argv[1] === "--machine";
    const args = selected ? ["herdr", ...argv.slice(3)] : argv;
    if (args[0] === "ps") return { code: 0, out: "", err: "" };
    if (args[0] === "herdr") {
      if (args[1] === "tab" && args[2] === "create") return { code: 0, err: "", out: JSON.stringify({ result: { root_pane: { pane_id: "w:p3" }, tab_id: "w:t3" } }) };
      if (args[1] === "pane" && args[2] === "get") return { code: 0, err: "", out: JSON.stringify({ result: { pane: { pane_id: "w:p3", workspace_id: "w", cwd: "/remote-only/repo" } } }) };
      if (args[1] === "pane" && args[2] === "process-info") return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 200, argv: ["omo", "--session-id", "remote-session"] }] } } }) };
      if (args[1] === "pane" && args[2] === "list" && selected !== remote) return { code: 0, err: "", out: JSON.stringify({ result: { panes: [] } }) };
    }
    return base.run(args, opts);
  };
  world.panes = [{ pane_id: "w:p3", workspace_id: "w", agent_status: "idle" }];
  return { ...base, run };
};

const remoteCalls = () => calls.filter((argv) => argv[0] === "herdr");
const expectRemote = () => {
  expect(remoteCalls().length).toBeGreaterThan(0);
  for (const argv of remoteCalls()) expect(argv.slice(0, 3)).toEqual(["herdr", "--machine", MACHINE]);
};

test("remote --pane launch routes checks, run and startup and persists machine", async () => {
  // Given a local brief and a shell on a saved machine.
  const d = deps();
  const input = lane();
  await Bun.write(input.brief, "execute the requested work\n");
  // When launched, an identical local pane ID must not make the remote pane owned.
  await d.registry.write(lane({ key: "local-owner", machine: undefined }));
  const result = await launchLane(d, { ...input, pane: "w:p3" });
  // Then every herdr operation, including startup status, targets the machine.
  expectRemote();
  expect(result.startup).toStartWith("STARTUP_OK");
  expect((await d.registry.read(input.key))?.machine).toBe(MACHINE);
  const command = calls.find((argv) => argv[4] === "run")?.[6] ?? "";
  expect(command).toContain("/tmp/dori-brief-remote-lane.md");
  expect(command).not.toContain(state.dir);
  expect(calls.some((argv) => argv[0] === "git")).toBe(false);
});

test("remote --workspace launch resolves inventory on that machine", async () => {
  const d = deps();
  const input = lane({ pane: undefined });
  await Bun.write(input.brief, "work\n");
  const result = await launchLane(d, { ...input, workspace: "w" });
  expect(result.lane.pane).toBe("w:p3");
  expectRemote();
  expect(remoteCalls()).toContainEqual(["herdr", "--machine", MACHINE, "pane", "list"]);
});

test("plain remote launch creates its tab through the saved machine API", async () => {
  const d = deps();
  const input = lane({ pane: undefined, cwd: undefined });
  await Bun.write(input.brief, "work\n");
  expect((await launchLane({ ...d, config: { ...d.config, laneWorkspace: "local-only-workspace" } }, input)).lane.tab).toBe("w:t3");
  expectRemote();
  expect(calls.some((argv) => argv.slice(3, 5).join(" ") === "tab create")).toBe(true);
  expect(calls.some((argv) => argv.includes("local-only-workspace"))).toBe(false);
  // The lead's defaultCwd means nothing on the machine, so the remote tab gets no --cwd; the pane's own path is kept apart.
  expect(calls.find((argv) => argv.slice(3, 5).join(" ") === "tab create")).not.toContain("--cwd");
  expect(await d.registry.read(input.key)).toMatchObject({ remoteCwd: "/remote-only/repo" });
  expect((await d.registry.read(input.key))?.cwd).toBeUndefined();
});

test("POSIX remote launch copies the complete brief to a remote-valid path before executing the agent", async () => {
  const d = deps();
  const input = lane({ key: `remote-posix-${process.pid}`, brief: join(state.dir, "quoted ' brief.md") });
  const remote = `/tmp/dori-brief-${input.key}.md`;
  await Bun.write(input.brief, "literal ' quote and $(printf INJECTED) and `printf INJECTED`\n");
  await launchLane({ ...d, config: { ...d.config, agentCommand: ["printf", "%s", "{prompt}"] } }, input);
  const shipped = await Bun.file(input.brief).text();
  const command = calls.find((argv) => argv[4] === "run")?.[6];
  if (!command) throw new Error("launch did not submit a command");
  expect(command).not.toContain(state.dir);
  try {
    const executed = await realRun(["sh", "-c", command], { timeoutMs: 5_000 });
    expect(executed.code).toBe(0);
    expect(executed.out).toContain(`lane brief at ${remote} in full`);
    expect(await Bun.file(remote).text()).toBe(shipped);
  } finally {
    if (await Bun.file(remote).exists()) unlinkSync(remote);
  }
});

/** Reads a PowerShell line the way its parser treats single quotes: '' inside a literal is one quote, as are the typographic quotes. */
const psTokens = (line: string): { readonly literals: string[]; readonly code: string } => {
  const literals: string[] = [];
  let code = "";
  const quote = /['\u2018\u2019\u201A\u201B]/;
  for (let i = 0; i < line.length; i++) {
    if (!quote.test(line[i] ?? "")) { code += line[i]; continue; }
    let text = "";
    for (i++; ; i++) {
      if (i >= line.length) throw new Error("unterminated PowerShell string");
      if (quote.test(line[i] ?? "")) {
        if (quote.test(line[i + 1] ?? "")) { text += line[i + 1]; i++; continue; }
        break;
      }
      text += line[i];
    }
    code += `<${literals.length}>`;
    literals.push(text);
  }
  return { literals, code };
};

/** Evaluates the subset launch emits: <k> literals, base64-decoded literals, and ( a + $doriBrief + b ) concatenations. */
const psArgv = (args: string, literals: readonly string[], briefPath: string): string[] => {
  const term = (s: string): string => {
    if (s === "$doriBrief") return briefPath;
    const lit = /^<(\d+)>$/.exec(s);
    if (lit) return literals[Number(lit[1])] ?? "";
    const b64 = /^\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\(<(\d+)>\)\)$/.exec(s);
    if (b64) return Buffer.from(literals[Number(b64[1])] ?? "", "base64").toString("utf8");
    throw new Error(`unexpected PowerShell term: ${s}`);
  };
  const out: string[] = [];
  for (let i = 0; i < args.length;) {
    if (args[i] === " ") { i++; continue; }
    if (args[i] !== "(") { const j = args.indexOf(" ", i); const tok = args.slice(i, j < 0 ? args.length : j); out.push(term(tok)); i += tok.length; continue; }
    let depth = 0, j = i;
    for (; j < args.length; j++) { if (args[j] === "(") depth++; else if (args[j] === ")" && --depth === 0) break; }
    out.push(args.slice(i + 1, j).split(" + ").map(term).join(""));
    i = j + 1;
  }
  return out;
};

const windowsPane = (d: ReturnType<typeof deps>, shellName: string): Runner => async (argv, opts) => {
  const args = argv[1] === "--machine" ? ["herdr", ...argv.slice(3)] : [...argv];
  if (args[1] === "pane" && args[2] === "process-info") return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: 4100, foreground_processes: [{ pid: 4100, name: shellName, argv: [`C:\\Program Files\\PowerShell\\7\\${shellName}`] }] } } }) };
  if (args[1] === "pane" && args[2] === "get") return { code: 0, err: "", out: JSON.stringify({ result: { pane: { pane_id: "w:p3", workspace_id: "w", cwd: "D:\\dev\\worktrees\\app" } } }) };
  return d.run(argv, opts);
};

test("PowerShell remote launch ships the brief as bytes and quotes every argument as a PowerShell literal", async () => {
  const d = deps();
  const input = lane({ cwd: undefined });
  const body = "it's \"quoted\" $env:PATH $(Get-Date) `backtick` \u2018smart\u2019 \u201Alow\u201B\nsecond line\r\nthird\n";
  await Bun.write(input.brief, body);
  const result = await launchLane({ ...d, run: windowsPane(d, "pwsh.exe"), config: { ...d.config, launchKeywords: "ulw it's $go \u2018x\u2019" } }, { ...input, pane: "w:p3" });
  const shipped = await Bun.file(input.brief).text();
  expect(shipped.startsWith(body.replace(/\s*$/, ""))).toBe(true);
  const command = calls.find((argv) => argv[4] === "run")?.[6] ?? "";
  // One line, no lead-local path, and nothing from the brief is typed into the shell.
  expect(command).not.toMatch(/[\r\n]/);
  expect(command).not.toContain(state.dir);
  expect(command).not.toContain("backtick");
  // Pure printable ASCII: typed non-ASCII is not reliable through a pane's line editor.
  expect(command).toMatch(/^[\x20-\x7e]+$/);
  const { literals, code } = psTokens(command);
  const head = /^\$doriBrief = Join-Path \(\[IO\.Path\]::GetTempPath\(\)\) <0>; \[IO\.File\]::WriteAllBytes\(\$doriBrief, \[Convert\]::FromBase64String\(<1>\)\); if \(\$\?\) \{ & (.*) \}$/.exec(code);
  if (!head?.[1]) throw new Error(`unexpected PowerShell line shape: ${code}`);
  expect(literals[0]).toBe("dori-brief-remote-lane.md");
  expect(Buffer.from(literals[1] ?? "", "base64").toString("utf8")).toBe(shipped);
  // Evaluate the argument list with $doriBrief bound to a Windows temp path; it must equal the agent argv.
  expect(psArgv(head[1], literals, "C:\\Temp\\x.md")).toEqual([
    ...d.config.agentCommand.slice(0, -1).map((a) => a.replace("{model}", d.config.defaultModel)),
    "ulw it's $go \u2018x\u2019. Read and execute the lane brief at C:\\Temp\\x.md in full. You are the remote-lane lane; report as the brief's footer says.",
  ]);
  expect(result.lane).toMatchObject({ machine: MACHINE, remoteCwd: "D:\\dev\\worktrees\\app" });
  expect(result.lane.cwd).toBeUndefined();
});

test("a cmd.exe pane is refused before anything runs or registers", async () => {
  const d = deps();
  const input = lane();
  await Bun.write(input.brief, "work\n");
  await expect(launchLane({ ...d, run: windowsPane(d, "cmd.exe") }, { ...input, pane: "w:p3" })).rejects.toThrow("runs cmd.exe");
  expect(calls.some((argv) => argv[4] === "run")).toBe(false);
  expect(await d.registry.read(input.key)).toBeNull();
});

test("pane shell detection reads the shell process, then a Windows drive cwd", () => {
  const info = (name: string) => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name }] });
  expect(paneShell(info("powershell.exe"))).toBe("powershell");
  expect(paneShell(info("pwsh"))).toBe("powershell");
  expect(paneShell(info("CMD.EXE"))).toBe("cmd");
  expect(paneShell(info("-zsh"))).toBe("posix");
  expect(paneShell(undefined, "D:\\dev")).toBe("powershell");
  expect(paneShell(undefined, "/home/u")).toBe("posix");
});

test("remote footer asks only for steps a lane on another machine can take; local footer is unchanged", () => {
  const remote = footer(lane(), "lead:p1");
  expect(remote).not.toContain("claim-done --evidence");
  expect(remote).not.toContain("dori claim-done remote-lane");
  expect(remote).not.toContain("lead:p1");
  expect(remote).toContain("[REPORT] remote-lane | done |");
  const local = footer(lane({ machine: undefined }), "lead:p1");
  expect(local).toContain("sent to pane lead:p1 as an argv array");
  expect(local).toContain('When done: dori claim-done remote-lane --evidence "<merge SHA, closed issue, version>"');
});

test("close runs a remote lane's command signals in the local defaultCwd, also for entries that stored the remote path", async () => {
  for (const entry of [lane({ cwd: undefined, remoteCwd: "D:\\dev\\app" }), lane({ cwd: "D:\\dev\\app" })]) {
    const d = deps();
    await d.registry.write(entry);
    const dirs: (string | undefined)[] = [];
    const run: Runner = (argv, opts) => {
      if (argv[0] === "gh") { dirs.push(opts?.cwd); return Promise.resolve({ code: 0, err: "", out: '[{"number":7}]' }); }
      return d.run(argv, opts);
    };
    const result = await closeLane({ ...d, run }, { ...entry, done: 'command ["gh","pr","list"] stdout~"number"' }, "verified");
    expect(result.closed).toBe(true);
    expect(dirs).toEqual([d.config.defaultCwd]);
  }
});

test("adopt --machine keeps the given directory as the remote path, never as a local cwd", async () => {
  const d = deps();
  const adopted = await adoptLane(d, { ...lane({ cwd: "D:\\dev\\app" }), pane: "w:p3" });
  expect(adopted).toMatchObject({ remoteCwd: "D:\\dev\\app" });
  expect(adopted.cwd).toBeUndefined();
  expect((await adoptLane(d, { ...lane({ key: "local-adopted", machine: undefined, cwd: "/repo/x" }), pane: "w:p4" })).cwd).toBe("/repo/x");
});

test("a failed remote pane run is not registered as a launched lane", async () => {
  const d = deps();
  const input = lane();
  await Bun.write(input.brief, "work\n");
  const run: Runner = (argv, opts) => argv[4] === "run"
    ? Promise.resolve({ code: 1, out: "", err: "machine disconnected" })
    : d.run(argv, opts);
  await expect(launchLane({ ...d, run }, input)).rejects.toThrow("herdr pane run failed");
  expect(await d.registry.read(input.key)).toBeNull();
});

test("remote startup failure screen reads stay on the selected machine", async () => {
  const d = deps();
  world.panes = [];
  world.screen = "Error: No API key";
  const input = lane();
  await Bun.write(input.brief, "work\n");
  expect((await launchLane(d, input)).startup).toStartWith("STARTUP_ERROR");
  expectRemote();
  expect(calls.some((argv) => argv[4] === "read")).toBe(true);
});

test("adopt records machine and sync reads its inventory and remote session argv", async () => {
  const d = deps();
  await adoptLane(d, { ...lane(), pane: "w:p3" });
  expect((await d.registry.read("remote-lane"))?.machine).toBe(MACHINE);
  const result = await syncRegistry(d, true);
  expect(result.drift).toEqual([]);
  expect(result.rows[0]?.session).toBe("remote-session (argv)");
  expect((await d.registry.read("remote-lane"))?.session).toBe("remote-session");
  expect(calls).toContainEqual(["herdr", "--machine", MACHINE, "pane", "list"]);
  expect(calls).toContainEqual(["herdr", "--machine", MACHINE, "pane", "process-info", "--pane", "w:p3"]);
});

test("local entries and argv stay unchanged without machine", async () => {
  const d = deps(false);
  const input = lane({ machine: undefined });
  await adoptLane(d, { ...input, pane: "w:p3" });
  await syncRegistry(d, false);
  expect((await d.registry.read(input.key))?.machine).toBeUndefined();
  expect(remoteCalls().every((argv) => argv[1] !== "--machine")).toBe(true);
  expect(herdrArgv({}, ["pane", "list"])).toEqual(["herdr", "pane", "list"]);
  expect(laneRunner(d.run, {})).toBe(d.run);
});

test("byPane distinguishes a local pane from the same ID on a saved machine", async () => {
  const d = deps();
  await d.registry.write(lane());
  await d.registry.write(lane({ key: "local-lane", machine: undefined }));
  expect((await d.registry.byPane("w:p3"))?.key).toBe("local-lane");
  expect((await d.registry.byPane("w:p3", MACHINE))?.key).toBe("remote-lane");
});

test("remote pause reads back the goal and interrupts only the remote turn", async () => {
  const d = deps();
  const input = lane();
  for (const pane of world.panes) pane.agent_status = "working";
  world.onEscapeStatus = "idle";
  world.screens = ["", "Goal paused\n"];
  const result = await pauseLane(d, input, "wait");
  expect(result.code).toBe(0);
  expect(result.lane.status).toBe("paused");
  expectRemote();
  expect(calls).toContainEqual(["herdr", "--machine", MACHINE, "pane", "send-text", "w:p3", "/goal pause"]);
  expect(calls).toContainEqual(["herdr", "--machine", MACHINE, "pane", "send-keys", "w:p3", "escape"]);
});

test("remote resume reads back the remote goal before restoring lane state", async () => {
  const d = deps();
  world.screens = ["Goal paused\n", "Goal active\n"];
  const result = await resumeLane(d, lane({ status: "paused" }), "go");
  expect(result.code).toBe(0);
  expect(result.lane.status).toBe("working");
  expectRemote();
});

test("claim and objection messages route to the remote pane", async () => {
  const d = deps();
  await claimDone(d, lane(), "verified");
  await objectDone(d, lane(), ["not yet"]);
  expectRemote();
  expect(remoteCalls().filter((argv) => argv[4] === "send-text")).toHaveLength(2);
});

test("after an objection a remote lane's stale done line is not re-claimed, and a new done line claims again", async () => {
  const d = deps();
  await d.registry.write(lane());
  world.screen = "[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
  expect(await watchTick(d)).toEqual(["LANE_DONE_CLAIMED remote-lane w:p3 closed acme/app#3"]);
  await objectDone(d, (await d.registry.read("remote-lane")) ?? lane(), ["changelog missing"]);
  expect(await watchTick(d)).toEqual([]);
  // The objection itself lands on the lane's screen; it must never read as a new claim.
  const objection = remoteCalls().filter((argv) => argv[4] === "send-text").at(-1)?.[6] ?? "";
  expect(objection).toStartWith("[LEAD] not done: changelog missing");
  world.screen = `[REPORT] remote-lane | done | closed acme/app#3\n❯ ${objection}\n`;
  expect(await watchTick(d)).toEqual([]);
  world.screen = "[REPORT] remote-lane | done | closed acme/app#3, changelog added\n❯ ";
  expect(await watchTick(d)).toEqual(["LANE_DONE_CLAIMED remote-lane w:p3 closed acme/app#3, changelog added"]);
});

test("freshness nudges a quiet remote lane without touching the local namesake", async () => {
  const d = deps();
  await d.registry.write(lane({ openedAt: new Date(T0 - 16 * 60_000).toISOString() }));
  expect((await freshnessTick(d, "/home/test")).map((act) => act.kind)).toEqual(["nudged"]);
  expectRemote();
});

test("dead-panes scopes remote reads and state independently from local IDs", async () => {
  const d = deps();
  world.panes = [{ pane_id: "w:p3", workspace_id: "w" }, { pane_id: "w:p9", workspace_id: "w" }];
  world.screen = "agent has stopped";
  const seen = new Set<string>();
  const memory = newDeadPaneState();
  expect(await deadPaneTick(d.run, d.config, seen, "hour", memory, [lane()])).toEqual([]);
  const result = await deadPaneTick(d.run, d.config, seen, "hour", memory, [lane()]);
  expect(result).toEqual([`DEAD_PANE w:p3 machine=${MACHINE}`]);
  expect(calls).toContainEqual(["herdr", "--machine", MACHINE, "pane", "read", "w:p3", "--source", "recent", "--lines", "6"]);
  expect(calls.some((argv) => argv[1] === "--machine" && argv.includes("w:p9"))).toBe(false);
});

test("remote worktree checks and cleanup skip explicitly and never run local git", async () => {
  const d = deps();
  const input = lane({ worktrees: ["/remote-only/repo"] });
  expect(await discoverWorktrees(input, d.run)).toEqual([]);
  expect(await unpushedWork(d, input)).toEqual([]);
  expect(await closedWorktreeSweep(d, { ...input, closedAt: new Date(T0).toISOString(), receipt: { cleanup: ["worktree /data/repos/worktrees/x kept: dirty"] } })).toEqual([]);
  const result = await closeLane(d, input, "verified");
  expect(result.closed).toBe(true);
  expect(result.lines.some((line) => line.startsWith("WORKTREE_CHECK SKIPPED"))).toBe(true);
  expect((await d.registry.read(input.key))?.receipt).toMatchObject({ worktreeCheck: { status: "skipped" } });
  expect(calls.some((argv) => argv[0] === "git")).toBe(false);
  expectRemote();
});

test("watch settles a remote claim using remote close and records skipped worktree detail", async () => {
  const d = deps();
  await d.registry.write(lane({ status: "done-claimed", claim: { at: new Date(T0 - 6 * 60_000).toISOString(), evidence: "verified", emitted: true } }));
  expect((await watchTick(d))[0]).toStartWith("LANE_CLOSED");
  expect((await d.registry.read("remote-lane"))?.receipt).toMatchObject({ worktreeCheck: { status: "skipped" } });
  expectRemote();
});

test("a remote lane's [REPORT] done becomes a claim in the same window; a question wakes the lead once; footer placeholders are ignored", async () => {
  const d = deps();
  await d.registry.write(lane());
  world.screen = "- When done: print [REPORT] remote-lane | done | <merge SHA, closed issue, version> and stay idle.\n❯ ";
  expect(await watchTick(d)).toEqual([]);
  world.screen = "[REPORT] remote-lane | question | which base branch?\n❯ ";
  expect(await watchTick(d)).toEqual(["LANE_REPORT remote-lane question which base branch?"]);
  expect(await watchTick(d)).toEqual([]);
  world.screen = "[REPORT] remote-lane | done | closed acme/app#3 by abc123\n❯ ";
  expect(await watchTick(d)).toEqual(["LANE_DONE_CLAIMED remote-lane w:p3 closed acme/app#3 by abc123"]);
  const claimed = await d.registry.read("remote-lane");
  expect(claimed && statusOf(claimed)).toBe("done-claimed");
  expect(remoteCalls().some((argv) => argv[4] === "send-text" && argv[6]?.startsWith("[LEAD] done claim recorded"))).toBe(true);
  expect(await watchTick(d)).toEqual([]);
  (d.clock as ReturnType<typeof fakeClock>).at += 5 * 60_000 + 1;
  expect((await watchTick(d))[0]).toStartWith("LANE_CLOSED remote-lane");
  expectRemote();
});

test("two remote reports printed between two polls both arrive, in order", async () => {
  const screen = "[REPORT] remote-lane | question | which base branch?\nworking...\n[REPORT] remote-lane | blocker | CI runner down\n❯ ";
  const on = deps();
  await on.registry.write(lane());
  world.screen = screen;
  expect(await watchTick(on)).toEqual(["LANE_REPORT remote-lane question which base branch?", "LANE_REPORT remote-lane blocker CI runner down"]);
  // Each line once: the same screen again adds nothing; a new line after them is the only new report.
  expect(await watchTick(on)).toEqual([]);
  world.screen = `${screen}\n[REPORT] remote-lane | milestone | PR open\n[REPORT] remote-lane | question | merge now?\n❯ `;
  expect(await watchTick(on)).toEqual(["LANE_REPORT remote-lane question merge now?"]);
  const seen = (await on.registry.read("remote-lane"))?.remoteReportsSeen ?? [];
  expect(seen).toHaveLength(4);
  expect((await on.registry.read("remote-lane"))?.lastRemoteReport).toBe("[REPORT] remote-lane | question | merge now?");
});

test("a lane an older dori already read (newest line only) replays none of its earlier lines", async () => {
  const d = deps();
  await d.registry.write(lane({ lastRemoteReport: "[REPORT] remote-lane | blocker | CI runner down" }));
  world.screen = "[REPORT] remote-lane | question | which base branch?\n[REPORT] remote-lane | blocker | CI runner down\n[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
  expect(await watchTick(d)).toEqual(["LANE_DONE_CLAIMED remote-lane w:p3 closed acme/app#3"]);
});

test("remote session lookup cannot mistake a local matching PID for its session", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: 100 } } }) };
  };
  const result = await resolveSession("w:p3", "/repo", [{ pid: 200, ppid: 100, cmd: "omo --session-id wrong-local" }], {
    run, sessionsDir: "/local/sessions", listDir: () => { throw new Error("must not read local sessions"); },
  }, { machine: MACHINE });
  expect(result).toEqual({ id: "", via: "none" });
  expect(calls).toEqual([["herdr", "--machine", MACHINE, "pane", "process-info", "--pane", "w:p3"]]);
});

test("GitHub supervision keeps remote signal targets without reading remote paths locally", async () => {
  const d = deps();
  const targets = await githubTargets([lane({ done: 'merged acme/app#7; command ["gh","pr","list","-R","other/repo","--head","remote-branch"]' })], d.run);
  expect([...targets.get("acme/app")?.numbers ?? []]).toEqual([7]);
  expect([...targets.get("other/repo")?.branches ?? []]).toEqual(["remote-branch"]);
  expect(calls).toEqual([]);
});

test("sync's session update re-reads the lane, so an objection written while sync ran survives", async () => {
  const d = deps();
  await adoptLane(d, { ...lane(), pane: "w:p3" });
  const objection = { at: new Date(T0).toISOString(), reasons: ["unpushed work"] };
  const run: Runner = async (argv, opts) => {
    if (argv.includes("process-info")) {
      const current = await d.registry.read("remote-lane");
      if (current && !current.objection) await d.registry.write({ ...current, status: "not-done", objection });
    }
    return d.run(argv, opts);
  };
  await syncRegistry({ ...d, run }, true);
  const after = await d.registry.read("remote-lane");
  expect(after?.session).toBe("remote-session");
  expect(after?.objection).toEqual(objection);
  expect(after?.status).toBe("not-done");
});
