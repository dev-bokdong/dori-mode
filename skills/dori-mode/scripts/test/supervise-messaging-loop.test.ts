import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import type { Http } from "../src/messenger/http.ts";
import type { OwnerNoticeKind } from "../src/supervise.ts";
import { sdNotify, supervise } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState, readJournal, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const id = "discord:11:22";
type Notification = { readonly attempts: number; readonly sent?: true };
type JournalView = {
  readonly events: readonly { readonly id: string; readonly line: string }[];
  readonly notifications?: Readonly<Record<string, Notification>>;
};

const fixture = (kind: OwnerNoticeKind, reminded = true) => {
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
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, fakeClock(T0), state.dir, {
    discord: { applicationId: "100", guildId: "200", ownerId: "123456789012345" },
    discordChannels: ["11"], defaultModel: "test/model",
    ownerDelayNotice: "delay-notice", ackMissingNotice: "ack-notice", unhandledNotice: "unhandled-notice",
  });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => argv[0] === "df"
      ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
      : base.run(argv),
  };
  const event = { id, line: "INBOUND 11 22 owner alpha", at: T0 - 60 * MINUTE };
  const tracking = {
    id,
    ...(kind === "delay" ? {} : { since: T0 - 60 * MINUTE }),
    ...(kind === "ack" ? { reminded: true } : {}),
    ...(kind === "unhandled" ? {
      ackedAt: T0 - 30 * MINUTE,
      ...(reminded ? { unhandledRemindedAt: T0 - 30 * MINUTE } : {}),
    } : {}),
  };
  writeJournal(state.dir, ({ events: [event], awaitingAck: [tracking] }));
  writeFileSync(join(state.dir, "lead-events.log"), kind === "delay" ? "" : `${JSON.stringify(event)}\n`);
  const journal = (): JournalView => readJournal(state.dir);
  const posts: { content: string; notification?: Notification }[] = [];
  const notified: string[] = [];
  // Only the unrelated external quota lookup is replaced; supervisor state and notification transport remain real.
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  const tick = async (success: boolean, stopOnInbound = false): Promise<void> => {
    const controller = new AbortController();
    const http: Http = async (request) => {
      if (request.url.endsWith("/threads/active")) {
        if (stopOnInbound) controller.abort();
        return { status: 200, headers: {}, body: JSON.stringify({ threads: [] }) };
      }
      return { status: 200, headers: {}, body: "[]" };
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (options?.method !== "POST" || !url.endsWith("/channels/11/messages")) throw new Error(`unexpected fetch ${url}`);
      if (typeof options.body !== "string") throw new Error("expected a JSON notification body");
      const body: { content: string } = JSON.parse(options.body);
      posts.push({ content: body.content, notification: journal().notifications?.[`${kind}:${id}`] });
      // Exact send-attempt event ends this pass: no sleeps, polling, real gateway or provider requests.
      controller.abort();
      return new Response(JSON.stringify(success ? { id: "33" } : { message: "Forbidden" }), { status: success ? 200 : 403 });
    }, { preconnect: fetch.preconnect }));
    try {
      await supervise(deps, controller.signal, {
        token: `loop-test-${state.dir}`, http, lookup: async () => "", statusLookup: async () => "",
        open: () => {
          let closed = (_code: number) => {};
          return {
            send: () => {}, close: () => { closed(1000); },
            onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; },
          };
        },
        timers: { setInterval: () => 0, clearInterval: () => {} },
      }, async (state) => { notified.push(state); return true; });
    } finally {
      fetchSpy.mockRestore();
    }
  };
  return { journal, posts, tick, notified };
};

test.each(["delay", "ack", "unhandled"] as const)("the production loop retries a failed %s notice and records only confirmed success", async (kind) => {
  // Given a real durable owner record due for this kind of notification.
  const f = fixture(kind);
  // When the actual loop gets a rejected send, then succeeds after a supervisor restart.
  await f.tick(false);
  expect(f.journal().notifications?.[`${kind}:${id}`]).toEqual({ attempts: 1 });
  await f.tick(true);
  // Then both requests used the configured notice and success was absent until Discord accepted the second.
  expect(f.posts).toEqual([
    { content: `${kind}-notice`, notification: { attempts: 1 } },
    { content: `${kind}-notice`, notification: { attempts: 2 } },
  ]);
  expect(f.journal().notifications?.[`${kind}:${id}`]).toEqual({ attempts: 2, sent: true });
  // A further complete loop pass must not send again after its success marker is loaded.
  await f.tick(true, true);
  expect(f.posts).toHaveLength(2);
});

test("the production loop runs handledTick and journals UNHANDLED before an owner notice is due", async () => {
  // Given an acknowledged request at its first handling deadline.
  const f = fixture("unhandled", false);
  // When one real loop pass runs, stopped by the inbound catch-up event.
  await f.tick(true, true);
  // Then handling escalation happened without prematurely notifying the owner.
  expect(f.journal().events.filter((event) => event.line.startsWith("UNHANDLED "))).toHaveLength(1);
  expect(f.posts).toEqual([]);
});

test("the production loop tells systemd READY, then pets the watchdog after a pass", async () => {
  // Given a supervisor with nothing due.
  const f = fixture("unhandled", false);
  // When one real loop pass runs.
  await f.tick(true, true);
  // Then the service reported ready and its pass petted the watchdog.
  expect(f.notified[0]).toBe("READY=1");
  expect(f.notified).toContain("WATCHDOG=1");
});

test("READY and watchdog notifications retain their bounded systemd transport", async () => {
  // Given an enabled notify socket and an observable runner.
  const calls: { argv: readonly string[]; timeoutMs?: number }[] = [];
  // When both existing service notifications run.
  for (const state of ["READY=1", "WATCHDOG=1"]) {
    expect(await sdNotify(state, { NOTIFY_SOCKET: "/test/notify" }, async (argv, options) => {
      calls.push({ argv, timeoutMs: options?.timeoutMs });
      return { code: 0, out: "", err: "" };
    })).toBe(true);
  }
  // Then they still use the same pid and 5-second subprocess deadline.
  expect(calls).toEqual([
    { argv: ["systemd-notify", `--pid=${process.pid}`, "READY=1"], timeoutMs: 5_000 },
    { argv: ["systemd-notify", `--pid=${process.pid}`, "WATCHDOG=1"], timeoutMs: 5_000 },
  ]);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("the loop rejects invalid handledTimeoutMin=%s before starting services", async (handledTimeoutMin) => {
  // Given an invalid handling deadline in otherwise valid startup settings.
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { handledTimeoutMin });
  // When the real supervisor startup validates its configuration.
  const started = supervise(deps, new AbortController().signal);
  // Then it rejects this setting before credentials, locks or gateway startup can mask the error.
  await expect(started).rejects.toThrow("handledTimeoutMin must be positive");
});
