import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";
import { Repos } from "./repos.ts";
import type { Runner } from "./run.ts";
import { parseSignal, splitDone } from "./signals.ts";
import { RETENTION, SQLITE_FILE, SqliteStore, StoreError, type StoreKind } from "./store.ts";

export class GitHubError extends Error {}

export const GITHUB_FILE = "github-events.json";
/** github-events.json after its import into the store, kept read-only for audit. */
export const PRE_SQLITE_GITHUB_FILE = "github-events.json.pre-sqlite";
/** A cached response's use time is rewritten at most this often, so a 304 costs no write. */
const CACHE_TOUCH_MS = 24 * 60 * 60_000;

type Json = Readonly<Record<string, unknown>>;
/** `usedAt`: the last poll that read it; a response no poll used for RETENTION.statusHistoryMs is dropped. */
type Cached = { readonly etag?: string; readonly body: unknown; readonly next?: string; readonly usedAt?: number };
type Pull = {
  readonly number: number;
  readonly state: string;
  readonly sha: string;
  readonly branch: string;
  readonly updated: string;
  readonly url: string;
  readonly conflicting: boolean;
  readonly checks: "pending" | "failing" | "green" | "none";
  readonly activity: readonly string[];
};
export type OpenPull = Pick<Pull, "number" | "sha" | "branch" | "url" | "conflicting" | "checks"> & { readonly repo: string };
type Issue = { readonly state: string; readonly reopens: number };
type RepoState = {
  readonly cache: Readonly<Record<string, Cached>>;
  readonly pulls: Readonly<Record<string, Pull>>;
  /** Absent until the first issue poll of this repo, which only records a baseline. */
  readonly issues?: Readonly<Record<string, Issue>>;
};
type State = {
  readonly repos: Readonly<Record<string, RepoState>>;
  readonly failures: Readonly<Record<string, number>>;
  /** When the last poll tick finished, for dori status. */
  readonly polledAt?: number;
};
type Targets = { numbers: Set<number>; branches: Set<string> };
const EMPTY: State = { repos: {}, failures: {} };

/** The response fields the poll reads. The cache keeps only these: a cached PR is a few hundred bytes, not tens of KB. */
const READ_FIELDS = new Set([
  "number", "state", "updated_at", "merged_at", "head", "sha", "ref", "html_url", "mergeable", "mergeable_state", "check_runs",
  "conclusion", "status", "statuses", "id", "user", "login", "type", "submitted_at", "created_at", "pull_request",
]);
export const slimBody = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(slimBody);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => READ_FIELDS.has(key)).map(([key, field]) => [key, slimBody(field)]));
};
type Emit = (id: string, line: string) => void;

const object = (value: unknown): Json => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubError("expected GitHub object");
  return value as Json;
};
const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new GitHubError("expected GitHub array");
  return value;
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const repoFromRemote = (remote: string): string | undefined =>
  /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1]?.toLowerCase();

/** Registry signals carry PR identity; a lane worktree carries its branch identity. */
export const githubTargets = async (lanes: readonly Lane[], run: Runner): Promise<Map<string, Targets>> => {
  const targets = new Map<string, Targets>();
  const target = (repo: string): Targets => {
    const key = repo.toLowerCase();
    let hit = targets.get(key);
    if (!hit) { hit = { numbers: new Set(), branches: new Set() }; targets.set(key, hit); }
    return hit;
  };
  for (const lane of lanes) {
    for (const part of splitDone(lane.done)) {
      try {
        const signal = parseSignal(part);
        if (signal.kind === "merged") target(signal.repo).numbers.add(Number(signal.n));
        if (signal.kind === "command" && signal.argv[0] === "gh" && signal.argv[1] === "pr") {
          const at = signal.argv.findIndex((arg) => arg === "-R" || arg === "--repo");
          const repo = signal.argv[at + 1];
          const branch = signal.argv[signal.argv.indexOf("--head") + 1];
          if (at >= 0 && repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && signal.argv.includes("--head") && branch) target(repo).branches.add(branch);
        }
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        // Other/legacy done signals do not establish a GitHub association.
      }
    }
    if (lane.machine) continue; // Remote paths cannot establish a branch on the lead host.
    for (const cwd of new Set([lane.cwd, ...(lane.worktrees ?? [])].filter((p): p is string => Boolean(p)))) {
      const remote = await run(["git", "-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 2_000 });
      const repo = remote.code === 0 ? repoFromRemote(remote.out) : undefined;
      if (!repo) continue;
      const branch = await run(["git", "-C", cwd, "branch", "--show-current"], { timeoutMs: 2_000 });
      if (branch.code === 0 && branch.out) target(repo).branches.add(branch.out);
    }
  }
  return targets;
};

/** Conditional REST cache is staged until all events have reached the durable queue. */
class Api {
  readonly cache: Record<string, Cached>;
  private readonly deadline: number;

  constructor(private readonly run: Runner, old: Readonly<Record<string, Cached>>, timeoutMs: number, private readonly now: number) {
    this.cache = { ...old };
    this.deadline = Date.now() + timeoutMs;
  }

  async get(path: string): Promise<Cached> {
    const old = this.cache[path];
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new GitHubError("repo poll timeout");
    const result = await this.run([
      "gh", "api", "--method", "GET", "--include", path,
      "-H", "Accept: application/vnd.github+json",
      ...(old?.etag ? ["-H", `If-None-Match: ${old.etag}`] : []),
    ], { timeoutMs: remaining });
    const split = /\r?\n\r?\n/.exec(result.out);
    const headers = split ? result.out.slice(0, split.index) : result.out;
    const status = Number(/^HTTP\/[\d.]+\s+(\d+)/.exec(headers)?.[1]);
    // gh versions may return a nonzero exit for a bodyless 304.
    if (status === 304 && old) {
      if (this.now - (old.usedAt ?? 0) < CACHE_TOUCH_MS) return old;
      const used = { ...old, usedAt: this.now };
      this.cache[path] = used;
      return used;
    }
    if (result.code !== 0 || status !== 200) throw new GitHubError(`gh api HTTP ${status || "unavailable"} exit=${result.code}`);
    const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim();
    const link = /^link:\s*(.+)$/im.exec(headers)?.[1];
    const next = link?.split(",").find((part) => /rel="next"/.test(part))?.match(/<https:\/\/api\.github\.com\/([^>]+)>/)?.[1];
    const body: unknown = JSON.parse(result.out.slice((split?.index ?? 0) + (split?.[0].length ?? 0)));
    const cached = { etag, body: slimBody(body), next, usedAt: this.now };
    this.cache[path] = cached;
    return cached;
  }

  async pages(path: string, key?: string): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    let next: string | undefined = path;
    while (next) {
      const page = await this.get(next);
      items.push(...array(key ? object(page.body)[key] : page.body));
      next = page.next;
    }
    return items;
  }
}

const checkState = (runs: readonly unknown[], statuses: Json): Pull["checks"] => {
  const checks = runs.map(object);
  if (statuses.state === "failure" || statuses.state === "error" ||
      checks.some((c) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(text(c.conclusion)))) return "failing";
  const count = array(statuses.statuses).length;
  if (checks.some((c) => c.status !== "completed") || (count > 0 && statuses.state === "pending")) return "pending";
  return checks.length + count > 0 ? "green" : "none";
};

/**
 * GitHub status history (RETENTION.statusHistoryMs): a closed or merged PR quiet that long keeps its baseline but not its
 * activity ids (a later reply is still new: the poll's closed-history rule never replays older ones), and a cached
 * response no poll used that long is dropped (the next request is simply unconditional).
 */
const retainHistory = (pulls: Record<string, Pull>, cache: Readonly<Record<string, Cached>>, now: number): Record<string, Cached> => {
  const cutoff = now - RETENTION.statusHistoryMs;
  for (const [number, pull] of Object.entries(pulls)) {
    if (pull.state !== "open" && pull.activity.length && Date.parse(pull.updated) < cutoff) pulls[number] = { ...pull, activity: [] };
  }
  const kept: Record<string, Cached> = {};
  for (const [path, entry] of Object.entries(cache)) {
    if (entry.usedAt === undefined) kept[path] = { ...entry, usedAt: now };
    else if (entry.usedAt >= cutoff) kept[path] = entry;
  }
  return kept;
};

export class GitHubEvents {
  private readonly path: string;
  private state: State;
  /** The store holding the poll state once the journal is on sqlite; github-events.json otherwise. */
  private readonly store?: SqliteStore;

  constructor(private readonly stateDir: string, store: StoreKind = "json", now: () => number = Date.now) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, GITHUB_FILE);
    if (store !== "sqlite") {
      this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : EMPTY;
      return;
    }
    this.store = new SqliteStore(join(stateDir, SQLITE_FILE), { create: true, now });
    try {
      this.store.database.exec("PRAGMA synchronous = NORMAL");
      // The supervisor lock is held (the only writer of the file), so this is the quiesced barrier for its import.
      if (existsSync(this.path)) {
        importGithub(this.store.database, stateDir, now());
        retireGithubFile(stateDir);
      }
      this.state = loadGithub(this.store.database);
    } catch (e) {
      this.store.close();
      throw e;
    }
  }

  close(): void { this.store?.close(); }

  /** The open PRs as of the last poll, per repo (ci-follow.ts reads it after each tick; no GitHub call). */
  openPulls(): readonly OpenPull[] {
    return Object.entries(this.state.repos).flatMap(([repo, state]) => Object.values(state.pulls)
      .filter((p) => p.state === "open")
      .map((p) => ({ repo, number: p.number, sha: p.sha, branch: p.branch, url: p.url, conflicting: p.conflicting, checks: p.checks })));
  }

  /** The merged PRs the polls have seen, per repo (ci-follow.ts closes a lane's issue once its PR is among them). */
  mergedPulls(): readonly { readonly repo: string; readonly number: number; readonly url: string }[] {
    return Object.entries(this.state.repos).flatMap(([repo, state]) => Object.values(state.pulls)
      .filter((p) => p.state === "merged")
      .map((p) => ({ repo, number: p.number, url: p.url })));
  }

  /** Source progress only reaches disk after every event it produced is in the durable queue. */
  private commit(next: State): void {
    const prev = this.state;
    this.state = next;
    if (this.store) { saveGithub(this.store.database, prev, next); return; }
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, this.path);
    const dir = openSync(this.stateDir, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  async tick(deps: FlowDeps, emit: Emit): Promise<void> {
    const targets = await githubTargets(await deps.registry.open(), deps.run);
    // Re-read on every tick: machine repos can change without restarting supervise.
    for (const repo of new Repos(this.stateDir).list()) if (!targets.has(repo)) targets.set(repo, { numbers: new Set(), branches: new Set() });
    await Promise.all([...targets].map(async ([repo, lanes]) => {
      try {
        const old = this.state.repos[repo];
        const api = new Api(deps.run, old?.cache ?? {}, deps.config.githubTimeoutMs, deps.clock.now());
        const self = text(object((await api.get("user")).body).login).toLowerCase();
        const owner = repo.split("/")[0];
        const pulls: Record<string, Pull> = { ...old?.pulls };
        const rows = await api.pages(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`);
        for (const row of rows) {
          const summary = object(row);
          const number = summary.number;
          if (typeof number !== "number" || !Number.isInteger(number)) throw new GitHubError("invalid PR number");
          const prior = old?.pulls[number];
          // Closed history is baselined cheaply; continue following previously open PRs through closure.
          const inspect = summary.state === "open" || prior?.state === "open" || Boolean(old && (!prior || prior.updated !== summary.updated_at));
          const detail = inspect ? object((await api.get(`repos/${repo}/pulls/${number}`)).body) : summary;
          const head = object(detail.head);
          const sha = text(head.sha);
          const state = detail.merged_at ? "merged" : text(detail.state);
          let checks: Pull["checks"] = prior?.checks ?? "none";
          const activity: string[] = [];
          const events: { kind: string; detail: string; identity: string }[] = [];
          if (inspect) {
            if (state === "open" || prior?.state === "open") {
              const runs = await api.pages(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, "check_runs");
              const statuses = object((await api.get(`repos/${repo}/commits/${sha}/status?per_page=100`)).body);
              checks = checkState(runs, statuses);
            }
            for (const [kind, endpoint] of [
              ["review", `pulls/${number}/reviews`],
              ["comment", `issues/${number}/comments`],
              ["comment", `pulls/${number}/comments`],
            ] as const) {
              for (const entry of await api.pages(`repos/${repo}/${endpoint}?per_page=100`)) {
                const item = object(entry);
                const actor = object(item.user);
                const login = text(actor.login).toLowerCase();
                // Pending reviews are not published activity; bots and the authenticated owner's automation stay quiet.
                if ((kind === "review" && !item.submitted_at) || actor.type === "Bot" || login.endsWith("[bot]") || login === self || login === owner) continue;
                const id = `${endpoint}:${item.id}:${text(item.updated_at) || text(item.submitted_at)}:${text(item.state)}`;
                activity.push(id);
                const timestamp = text(item.updated_at) || text(item.submitted_at) || text(item.created_at);
                // Closed history is hydrated only on change. Do not replay old comments
                // when a previously closed PR receives its first newly observed reply.
                const historical = prior?.state !== "open" && prior?.activity.length === 0 && timestamp <= prior.updated;
                if (old && !historical && !prior?.activity.includes(id)) events.push({ kind, detail: `by=${login}`, identity: id });
              }
            }
          } else activity.push(...(prior?.activity ?? []));
          const current: Pull = {
            number, state, sha, branch: text(head.ref), updated: text(detail.updated_at),
            url: text(detail.html_url), conflicting: detail.mergeable === false || detail.mergeable_state === "dirty", checks, activity,
          };
          const lane = lanes.numbers.has(number) || lanes.branches.has(current.branch);
          if (old && !prior) {
            events.push({ kind: "opened", detail: `sha=${sha}`, identity: "opened" });
            if (state === "merged" || state === "closed") events.push({ kind: state, detail: `sha=${sha}`, identity: `${state}:${current.updated}` });
          }
          if (prior) {
            if (state !== prior.state && (state === "merged" || state === "closed")) events.push({ kind: state, detail: `sha=${sha}`, identity: `${state}:${current.updated}` });
            if (current.conflicting && !prior.conflicting) events.push({ kind: "conflicting", detail: `sha=${sha}`, identity: `${sha}:${current.updated}:conflicting` });
            if (checks !== prior.checks && (checks === "green" || checks === "failing")) events.push({ kind: checks === "green" ? "checks_green" : lane ? "checks_failing" : "checks_update", detail: `sha=${sha}`, identity: `${sha}:${checks}:${createHash("sha256").update(JSON.stringify(runsIdentity(api.cache, sha))).digest("hex").slice(0, 16)}` });
            if (current.updated !== prior.updated || sha !== prior.sha) events.push({ kind: "updated", detail: `sha=${sha}`, identity: `${sha}:${current.updated}` });
          }
          for (const event of events) emit(`github:${repo}#${number}:${event.identity}`, `GH_PR ${repo}#${number} ${event.kind} ${event.detail} ${current.url}`);
          pulls[number] = current;
        }
        const issues = await this.issues(api, repo, old?.issues, deps.config.githubIssueAuthors, emit);
        // Only commit source progress after every durable enqueue has succeeded.
        // A successful poll also clears this repo's earlier failure marker in the same commit.
        const { [repo]: _recovered, ...failures } = this.state.failures;
        const cache = retainHistory(pulls, api.cache, deps.clock.now());
        this.commit({ ...this.state, failures: repo in this.state.failures ? failures : this.state.failures, repos: { ...this.state.repos, [repo]: { cache, pulls, issues } } });
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        const now = deps.clock.now();
        const last = this.state.failures[repo];
        if (last === undefined || now - last >= 15 * 60_000) {
          emit(`github-error:${repo}:${now}`, `HOST_GITHUB ${repo} poll_failed ${e instanceof GitHubError ? e.message : e.name}`);
          this.commit({ ...this.state, failures: { ...this.state.failures, [repo]: now } });
        }
      }
    }));
    this.commit({ ...this.state, polledAt: deps.clock.now() });
  }

  /**
   * Issue titles and bodies are untrusted text: event lines carry only number, author login and URL.
   * Only configured authors produce an urgent GH_ISSUE; others are a digest GH_ISSUE_UNTRUSTED line.
   */
  private async issues(api: Api, repo: string, old: RepoState["issues"], authors: readonly string[], emit: Emit): Promise<Record<string, Issue>> {
    const trusted = new Set(authors.map((a) => a.toLowerCase()));
    const issues: Record<string, Issue> = { ...old };
    for (const row of await api.pages(`repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100`)) {
      const item = object(row);
      // The issues API lists pull requests too; those are followed by the PR poll.
      if (item.pull_request !== undefined) continue;
      const number = item.number;
      if (typeof number !== "number" || !Number.isInteger(number)) throw new GitHubError("invalid issue number");
      const state = text(item.state);
      const prior = issues[number];
      let reopens = prior?.reopens ?? 0;
      let kind: "opened" | "reopened" | undefined;
      if (old && !prior && state === "open") kind = "opened";
      if (prior && prior.state !== "open" && state === "open") { reopens++; kind = "reopened"; }
      if (kind) {
        const user = item.user === null || item.user === undefined ? {} : object(item.user);
        const login = text(user.login).toLowerCase().replace(/[^a-z0-9.[\]_-]/g, "") || "unknown";
        // The reopen count keeps a replay after a crash before save on the same identity.
        const id = `github-issue:${repo}#${number}:${kind === "opened" ? "opened" : `reopened:${reopens}`}`;
        emit(id, `${trusted.has(login) ? "GH_ISSUE" : "GH_ISSUE_UNTRUSTED"} ${repo}#${number} ${kind} author=${login} ${text(item.html_url)}`);
      }
      issues[number] = { state, reopens };
    }
    return issues;
  }
}

/** Read-only view of the poll state; unlike GitHubEvents it never creates the state directory. */
export const githubSummary = (stateDir: string): {
  readonly polledAt?: number;
  readonly failures: Readonly<Record<string, number>>;
  /** Repos whose issues have a recorded baseline. */
  readonly issueRepos: readonly string[];
} => {
  try {
    const file = join(stateDir, GITHUB_FILE);
    let s: Partial<State>;
    if (existsSync(file) || !existsSync(join(stateDir, SQLITE_FILE))) s = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    else {
      const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
      try { s = loadGithub(db, false); } finally { db.close(); }
    }
    return {
      ...(typeof s.polledAt === "number" ? { polledAt: s.polledAt } : {}),
      failures: s.failures ?? {},
      issueRepos: Object.entries(s.repos ?? {}).filter(([, r]) => r.issues !== undefined).map(([repo]) => repo).sort(),
    };
  } catch {
    return { failures: {}, issueRepos: [] };
  }
};

type Row = Record<string, string | number | null>;
const POLLED_AT = "github_polled_at";

/** The poll state from the store's gh_* tables; without `full` only repos, failures and the poll time (dori status). */
export const loadGithub = (db: Database, full = true): State => {
  const repos: Record<string, { cache: Record<string, Cached>; pulls: Record<string, Pull>; issues?: Record<string, Issue> }> = {};
  const failures: Record<string, number> = {};
  for (const row of db.query("SELECT * FROM gh_repos ORDER BY repo").all() as Row[]) {
    const repo = String(row.repo);
    if (row.polled) repos[repo] = { cache: {}, pulls: {}, ...(row.issues ? { issues: {} } : {}) };
    if (row.failed_at !== null) failures[repo] = Number(row.failed_at);
  }
  if (full) {
    for (const row of db.query("SELECT * FROM gh_prs").all() as Row[]) {
      const repo = repos[String(row.repo)];
      if (!repo) continue;
      repo.pulls[String(row.number)] = {
        number: Number(row.number), state: String(row.state), sha: String(row.sha), branch: String(row.branch), updated: String(row.updated),
        url: String(row.url), conflicting: row.conflicting === 1, checks: String(row.checks) as Pull["checks"], activity: JSON.parse(String(row.activity)) as string[],
      };
    }
    for (const row of db.query("SELECT * FROM gh_issues").all() as Row[]) {
      const issues = repos[String(row.repo)]?.issues;
      if (issues) issues[String(row.number)] = { state: String(row.state), reopens: Number(row.reopens) };
    }
    for (const row of db.query("SELECT * FROM gh_cache").all() as Row[]) {
      const repo = repos[String(row.repo)];
      if (!repo) continue;
      repo.cache[String(row.path)] = {
        ...(row.etag !== null ? { etag: String(row.etag) } : {}), body: JSON.parse(String(row.body)),
        ...(row.next !== null ? { next: String(row.next) } : {}), ...(row.used_at !== null ? { usedAt: Number(row.used_at) } : {}),
      };
    }
  }
  const polledAt = (db.query("SELECT value FROM meta WHERE key = ?").get(POLLED_AT) as { value: string } | null)?.value;
  return { repos, failures, ...(polledAt !== undefined ? { polledAt: Number(polledAt) } : {}) };
};

const samePull = (a: Pull | undefined, b: Pull): boolean => a !== undefined && a.state === b.state && a.sha === b.sha && a.branch === b.branch &&
  a.updated === b.updated && a.url === b.url && a.conflicting === b.conflicting && a.checks === b.checks &&
  a.activity.length === b.activity.length && a.activity.every((id, i) => id === b.activity[i]);

/** Writes only what differs between two poll states, in one transaction: a 304 tick writes almost nothing. */
const saveGithub = (db: Database, prev: State, next: State): void => {
  const repoRow = db.prepare(`INSERT INTO gh_repos (repo, polled, issues) VALUES (?, 1, ?)
    ON CONFLICT (repo) DO UPDATE SET polled = 1, issues = excluded.issues`);
  const failed = db.prepare(`INSERT INTO gh_repos (repo, failed_at) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET failed_at = excluded.failed_at`);
  const pull = db.prepare(`INSERT OR REPLACE INTO gh_prs (repo, number, state, sha, branch, updated, url, conflicting, checks, activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const issue = db.prepare("INSERT OR REPLACE INTO gh_issues (repo, number, state, reopens) VALUES (?, ?, ?, ?)");
  const cached = db.prepare("INSERT OR REPLACE INTO gh_cache (repo, path, etag, body, next, used_at) VALUES (?, ?, ?, ?, ?, ?)");
  const uncache = db.prepare("DELETE FROM gh_cache WHERE repo = ? AND path = ?");
  db.transaction(() => {
    for (const [repo, state] of Object.entries(next.repos)) {
      const old = prev.repos[repo];
      if (old === state) continue;
      if (!old || (old.issues === undefined) !== (state.issues === undefined)) repoRow.run(repo, state.issues ? 1 : 0);
      for (const [number, p] of Object.entries(state.pulls)) {
        if (!samePull(old?.pulls[number], p)) pull.run(repo, p.number, p.state, p.sha, p.branch, p.updated, p.url, p.conflicting ? 1 : 0, p.checks, JSON.stringify(p.activity));
      }
      for (const [number, i] of Object.entries(state.issues ?? {})) {
        const was = old?.issues?.[number];
        if (was?.state !== i.state || was.reopens !== i.reopens) issue.run(repo, Number(number), i.state, i.reopens);
      }
      for (const [path, entry] of Object.entries(state.cache)) {
        if (old?.cache[path] !== entry) cached.run(repo, path, entry.etag ?? null, JSON.stringify(entry.body), entry.next ?? null, entry.usedAt ?? null);
      }
      for (const path of Object.keys(old?.cache ?? {})) if (!(path in state.cache)) uncache.run(repo, path);
    }
    if (prev.failures !== next.failures) {
      for (const [repo, at] of Object.entries(next.failures)) if (prev.failures[repo] !== at) failed.run(repo, at);
      for (const repo of Object.keys(prev.failures)) if (!(repo in next.failures)) failed.run(repo, null);
    }
    if (prev.polledAt !== next.polledAt && next.polledAt !== undefined) {
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(POLLED_AT, String(next.polledAt));
    }
  })();
};

/**
 * Moves github-events.json into the store's gh_* tables (caller holds the supervisor lock): cached bodies are slimmed
 * and stamped as used now, and the read-back must equal that state or nothing is kept. retireGithubFile then keeps the
 * file read-only as github-events.json.pre-sqlite; a crash before that imports it again, replacing the rows.
 */
export const importGithub = (db: Database, stateDir: string, now: number): { readonly repos: number; readonly prs: number; readonly cache: number } => {
  const path = join(stateDir, GITHUB_FILE);
  const source = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
  if (typeof source !== "object" || source === null || typeof source.repos !== "object" || source.repos === null) {
    throw new StoreError(`STORE_IMPORT_MALFORMED ${path} has no repos object`);
  }
  const repos = Object.fromEntries(Object.entries(source.repos).map(([repo, state]): [string, RepoState] => [repo, {
    ...state,
    cache: Object.fromEntries(Object.entries(state.cache ?? {}).map(([key, entry]) => [key, {
      ...(entry.etag !== undefined ? { etag: entry.etag } : {}), body: slimBody(entry.body), ...(entry.next !== undefined ? { next: entry.next } : {}),
      usedAt: entry.usedAt ?? now,
    }])),
    pulls: state.pulls ?? {},
  }]));
  const target: State = { repos, failures: source.failures ?? {}, ...(typeof source.polledAt === "number" ? { polledAt: source.polledAt } : {}) };
  let prs = 0;
  let cache = 0;
  db.transaction(() => {
    for (const table of ["gh_repos", "gh_prs", "gh_issues", "gh_cache"]) db.exec(`DELETE FROM ${table}`);
    db.query("DELETE FROM meta WHERE key = ?").run(POLLED_AT);
    saveGithub(db, EMPTY, target);
    const back = loadGithub(db);
    if (!Bun.deepEquals(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(target)))) {
      throw new StoreError(`STORE_IMPORT_MISMATCH the imported GitHub state differs from ${path}; nothing imported`);
    }
    for (const state of Object.values(back.repos)) { prs += Object.keys(state.pulls).length; cache += Object.keys(state.cache).length; }
  })();
  return { repos: Object.keys(repos).length, prs, cache };
};

/** After its import reached the store: github-events.json is kept read-only for audit, and no longer read. */
export const retireGithubFile = (stateDir: string): void => {
  const path = join(stateDir, GITHUB_FILE);
  const pre = join(stateDir, PRE_SQLITE_GITHUB_FILE);
  renameSync(path, pre);
  chmodSync(pre, 0o400);
  const dir = openSync(stateDir, "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

const runsIdentity = (cache: Readonly<Record<string, Cached>>, sha: string): readonly string[] =>
  Object.entries(cache).filter(([path]) => path.includes(`/commits/${sha}/`)).map(([, entry]) => entry.etag ?? JSON.stringify(entry.body));
