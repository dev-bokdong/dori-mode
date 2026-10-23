import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";
import { Database } from "bun:sqlite";

import { GITHUB_FILE, loadGithub } from "../src/github-events.ts";
import { JOURNAL_FILE, SQLITE_FILE, SqliteStore, type StoreKind } from "../src/store.ts";
import type { Journal } from "../src/supervise.ts";

/** The journal store the suite runs against: DORI_TEST_STORE=sqlite runs every supervisor test on supervisor.sqlite. */
export const TEST_STORE: StoreKind = process.env.DORI_TEST_STORE === "sqlite" ? "sqlite" : "json";

/** The supervisor journal as stored, whichever store the suite runs on. */
export const readJournal = (stateDir: string): any => {
  if (TEST_STORE === "json") return JSON.parse(readFileSync(join(stateDir, JOURNAL_FILE), "utf8"));
  const store = new SqliteStore(join(stateDir, SQLITE_FILE));
  try { return store.read(false); } finally { store.close(); }
};

/** The GitHub poll state as stored, whichever store the suite runs on. */
export const readGithub = (stateDir: string): any => {
  if (TEST_STORE === "json") return JSON.parse(readFileSync(join(stateDir, GITHUB_FILE), "utf8"));
  const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
  try { return loadGithub(db); } finally { db.close(); }
};

/** Seeds the journal a supervisor will start from, replacing any stored one. */
export const writeJournal = (stateDir: string, journal: unknown): void => {
  if (TEST_STORE === "json") { writeFileSync(join(stateDir, JOURNAL_FILE), JSON.stringify(journal)); return; }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(stateDir, `${SQLITE_FILE}${suffix}`), { force: true });
  const store = new SqliteStore(join(stateDir, SQLITE_FILE), { create: true });
  try { store.save(journal as Journal, "normal"); } finally { store.close(); }
};

/** Every byte the journal store holds on disk (for the sqlite store: the database and its WAL). */
export const journalBytes = (stateDir: string): string => (TEST_STORE === "json" ? [JOURNAL_FILE] : [SQLITE_FILE, `${SQLITE_FILE}-wal`])
  .filter((name) => existsSync(join(stateDir, name))).map((name) => readFileSync(join(stateDir, name), "latin1")).join("");

export type World = {
  prState: string;
  issueState: string;
  aheadCount: string;
  dirty: string;
  stuckReads: number;
  screen: string;
  panes: { pane_id: string; workspace_id: string; agent?: string; agent_status?: string; title?: string; cwd?: string }[];
  /** agent_status the target pane moves to when Enter is pressed (models a lane picking up the message). */
  onEnterStatus?: string;
  /** agent_status the target pane moves to when Escape is pressed (models a running turn stopping). */
  onEscapeStatus?: string;
  /** Screens returned by successive reads; falls back to `screen` when empty. */
  screens?: string[];
  /** Worktrees a successful `git worktree remove` took away: no longer listed, and `exists` reads them gone. */
  removed: string[];
  calls: string[][];
};

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", stuckReads: 0, screen: "❯ ", panes: [], removed: [], calls: [] });

export const fakeRunner = (w: World): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if (cmd === "herdr" && a1 === "pane" && a2 === "read") {
    if (w.stuckReads > 0) {
      w.stuckReads--;
      return ok("❯ [LEAD] stuck text still here");
    }
    return ok(w.screens?.length ? (w.screens.shift() ?? w.screen) : w.screen);
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "send-keys" && argv[4] === "escape" && w.onEscapeStatus) {
    const p = w.panes.find((x) => x.pane_id === argv[3]);
    if (p) p.agent_status = w.onEscapeStatus;
    return ok();
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "send-keys" && w.onEnterStatus) {
    const p = w.panes.find((x) => x.pane_id === argv[3]);
    if (p) p.agent_status = w.onEnterStatus;
    return ok();
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: w.panes } }));
  // A closed pane leaves the pane list, so a close's read-back sees it gone.
  if (cmd === "herdr" && a1 === "pane" && a2 === "close") w.panes = w.panes.filter((p) => p.pane_id !== argv[3]);
  if (cmd === "herdr") return ok();
  if (cmd === "git" && argv.includes("worktree") && argv.includes("remove")) {
    const wt = argv.at(-1) ?? "";
    if (!w.removed.includes(wt)) w.removed.push(wt);
    return ok();
  }
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) {
    return ok(`worktree /repo\nbranch refs/heads/main${w.removed.includes(WT) ? "" : `\n\nworktree ${WT}\nbranch refs/heads/demo-lane`}`);
  }
  if (cmd === "git" && argv.includes("status")) return ok(w.dirty);
  if (cmd === "git" && argv.includes("rev-list")) return ok(w.aheadCount);
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

/**
 * An injected supervise() pause that waits for the test instead of real time: each loop parks until `tick()` (or its
 * abort), so a test moves the fake clock first and then lets every parked loop take its next pass.
 */
export const manualPause = (): { pause: (ms: number, signal: AbortSignal) => Promise<void>; tick: () => void; parked: () => number } => {
  const waiting = new Set<() => void>();
  return {
    pause: (_ms, signal) => new Promise<void>((resolve) => {
      const done = () => { waiting.delete(done); signal.removeEventListener("abort", done); resolve(); };
      waiting.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    }),
    tick: () => { for (const done of [...waiting]) done(); },
    parked: () => waiting.size,
  };
};

/**
 * On the sqlite test store, creates the state dir's database as `dori store import` does on a real host: closes, the
 * watcher and recovery keep their operation rows there and refuse a sqlite store without it (STORE_MISSING).
 */
export const withSqliteStore = (stateDir: string): void => {
  if (TEST_STORE === "sqlite" && !existsSync(join(stateDir, SQLITE_FILE))) new SqliteStore(join(stateDir, SQLITE_FILE), { create: true }).close();
};

export const withState = (root = tmpdir()): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(root, "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, defaultCwd: "/repo", leadPane: "lead:p1", store: TEST_STORE, ...patch };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, exists: (path) => !w.removed.includes(path) };
};

export const sent = (w: World): string[] => w.calls.filter((c) => c[0] === "herdr" && c[2] === "send-text").map((c) => c[4] ?? "");
