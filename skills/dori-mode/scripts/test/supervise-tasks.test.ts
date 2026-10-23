import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import { gatewayStatusPath } from "../src/gateway-status.ts";
import type { Http } from "../src/messenger/http.ts";
import { Repos } from "../src/repos.ts";
import type { Ran } from "../src/run.ts";
import { supervise, SUPERVISOR_TASKS, type SupervisorTask, TASK_ALERT_MS, WATCHDOG_STALL_MS } from "../src/supervise-loop.ts";
import { Supervisor } from "../src/supervise.ts";
import { Waits } from "../src/waits.ts";
import { depsFor, fakeClock, manualPause, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const T0 = 1_800_000_000_000;
const DF = "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200";
const OWNER = "123456789012345";
const MESSAGE = "1900000000000000001";
const REPORT = "LANE_REPORT demo-lane journaled before the supervisor started";

/** Resolves once `check` holds, re-checked on each `subscribe` signal; rejects after `ms`. */
const until = (subscribe: (signal: () => void) => () => void, check: () => boolean, ms: number, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out after ${ms} ms waiting for ${what}`)); }, ms);
    const signal = () => { if (check()) { clearTimeout(timer); stop(); resolve(); } };
    stop = subscribe(signal);
    signal();
  });

/**
 * The real supervise(), where the work of `stalled` hangs until the test ends: the inbound Discord
 * catch-up, the delivery task's owner delay notice, the guard sweep's df, or the GitHub poll's gh api call (a wait check
 * has its own 10 s budget, so it cannot hold the polling task).
 */
const setup = (stalled: SupervisorTask) => {
  const state = withState();
  cleanups.push(state.done);
  const home = process.env.HOME;
  const socket = process.env.NOTIFY_SOCKET;
  process.env.HOME = state.dir;
  delete process.env.NOTIFY_SOCKET;
  cleanups.push(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (socket === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = socket;
  });
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); changed(); };
  cleanups.push(() => { console.error = error; });
  // Every hung call resolves at the end of the test, and nothing hangs from then on, so shutdown can finish.
  const hung: (() => void)[] = [];
  let stopping = false;
  const hang = <T>(value: T): Promise<T> => stopping ? Promise.resolve(value) : new Promise<T>((resolve) => {
    hung.push(() => { resolve(value); });
    changed();
  });
  const release = () => {
    stopping = true;
    for (const resolve of hung.splice(0)) resolve();
  };
  cleanups.push(release);
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, clock, state.dir, {
    discord: { applicationId: "100", guildId: "200", ownerId: OWNER }, discordChannels: ["11"], defaultModel: "test/model",
  });
  // Outbound Discord posts are accepted; with the delivery task stalled, its owner delay notice never returns.
  const posts: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    posts.push(body);
    changed();
    const ok = new Response(JSON.stringify({ id: "33" }), { status: 200 });
    return stalled === "delivery" && body.includes(base.config.ownerDelayNotice) ? hang(ok) : ok;
  }, { preconnect: fetch.preconnect }));
  const done = { df: 0, gh: 0 };
  const deps = {
    ...base,
    run: async (argv: readonly string[]): Promise<Ran> => {
      if (argv[0] === "df") {
        const ran = { code: 0, out: DF, err: "" };
        if (stalled === "sweeps") return hang(ran);
        done.df++;
        changed();
        return ran;
      }
      if (argv[0] === "gh" && argv[1] === "api") return hang({ code: 1, out: "", err: "released at the end of the test" });
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
        const ran = await base.run(argv);
        done.gh++;
        changed();
        return ran;
      }
      return base.run(argv);
    },
  };
  // Journaled before the start: an urgent lane report for delivery, an owner message (overdue once the clock moves, so
  // the delivery task owes its delay notice), and a wait the polling task checks with gh.
  const seed = new Supervisor(base);
  seed.enqueue("seed:report", REPORT);
  if (stalled === "delivery") seed.enqueue(`discord:11:${MESSAGE}`, `INBOUND 11 ${MESSAGE} owner: status?`);
  seed.close();
  new Waits(state.dir).register({ key: "pr-1", until: "merged acme/app#1", note: "watch the PR", cwd: state.dir }, T0);
  // Only the stalled polling task has a repository to poll on GitHub.
  if (stalled === "polling") new Repos(state.dir).add("acme/app");
  clock.at += 120_000;
  const http: Http = async (request) => {
    const reply = request.url.endsWith("/threads/active")
      ? { status: 200, headers: {}, body: JSON.stringify({ threads: [] }) }
      : { status: 200, headers: {}, body: "[]" };
    return stalled === "inbound" ? hang(reply) : reply;
  };
  // Each loop's next pass waits for the test, not for real time.
  const pauses = manualPause();
  const pause = (ms: number, signal: AbortSignal) => { const parked = pauses.pause(ms, signal); changed(); return parked; };
  const controller = new AbortController();
  const running = supervise(deps, controller.signal, {
    token: `supervise-tasks-test-${state.dir}`, http, lookup: async () => "", statusLookup: async () => "",
    open: () => {
      let closed = (_code: number) => {};
      return {
        send: () => {}, close: () => { closed(1000); },
        onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; },
      };
    },
    timers: { setInterval: () => 0, clearInterval: () => {} },
  }, async () => true, undefined, pause);
  const log = join(state.dir, "lead-events.log");
  const working: Record<SupervisorTask, () => boolean> = {
    // The inbound pass ends with the gateway heartbeat.
    inbound: () => existsSync(gatewayStatusPath(state.dir)),
    delivery: () => existsSync(log) && readFileSync(log, "utf8").includes(REPORT),
    sweeps: () => done.df > 0,
    polling: () => done.gh > 0,
  };
  const subscribe = (signal: () => void) => {
    listeners.add(signal);
    const watcher = watch(state.dir, signal);
    return () => { listeners.delete(signal); watcher.close(); };
  };
  const stop = async () => { controller.abort(); release(); await running; };
  // Once the three working tasks and the stall check are parked, each takes its next pass.
  const next = async () => {
    await until(subscribe, () => pauses.parked() === 4, 10_000, "the three working tasks and the stall check parked");
    pauses.tick();
  };
  return { clock, errors, posts, hung, working, subscribe, stop, next };
};

const others = (stalled: SupervisorTask): SupervisorTask[] => SUPERVISOR_TASKS.filter((task) => task !== stalled);

const stallTest = (stalled: SupervisorTask, then?: (s: ReturnType<typeof setup>) => void) =>
  test(`a stalled ${stalled} task leaves the other three working and is reported by name, then withholds the watchdog`, async () => {
    // Given the real supervise() in task mode with the work of one task hung.
    const s = setup(stalled);
    try {
      await until(s.subscribe, () => s.hung.length > 0, 10_000, `the ${stalled} stall`);
      // When the other three run beside it, each finishes its work.
      for (const task of others(stalled)) await until(s.subscribe, s.working[task], 10_000, `the ${task} task working while ${stalled} is stalled`);
      // The wait check runs beside the hung GitHub poll in the same polling pass, so only the other three show no work.
      if (stalled !== "polling") expect(s.working[stalled]()).toBe(false);
      // Then the stalled task is reported by name once its pass has run past the alert budget.
      s.clock.at += TASK_ALERT_MS;
      await s.next();
      await until(s.subscribe, () => s.errors.some((line) => line.startsWith(`TASK_STALLED ${stalled} `)), 10_000, `TASK_STALLED ${stalled}`);
      then?.(s);
      // And once it is stuck past the stall budget, the watchdog is withheld in its name, so systemd restarts the supervisor.
      s.clock.at += WATCHDOG_STALL_MS;
      await s.next();
      await until(s.subscribe, () => s.errors.some((line) => line.startsWith(`WATCHDOG_WITHHELD task:${stalled} `)), 10_000, `WATCHDOG_WITHHELD task:${stalled}`);
    } finally {
      await s.stop();
    }
  }, 60_000);

stallTest("inbound");
// A stalled delivery task cannot hand TASK_STALLED to the lead, so the owner is told in the main channel.
stallTest("delivery", (s) => { expect(s.posts.some((body) => body.includes("TASK_STALLED delivery"))).toBe(true); });
stallTest("sweeps");
stallTest("polling");
