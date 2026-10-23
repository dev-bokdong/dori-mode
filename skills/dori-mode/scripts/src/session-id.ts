import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";
import type { Lane } from "./registry.ts";
import { laneRunner } from "./panes.ts";

export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string };
export type SessionHit = { readonly id: string; readonly via: "argv" | "child-env" | "start-time" | "none"; readonly pid?: number };

const AGENT = /senpi\/dist\/bundle\/cli\.js|(^|\/)omo(\s|$)/;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

export const procTable = async (run: Runner): Promise<Proc[]> =>
  (await run(["ps", "-A", "-o", "pid=,ppid=,command="])).out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" }] : [];
  });

const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

export const sessionDirFor = (sessionsDir: string, cwd: string): string => join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);

export type SessionDeps = { readonly run: Runner; readonly sessionsDir: string; readonly listDir?: (dir: string) => readonly string[] };

export const resolveSession = async (pane: string, cwd: string, table: readonly Proc[], deps: SessionDeps, lane: Pick<Lane, "machine"> = {}): Promise<SessionHit> => {
  deps = { ...deps, run: laneRunner(deps.run, lane) };
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", pane]);
  if (lane.machine) {
    // Remote PIDs and session files must never be resolved against the lead host.
    const processes: readonly { readonly argv?: readonly string[]; readonly pid?: number }[] =
      info.code === 0 ? (JSON.parse(info.out).result?.process_info?.foreground_processes ?? []) : [];
    for (const process of processes) {
      const argv = process.argv ?? [];
      if (!argv.some((arg) => AGENT.test(arg))) continue;
      const at = argv.indexOf("--session") >= 0 ? argv.indexOf("--session") : argv.indexOf("--session-id");
      const id = at >= 0 ? argv[at + 1] : undefined;
      if (id) return { id, via: "argv", ...(process.pid ? { pid: process.pid } : {}) };
    }
    return { id: "", via: "none" };
  }
  const shellPid = info.code === 0 ? Number((JSON.parse(info.out) as { result?: { process_info?: { shell_pid?: number } } }).result?.process_info?.shell_pid ?? 0) : 0;
  const agent = shellPid ? descendants(table, shellPid).find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd)) : undefined;
  if (!agent) return { id: "", via: "none" };
  const argv = agent.cmd.split(/\s+/);
  const flagAt = argv.indexOf("--session") >= 0 ? argv.indexOf("--session") : argv.indexOf("--session-id");
  const fromFlag = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
  if (fromFlag) return { id: fromFlag, via: "argv", pid: agent.pid };
  for (const child of descendants(table, agent.pid).slice(0, 40)) {
    const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)]);
    const hit = ENV_ID.exec(env.out);
    if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
  }
  const started = Date.parse((await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list = deps.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const near = list(sessionDirFor(deps.sessionsDir, cwd)).flatMap((name) => {
    const m = SESSION_FILE.exec(name);
    const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
    return m?.[5] && at >= started - 5_000 && at <= started + START_WINDOW_MS ? [{ id: m[5], at }] : [];
  }).sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};
