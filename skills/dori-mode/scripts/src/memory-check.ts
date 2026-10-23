import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Repos } from "./repos.ts";
import type { Runner } from "./run.ts";

/**
 * Read-only check of the lead's omo memory: system/human.md against `memoryCheck.maxKb`, and Open items that still
 * reference finished work (a closed lane, a merged PR). Detection only; condensing stays with the lead.
 */

export class MemoryCheckError extends Error {}

export const MEMORY_FILE = join("system", "human.md");
export const MEMORY_CHECK_EVERY_MS = 24 * 60 * 60_000;
/** A lane close is checked this long after it is first seen, so the lead's own cleanup turn comes first. */
export const MEMORY_CHECK_AFTER_CLOSE_MS = 15 * 60_000;

export type OpenItem = { readonly index: number; readonly label: string; readonly text: string };
export type StaleItem = { readonly item: OpenItem; readonly refs: readonly string[] };
export type MemoryReport = {
  readonly file: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly items: number;
  readonly stale: readonly StaleItem[];
  readonly unchecked: readonly string[];
};

/**
 * The lead's memory repo: `memoryCheck.repo`, else omo's per-cwd repo for the lead's cwd (`defaultCwd`), found as
 * <home>/.omo/memory/agents/<slug>-<first 8 hex of sha256(cwd)>/repo. Undefined when neither exists.
 */
export const resolveMemoryRepo = (config: DoriConfig, home: string): string | undefined => {
  if (config.memoryCheck.repo.trim()) return config.memoryCheck.repo.trim();
  const agents = join(home, ".omo", "memory", "agents");
  const suffix = `-${createHash("sha256").update(config.defaultCwd).digest("hex").slice(0, 8)}`;
  let names: string[];
  try { names = readdirSync(agents); } catch { return undefined; }
  const hit = names.filter((name) => name.endsWith(suffix)).sort().find((name) => existsSync(join(agents, name, MEMORY_FILE)) || existsSync(join(agents, name, "repo", MEMORY_FILE)));
  return hit ? join(agents, hit, "repo") : undefined;
};

/** Top-level bullets under the `## Open` heading; indented lines belong to the bullet above. */
export const openItems = (text: string): OpenItem[] => {
  const items: string[] = [];
  let inOpen = false;
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line)) { inOpen = /^##\s+Open\b/i.test(line); continue; }
    if (!inOpen) continue;
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (items.length && line.trim()) items[items.length - 1] += `\n${line}`;
  }
  return items.map((body, i) => {
    const first = body.split("\n")[0] ?? "";
    return { index: i + 1, label: first.length > 60 ? `${first.slice(0, 57)}...` : first, text: body };
  });
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string): RegExp => new RegExp(`(?<![\\w-])${escape(s)}(?![\\w-])`, "i");

export type Refs = {
  readonly lanes: readonly string[];
  /** owner/repo#N, resolved; bare PR numbers whose repo is not clear go to `unresolved`. */
  readonly prs: readonly string[];
  readonly unresolved: readonly string[];
};

/**
 * What an Open item points at. Lane keys match whole words. PRs: owner/repo#N, a github.com pull URL, or "PR #N" when
 * the item names exactly one repo as owner/repo (a known repo, or any repo of a known owner). A bare repo name is not
 * enough ("app #188" is not the app repo).
 */
export const itemRefs = (text: string, closedLanes: Iterable<string>, repos: readonly string[]): Refs => {
  const lanes = [...closedLanes].filter((key) => word(key).test(text));
  const prs = new Set<string>();
  for (const m of text.matchAll(/(?<![\w./-])([A-Za-z0-9][\w.-]*\/[\w.-]*[\w])#(\d+)/g)) prs.add(`${m[1]?.toLowerCase()}#${m[2]}`);
  for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) prs.add(`${m[1]?.toLowerCase()}#${m[2]}`);
  const owners = new Set(repos.map((repo) => repo.split("/")[0]));
  const named = [...new Set([...text.matchAll(/(?<![\w./~-])([A-Za-z0-9][\w-]*)\/([\w.-]*[\w])(?![\w/#-])/g)]
    .map((m) => `${m[1]}/${m[2]}`.toLowerCase())
    .filter((slug) => repos.includes(slug) || owners.has(slug.split("/")[0])))];
  const unresolved: string[] = [];
  for (const m of text.matchAll(/\bPRs?\s*#(\d+)/gi)) {
    if (named.length === 1) prs.add(`${named[0]}#${m[1]}`);
    else unresolved.push(`PR #${m[1]}`);
  }
  return { lanes, prs: [...prs], unresolved: [...new Set(unresolved)] };
};

/**
 * Keys of closed lanes: the archive (by file name, no lane file is read: this runs every sweep round) and the files
 * hand-moved to the old <stateDir>/lanes-closed (now lanes-archive/legacy); never an open key.
 */
export const closedLaneKeys = async (deps: FlowDeps): Promise<string[]> => {
  const open = new Set((await deps.registry.open()).map((l) => l.key));
  const keys = new Set(deps.registry.archivedKeys());
  for (const [path, file] of deps.registry.legacyFiles()) {
    let key: unknown;
    try { key = (JSON.parse(readFileSync(path, "utf8")) as { key?: unknown }).key; } catch { key = undefined; }
    const named = typeof key === "string" && key ? key : file.split(".")[0];
    if (named) keys.add(named);
  }
  return [...keys].filter((key) => !open.has(key)).sort();
};

/** Repos a bare "PR #N" may mean: this machine's watched repos and every repo a lane's Done signal names. */
const knownRepos = async (deps: FlowDeps): Promise<string[]> => {
  const repos = new Set(new Repos(deps.config.stateDir).list());
  for (const lane of await deps.registry.list()) {
    for (const m of lane.done.matchAll(/(?:"-R",\s*"|-R\s+)([\w.-]+\/[\w.-]+)/g)) if (m[1]) repos.add(m[1].toLowerCase());
    for (const m of lane.done.matchAll(/([\w.-]+\/[\w.-]+)#\d+/g)) if (m[1]) repos.add(m[1].toLowerCase());
  }
  return [...repos].sort();
};

const T = { timeoutMs: 20_000 };

const prState = async (run: Runner, ref: string): Promise<{ readonly state?: string; readonly error?: string }> => {
  const [repo = "", number = ""] = ref.split("#");
  const r = await run(["gh", "pr", "view", number, "-R", repo, "--json", "state"], T);
  if (r.code !== 0) return { error: (r.err || r.out).trim().split("\n")[0]?.slice(0, 120) || `gh exit ${r.code}` };
  try { return { state: String((JSON.parse(r.out) as { state?: unknown }).state ?? "").toLowerCase() }; }
  catch { return { error: "gh printed no JSON" }; }
};

/** Reads only: the memory file, the registry and gh. Throws MemoryCheckError when the memory file is missing. */
export const checkMemory = async (deps: FlowDeps, home: string): Promise<MemoryReport> => {
  const repo = resolveMemoryRepo(deps.config, home);
  if (!repo) throw new MemoryCheckError(`lead memory repo not found: memoryCheck.repo is unset and no omo memory repo exists for ${deps.config.defaultCwd} under ${join(home, ".omo", "memory", "agents")}`);
  const file = join(repo, MEMORY_FILE);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new MemoryCheckError(`${file} is missing or unreadable`); }
  const bytes = statSync(file).size;
  const items = openItems(text);
  const closed = await closedLaneKeys(deps);
  const repos = await knownRepos(deps);
  const refs = items.map((item) => ({ item, refs: itemRefs(item.text, closed, repos) }));
  const prs = [...new Set(refs.flatMap((r) => r.refs.prs))];
  const unchecked: string[] = [];
  const prStates = new Map(await Promise.all(prs.map(async (ref) => [ref, await prState(deps.run, ref)] as const)));
  for (const [ref, s] of prStates) if (s.error) unchecked.push(`PR ${ref}: ${s.error}`);
  for (const { item, refs: r } of refs) for (const pr of r.unresolved) unchecked.push(`item ${item.index}: ${pr} (repo unclear; write owner/repo#N)`);
  const stale = refs.flatMap(({ item, refs: r }): StaleItem[] => {
    const found = [
      ...r.lanes.map((key) => `closed lane ${key}`),
      ...r.prs.filter((ref) => prStates.get(ref)?.state === "merged").map((ref) => `merged PR ${ref}`),
    ];
    return found.length ? [{ item, refs: found }] : [];
  });
  return { file, bytes, limitBytes: Math.round(deps.config.memoryCheck.maxKb * 1024), items: items.length, stale, unchecked };
};

export const needsAction = (r: MemoryReport): boolean => r.bytes > r.limitBytes || r.stale.length > 0;

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`;

/** One line for the lead's event log; empty when nothing needs doing. */
export const memoryEvent = (r: MemoryReport): string => {
  if (!needsAction(r)) return "";
  const parts = [
    ...(r.bytes > r.limitBytes ? [`human.md is ${kb(r.bytes)}, over the ${kb(r.limitBytes)} limit`] : []),
    ...(r.stale.length ? [`${r.stale.length} Open item(s) reference finished work: ${r.stale.map((s) => `#${s.item.index} ${s.refs.join(", ")}`).join("; ")}`] : []),
  ];
  const line = `MEMORY_CHECK ${parts.join("; ")}`;
  const tail = " (run dori memory check, then condense or delete them)";
  return `${line.length > 600 ? `${line.slice(0, 597)}...` : line}${tail}`;
};

export const renderMemoryReport = (r: MemoryReport): string => [
  `MEMORY_FILE ${r.file}`,
  `SIZE ${r.bytes} bytes (${kb(r.bytes)}), limit ${kb(r.limitBytes)}: ${r.bytes > r.limitBytes ? `OVER by ${kb(r.bytes - r.limitBytes)}` : "ok"}`,
  `OPEN_ITEMS ${r.items}`,
  ...r.stale.map((s) => `STALE #${s.item.index} ${JSON.stringify(s.item.label)}: ${s.refs.join("; ")}`),
  ...r.unchecked.map((u) => `UNCHECKED ${u}`),
  needsAction(r) ? "MEMORY_CHECK action needed: condense human.md and delete or shrink the STALE Open items" : "MEMORY_CHECK clean",
].join("\n");

type SweepState = { readonly at?: number; readonly closed?: readonly string[]; readonly pendingSince?: number; readonly sent?: string };

const saveState = (path: string, state: SweepState): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
};

/**
 * The supervisor's memory sweep. It checks once every MEMORY_CHECK_EVERY_MS and MEMORY_CHECK_AFTER_CLOSE_MS after a
 * newly closed lane is first seen. Findings become one MEMORY_CHECK line, sent again only when they change; state
 * lives in <stateDir>/memory-check.json. The run is recorded before checking, so a failure waits for the next turn.
 */
export const memorySweep = async (deps: FlowDeps, home: string): Promise<string[]> => {
  const path = join(deps.config.stateDir, "memory-check.json");
  const now = deps.clock.now();
  const state: SweepState = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SweepState : {};
  const closed = await closedLaneKeys(deps);
  const known = new Set(state.closed ?? closed);
  const fresh = closed.some((key) => !known.has(key));
  const next: SweepState = { ...state, closed, pendingSince: state.pendingSince ?? (fresh ? now : undefined) };
  const due = now - (next.at ?? -Infinity) >= MEMORY_CHECK_EVERY_MS ||
    (next.pendingSince !== undefined && now - next.pendingSince >= MEMORY_CHECK_AFTER_CLOSE_MS);
  if (!due) {
    if (JSON.stringify(next) !== JSON.stringify(state)) saveState(path, next);
    return [];
  }
  saveState(path, { ...next, at: now, pendingSince: undefined });
  let report: MemoryReport;
  try { report = await checkMemory(deps, home); }
  catch (e) {
    if (e instanceof MemoryCheckError) return [`MEMORY_CHECK_WARN ${e.message}`];
    throw e;
  }
  const line = memoryEvent(report);
  const fingerprint = line
    ? createHash("sha256").update(JSON.stringify([report.bytes > report.limitBytes, report.stale.flatMap((s) => s.refs).sort()])).digest("hex").slice(0, 16)
    : undefined;
  saveState(path, { ...next, at: now, pendingSince: undefined, ...(fingerprint ? { sent: fingerprint } : {}) });
  return line && fingerprint !== state.sent ? [line] : [];
};
