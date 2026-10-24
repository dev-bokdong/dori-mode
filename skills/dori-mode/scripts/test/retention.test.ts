import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GitHubEvents, PRE_SQLITE_GITHUB_FILE } from "../src/github-events.ts";
import { Repos } from "../src/repos.ts";
import type { Ran, Runner } from "../src/run.ts";
import { RETENTION, SCHEMA_VERSION, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { importStore } from "../src/store-import.ts";
import { ACK_KEEP_MS, Supervisor } from "../src/supervise.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A busy lead pane (every due event is appended to the log without a restart), a fake gh, and the sqlite store. */
const fixture = (gh?: Runner, root?: string) => {
  const state = withState(root);
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: world.panes } }), err: "" };
    if (argv[0] === "herdr" && argv[2] === "read") return { code: 0, out: "working", err: "" };
    if (argv[0] === "gh" && gh) return gh(argv, opts);
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = (store: "json" | "sqlite" = "sqlite") => ({ ...depsFor(world, clock, state.dir, { store }), run });
  const open = (store: "json" | "sqlite" = "sqlite") => {
    const supervisor = new Supervisor(deps(store));
    cleanups.unshift(() => supervisor.close());
    return supervisor;
  };
  const db = () => {
    const store = new SqliteStore(join(state.dir, SQLITE_FILE));
    cleanups.unshift(() => store.close());
    return store;
  };
  const logIds = (): string[] => readFileSync(join(state.dir, "lead-events.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).id);
  /** What `dori ack` and `dori handled --reply` leave for the supervisor (without their fsyncs, which only cost time here). */
  const receipt = (message: number, at: number, reply: boolean) => {
    mkdirSync(join(state.dir, "acks"), { recursive: true });
    writeFileSync(join(state.dir, "acks", `11-${message}.json`), JSON.stringify({ channel: "11", message: String(message), at, ...(reply ? { reply } : {}) }));
  };
  const acked = (message: number, at: number) => receipt(message, at, false);
  const handled = (message: number, at: number) => receipt(message, at, true);
  return { state, clock, deps, open, db, logIds, acked, handled };
};

test("a delivered event body leaves after 7 days for a tombstone that dedupes it until day 90; unresolved events stay", async () => {
  const f = fixture();
  const supervisor = f.open();
  // Given a delivered lane report, a delivered owner message the lead read but never handled, and a report it never got.
  supervisor.enqueue("report:a", "LANE_REPORT alpha milestone");
  supervisor.enqueue("discord:11:1", "INBOUND 11 1 owner hello");
  await supervisor.flush();
  f.acked(1, f.clock.now());
  supervisor.ackTick(60_000);
  supervisor.enqueue("report:b", "LANE_REPORT beta question");
  // When 7 days pass and the loop runs retention.
  f.clock.at += RETENTION.eventBodyMs + HOUR;
  supervisor.ackTick(60_000);
  // Then only the delivered, unneeded body is gone, leaving its tombstone; its delivery row goes with it.
  const store = f.db();
  const ids = store.read(false).events.map((event) => event.id);
  expect(ids).not.toContain("report:a");
  expect(ids).toEqual(expect.arrayContaining(["discord:11:1", "report:b"]));
  expect(store.tombstoned("report:a")).toBe(true);
  expect(store.deliveredIds().has("report:a")).toBe(false);
  store.close();
  // And a replay of its source, before and after a restart, adds nothing and delivers nothing twice.
  supervisor.enqueue("report:a", "LANE_REPORT alpha milestone");
  await supervisor.flush();
  supervisor.close();
  const after = f.open();
  after.enqueue("report:a", "LANE_REPORT alpha milestone");
  await after.flush();
  expect(f.logIds().filter((id) => id === "report:a")).toHaveLength(1);
  // And once its tombstone expires at day 90, the same id is a new event again.
  f.clock.at += RETENTION.tombstoneMs;
  after.ackTick(60_000);
  after.enqueue("report:a", "LANE_REPORT alpha again");
  expect(f.db().read(false).events.map((event) => event.line)).toContain("LANE_REPORT alpha again");
});

test("the json journal keeps every event body", async () => {
  const f = fixture();
  const supervisor = f.open("json");
  supervisor.enqueue("report:a", "LANE_REPORT alpha milestone");
  await supervisor.flush();
  f.clock.at += RETENTION.tombstoneMs + DAY;
  supervisor.ackTick(60_000);
  supervisor.close();
  expect(JSON.parse(readFileSync(join(f.state.dir, "supervisor.json"), "utf8")).events.map((event: { id: string }) => event.id)).toContain("report:a");
});

test("a handled owner message's tombstone outlives its body and expires at day 90", async () => {
  const f = fixture();
  const supervisor = f.open();
  // Given an owner message the lead handled.
  supervisor.enqueue("discord:11:5", "INBOUND 11 5 owner please");
  await supervisor.flush();
  f.handled(5, f.clock.now());
  supervisor.ackTick(60_000);
  // When its tracking is compacted after a day and its body pruned after 7.
  f.clock.at += ACK_KEEP_MS + HOUR;
  supervisor.ackTick(60_000);
  f.clock.at += RETENTION.eventBodyMs;
  supervisor.ackTick(60_000);
  // Then only the tombstones remain, and a replayed copy of the message is not tracked again.
  let journal = f.db().read(false);
  expect(journal.closedOwners).toEqual(["discord:11:5"]);
  expect(journal.events.map((event) => event.id)).not.toContain("discord:11:5");
  supervisor.enqueue("discord:11:5", "INBOUND 11 5 owner please");
  expect(f.db().read(false).awaitingAck).toEqual([]);
  // And at day 90 the owner tombstone expires too.
  f.clock.at += RETENTION.tombstoneMs;
  supervisor.ackTick(60_000);
  journal = f.db().read(false);
  expect(journal.closedOwners).toEqual([]);
});

test("a version 1 database migrates to the current version and keeps its journal", () => {
  const f = fixture();
  const path = join(f.state.dir, SQLITE_FILE);
  // Given a database written by the version 1 code (no tombstone or GitHub tables).
  const v1 = new SqliteStore(path, { create: true });
  v1.save({ events: [{ id: "report:a", line: "LANE_REPORT alpha", at: T0 }] }, "full");
  v1.close();
  const raw = new Database(path);
  raw.exec("DROP TABLE event_tombstones; DROP TABLE gh_repos; DROP TABLE gh_prs; DROP TABLE gh_issues; DROP TABLE gh_cache; DROP TABLE lead_wakes");
  raw.query("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  raw.close();
  // When the current code opens it.
  const store = f.db();
  // Then it is at the current version with every table, and the journal is unchanged.
  expect(SCHEMA_VERSION).toBe(5);
  expect(store.meta("schema_version")).toBe("5");
  expect(Object.keys(store.counts())).toEqual(expect.arrayContaining(["event_tombstones", "gh_repos", "gh_prs", "gh_issues", "gh_cache", "lead_wakes"]));
  expect(store.read(false).events).toEqual([{ id: "report:a", line: "LANE_REPORT alpha", at: T0 }]);
});

test("dori store import also moves github-events.json into the database", () => {
  const f = fixture();
  // Given a state dir with both json files.
  writeFileSync(join(f.state.dir, "supervisor.json"), JSON.stringify({ events: [] }));
  const github = {
    repos: { "acme/app": {
      cache: { user: { etag: '"u"', body: { login: "owner", bio: "x".repeat(500) } } },
      pulls: { 7: { number: 7, state: "merged", sha: "abc", branch: "lane", updated: "2026-10-20T00:00:00Z", url: "https://github.com/acme/app/pull/7", conflicting: false, checks: "green", activity: ["issues/7/comments:1::"] } },
      issues: { 3: { state: "open", reopens: 1 } },
    } },
    failures: {}, polledAt: T0,
  };
  writeFileSync(join(f.state.dir, "github-events.json"), JSON.stringify(github));
  // When it is imported.
  const report = importStore(f.state.dir, T0 + 1);
  // Then the GitHub rows are in the database and the file is kept read-only beside it.
  expect(report.counts).toMatchObject({ gh_repos: 1, gh_prs: 1, gh_issues: 1, gh_cache: 1 });
  expect(existsSync(join(f.state.dir, "github-events.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.state.dir, PRE_SQLITE_GITHUB_FILE), "utf8"))).toEqual(github);
  const poller = new GitHubEvents(f.state.dir, "sqlite", f.clock.now);
  cleanups.unshift(() => poller.close());
  const db = new Database(join(f.state.dir, SQLITE_FILE), { readonly: true });
  expect(db.query("SELECT body, used_at FROM gh_cache").get()).toEqual({ body: JSON.stringify({ login: "owner" }), used_at: T0 + 1 });
  expect(db.query("SELECT activity FROM gh_prs").get()).toEqual({ activity: JSON.stringify(["issues/7/comments:1::"]) });
  db.close();
});

/**
 * A GitHub API at 10x today's PR rate: every repo opens `perTick` PRs per poll, which go green on the next poll and
 * merge on the one after. Response bodies carry padding like the real ones (the store keeps only the read fields).
 */
const fakeGitHub = (repos: readonly string[], perTick: number) => {
  type Pr = { number: number; state: "open" | "merged"; checks: "pending" | "green"; updated: string; version: number };
  const prs = new Map<string, Pr[]>(repos.map((repo) => [repo, []]));
  const version = new Map<string, number>(repos.map((repo) => [repo, 0]));
  const pad = "x".repeat(100);
  const ok = (body: unknown, etag: string, next?: string): Ran => ({
    code: 0, err: "", out: `HTTP/2.0 200 OK\r\nETag: ${etag}\r\n${next ? `Link: <https://api.github.com/${next}>; rel="next"\r\n` : ""}\r\n${JSON.stringify(body)}`,
  });
  const notModified: Ran = { code: 0, err: "", out: "HTTP/2.0 304 Not Modified" };
  const pull = (repo: string, p: Pr) => ({
    number: p.number, state: p.state === "merged" ? "closed" : "open", merged_at: p.state === "merged" ? p.updated : null,
    head: { sha: `sha${p.number}`, ref: `lane-${p.number}`, repo: { full_name: repo, description: pad } }, updated_at: p.updated,
    html_url: `https://github.com/${repo}/pull/${p.number}`, mergeable: true, body: pad, user: { login: "lane-author", type: "User" },
  });
  const advance = (now: number) => {
    const updated = new Date(now).toISOString();
    for (const repo of repos) {
      const list = prs.get(repo) as Pr[];
      for (const p of list) {
        if (p.state !== "open") continue;
        if (p.checks === "pending") Object.assign(p, { checks: "green", updated, version: p.version + 1 });
        else Object.assign(p, { state: "merged", updated, version: p.version + 1 });
      }
      for (let i = 0; i < perTick; i++) list.push({ number: list.length + 1, state: "open", checks: "pending", updated, version: 0 });
      list.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : b.number - a.number));
      version.set(repo, (version.get(repo) ?? 0) + 1);
    }
  };
  const run: Runner = async (argv) => {
    const path = argv[5] ?? "";
    const seen = argv.find((arg) => arg.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length);
    const reply = (etag: string, body: () => unknown, next?: string): Ran => (seen === etag ? notModified : ok(body(), etag, next));
    if (path === "user") return reply('"user"', () => ({ login: "owner", bio: pad }));
    const repo = repos.find((name) => path.startsWith(`repos/${name}/`));
    if (!repo) throw new Error(`unexpected API path ${path}`);
    const rest = path.slice(`repos/${repo}/`.length);
    const list = prs.get(repo) as Pr[];
    const page = /^pulls\?state=all&sort=updated&direction=desc&per_page=100(?:&page=(\d+))?$/.exec(rest);
    if (page) {
      const n = Number(page[1] ?? 1);
      const next = n * 100 < list.length ? `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${n + 1}` : undefined;
      return reply(`"${version.get(repo)}:${n}"`, () => list.slice((n - 1) * 100, n * 100).map((p) => pull(repo, p)), next);
    }
    if (rest.startsWith("issues?")) return reply('"issues"', () => []);
    const detail = /^pulls\/(\d+)$/.exec(rest);
    const at = (n: string) => list.find((p) => p.number === Number(n)) as Pr;
    if (detail) { const p = at(detail[1] as string); return reply(`"pr${p.number}:${p.version}"`, () => pull(repo, p)); }
    const checks = /^commits\/sha(\d+)\/check-runs/.exec(rest);
    if (checks) {
      const p = at(checks[1] as string);
      return reply(`"runs${p.number}:${p.checks}"`, () => ({ total_count: 1, check_runs: [{ id: p.number, status: p.checks === "green" ? "completed" : "in_progress", conclusion: p.checks === "green" ? "success" : null, output: { summary: pad } }] }));
    }
    if (/^commits\/sha\d+\/status/.test(rest)) return reply('"status"', () => ({ state: "success", statuses: [] }));
    if (/^(pulls|issues)\/\d+\/(reviews|comments)/.test(rest)) return reply('"empty"', () => []);
    throw new Error(`unexpected API path ${path}`);
  };
  return { run, advance };
};

test("30 days at 10x today's rate: database under 200 MB, startup under 2 s, a replayed source window adds nothing", async () => {
  // Appendix A: 2,862 journal events in 55.4 h, about 1,240 a day; 10x is about 12,400 a day, 517 an hour. Owner messages
  // are about 140 a day (10x: 58 an hour, each handled within the hour), GitHub about 29 PRs a day (10x: 288, polled
  // every 6 h here), the rest lane and sweep lines.
  const repos = ["acme/app", "acme/api", "acme/web", "acme/infra", "acme/docs", "acme/mobile"];
  const gh = fakeGitHub(repos, 12);
  // In memory where the host has it: 30 days of per-line log fsyncs measure the disk, not the store (store.test.ts
  // benchmarks enqueue durability).
  const f = fixture(gh.run, existsSync("/dev/shm") ? "/dev/shm" : undefined);
  for (const repo of repos) new Repos(f.state.dir).add(repo);
  const deps = f.deps();
  let supervisor = new Supervisor(deps);
  let github = new GitHubEvents(f.state.dir, "sqlite", f.clock.now);
  cleanups.unshift(() => { supervisor.close(); github.close(); });
  const ids: string[] = [];
  const enqueue = (id: string, line: string) => { ids.push(id); supervisor.enqueue(id, line); };
  // One owner message is read but never handled: unresolved work is kept however old it gets.
  enqueue("discord:11:1", "INBOUND 11 1 owner request that nobody has handled yet");
  f.acked(1, f.clock.now());
  let message = 1;
  const started = performance.now();
  for (let hour = 0; hour < 30 * 24; hour++) {
    f.clock.at = T0 + hour * HOUR;
    const owners: number[] = [];
    for (let i = 0; i < 58; i++) {
      owners.push(++message);
      enqueue(`discord:11:${message}`, `INBOUND 11 ${message} owner message ${message}: please check the lane and report back when it is done`);
    }
    if (hour % 6 === 0) {
      gh.advance(f.clock.now());
      await github.tick(deps, enqueue);
    }
    const sweep = 517 - 58 - (hour % 6 === 0 ? 300 : 0);
    for (let i = 0; i < sweep; i++) {
      enqueue(`progress:lane-${i % 100}:${hour}:${i}`, `PROGRESS lane-${i % 100} working: ran the tests, 3 files changed, next step is the PR (hour ${hour})`);
    }
    for (const owner of owners) f.handled(owner, f.clock.now());
    supervisor.ackTick(60_000);
    await supervisor.flush();
  }
  const loadMs = performance.now() - started;
  supervisor.close();
  github.close();
  const path = join(f.state.dir, SQLITE_FILE);
  const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);
  const bytes = size(path) + size(`${path}-wal`);
  const counts = f.db().counts();
  console.log(`RETENTION_LOAD ${ids.length} events in ${Math.round(loadMs)} ms; database ${(bytes / 1e6).toFixed(1)} MB; ${JSON.stringify(counts)}`);
  // Then the database stays under 200 MB, with bodies for about 7 days and tombstones for the rest.
  expect(ids.length).toBeGreaterThan(30 * 12_000);
  expect(bytes).toBeLessThan(200_000_000);
  expect(counts.events).toBeLessThan(8 * 12_400);
  expect(counts.event_tombstones).toBeGreaterThan(22 * 12_000);
  expect(counts.gh_prs).toBe(30 * 4 * repos.length * 12);
  // And a restart (supervisor and poller) takes under 2 s.
  const restart = performance.now();
  supervisor = new Supervisor(deps);
  github = new GitHubEvents(f.state.dir, "sqlite", f.clock.now);
  const startupMs = performance.now() - restart;
  console.log(`RETENTION_STARTUP ${Math.round(startupMs)} ms`);
  expect(startupMs).toBeLessThan(2_000);
  // And the unresolved owner message is still tracked with its body.
  const journal = f.db().read(false);
  expect(journal.events[0]?.id).toBe("discord:11:1");
  expect(journal.awaitingAck?.find((entry) => entry.id === "discord:11:1")?.handledAt).toBeUndefined();
  expect(journal.events[1]?.at).toBeGreaterThanOrEqual(f.clock.now() - RETENTION.eventBodyMs - HOUR);
  // And replaying the whole 30-day source window (every id, and one more poll) adds no event and delivers nothing.
  const delivered = f.logIds().length;
  for (const id of ids) supervisor.enqueue(id, "REPLAYED");
  await github.tick(deps, (id, line) => supervisor.enqueue(id, line));
  await supervisor.flush();
  expect(f.db().counts().events).toBe(counts.events);
  expect(f.logIds()).toHaveLength(delivered);
}, 600_000);
