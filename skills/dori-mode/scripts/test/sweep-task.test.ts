import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import type { Http } from "../src/messenger/http.ts";
import { supervise, WATCHDOG_STALL_MS } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, manualPause, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const T0 = 1_800_000_000_000;
const STALL_MS = 120_000;
const DF = "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200";
const OWNER = "123456789012345";
const MESSAGE = "1900000000000000001";

/** Resolves once `check` holds, re-checked on each `subscribe` signal; rejects after `ms`. */
const until = (subscribe: (signal: () => void) => () => void, check: () => boolean, ms: number, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out after ${ms} ms waiting for ${what}`)); }, ms);
    const signal = () => { if (check()) { clearTimeout(timer); stop(); resolve(); } };
    stop = subscribe(signal);
    signal();
  });

const setup = () => {
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
  const errors: string[] = [];
  const errorListeners = new Set<() => void>();
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); for (const listener of errorListeners) listener(); };
  cleanups.push(() => { console.error = error; });
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  // Outbound Discord (reactions, owner notices, command registration) is accepted and otherwise irrelevant here.
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ id: "33" }), { status: 200 }), { preconnect: fetch.preconnect }));
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, clock, state.dir, {
    discord: { applicationId: "100", guildId: "200", ownerId: OWNER }, discordChannels: ["11"], defaultModel: "test/model",
  });
  // The guard sweep's disk sample (only that sweep runs df) hangs for STALL_MS: the injected sweep stall.
  const stall: { at?: number; release: () => void } = { release: () => {} };
  const stallListeners = new Set<() => void>();
  let ownerPosted = false;
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] !== "df") return base.run(argv);
      return new Promise<{ code: number; out: string; err: string }>((resolve) => {
        const timer = setTimeout(() => { stall.release(); }, STALL_MS);
        stall.release = () => { clearTimeout(timer); resolve({ code: 0, out: DF, err: "" }); };
        stall.at = performance.now();
        // The owner writes while the sweep is stuck; the REST catch-up is due again on the next pass.
        ownerPosted = true;
        clock.at += 6_000;
        for (const listener of stallListeners) listener();
      });
    },
  };
  cleanups.push(() => { stall.release(); });
  const http: Http = async (request) => {
    if (request.url.endsWith("/threads/active")) return { status: 200, headers: {}, body: JSON.stringify({ threads: [] }) };
    if (request.url.includes("/channels/11/messages") && ownerPosted) {
      return { status: 200, headers: {}, body: JSON.stringify([{ id: MESSAGE, channel_id: "11", author: { id: OWNER, username: "owner" }, content: "status?", attachments: [] }]) };
    }
    return { status: 200, headers: {}, body: "[]" };
  };
  const notified: string[] = [];
  // Each task's next pass waits for the test, not for real time.
  const pauses = manualPause();
  const parkListeners = new Set<() => void>();
  const pause = (ms: number, signal: AbortSignal) => { const parked = pauses.pause(ms, signal); for (const listener of parkListeners) listener(); return parked; };
  const controller = new AbortController();
  const running = supervise(deps, controller.signal, {
    token: `sweep-task-test-${state.dir}`, http, lookup: async () => "", statusLookup: async () => "",
    open: () => {
      let closed = (_code: number) => {};
      return {
        send: () => {}, close: () => { closed(1000); },
        onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; },
      };
    },
    timers: { setInterval: () => 0, clearInterval: () => {} },
  }, async (s) => { notified.push(s); return true; }, undefined, pause);
  const log = join(state.dir, "lead-events.log");
  const delivered = () => existsSync(log) && readFileSync(log, "utf8").split("\n").some((line) => line.includes(`"line":"INBOUND 11 ${MESSAGE} `));
  const onLog = (signal: () => void) => { const watcher = watch(state.dir, signal); return () => { watcher.close(); }; };
  const onError = (signal: () => void) => { errorListeners.add(signal); return () => { errorListeners.delete(signal); }; };
  const onStall = (signal: () => void) => { stallListeners.add(signal); return () => { stallListeners.delete(signal); }; };
  const onPark = (signal: () => void) => { parkListeners.add(signal); return () => { parkListeners.delete(signal); }; };
  // Once the three working tasks and the stall check are parked (the sweeps task is stuck), each takes its next pass.
  const next = async () => {
    await until(onPark, () => pauses.parked() === 4, 10_000, "the three working tasks and the stall check parked");
    pauses.tick();
  };
  const stop = async () => { controller.abort(); stall.release(); await running; };
  return { clock, errors, notified, stall, delivered, onLog, onError, onStall, stop, next };
};

test("an injected 120 s sweep stall still delivers an owner INBOUND to the lead in under 10 s, and the stuck sweep withholds the watchdog", async () => {
  // Given the real supervise() whose guard sweep hangs for 120 s, and an owner message posted once it hangs.
  const s = setup();
  try {
    await until(s.onStall, () => s.stall.at !== undefined, 10_000, "the sweep stall");
    // When the other tasks keep running beside the stuck sweep.
    await s.next();
    await until(s.onLog, s.delivered, 10_000, "INBOUND in lead-events.log");
    // Then the owner's INBOUND reached the lead's delivery log well before the stall ends.
    expect(performance.now() - (s.stall.at ?? 0)).toBeLessThan(10_000);
    // And once the sweep has been stuck past the stall budget, the watchdog names its task even though the others keep turning.
    s.clock.at += WATCHDOG_STALL_MS;
    const petted = s.notified.length;
    await s.next();
    await until(s.onError, () => s.errors.some((line) => line.startsWith("WATCHDOG_WITHHELD task:sweeps ")), 10_000, "WATCHDOG_WITHHELD task:sweeps");
    expect(s.notified.slice(petted)).not.toContain("WATCHDOG=1");
  } finally {
    await s.stop();
  }
}, 30_000);
