import type { Http } from "../../src/messenger/http.ts";
import { StartupProbe } from "../../src/startup-probe.ts";
import { supervise } from "../../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld } from "../fakes.ts";

export const TEN_MINUTES_MS = 10 * 60_000;

/** The real supervise() with fake herdr, Discord and gateway; only the probe and notify transport are the caller's. */
export const superviseWith = (stateDir: string, probe: StartupProbe, signal: AbortSignal, notify: (state: string) => Promise<boolean>): Promise<void> => {
  const world = newWorld();
  world.panes.push({ pane_id: "lead:p1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, fakeClock(1_800_000_000_000), stateDir, {
    discord: { applicationId: "100", guildId: "200", ownerId: "123456789012345" }, discordChannels: ["11"], defaultModel: "test/model",
  });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => argv[0] === "df"
      ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
      : base.run(argv),
  };
  const http: Http = async (request) => ({ status: 200, headers: {}, body: request.url.endsWith("/threads/active") ? JSON.stringify({ threads: [] }) : "[]" });
  return supervise(deps, signal, {
    token: `startup-test-${stateDir}`, http, lookup: async () => "", statusLookup: async () => "",
    open: () => {
      let closed = (_code: number) => {};
      return {
        send: () => {}, close: () => { closed(1000); },
        onMessage: () => {}, onError: () => {}, onClose: (callback) => { closed = callback; },
      };
    },
    timers: { setInterval: () => 0, clearInterval: () => {} },
  }, notify, probe);
};

/** Blocks the main thread synchronously for 10 minutes inside one named step, as a hung journal read would. */
class StallingProbe extends StartupProbe {
  constructor(private readonly stalled: string, budgetMs: number) { super(budgetMs); }

  override step<T>(name: string, work: () => T): T {
    if (name !== this.stalled) return super.step(name, work);
    return super.step(name, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEN_MINUTES_MS);
      return work();
    });
  }
}

// bun startup-supervise.ts <stateDir> <step> <budgetMs>: stdout gets one NOTIFY <state> line per systemd notification.
if (import.meta.main) {
  const [stateDir = "", step = "", budget = ""] = Bun.argv.slice(2);
  process.env.HOME = stateDir;
  delete process.env.NOTIFY_SOCKET;
  await superviseWith(stateDir, new StallingProbe(step, Number(budget)), new AbortController().signal, async (state) => {
    console.log(`NOTIFY ${state}`);
    return true;
  });
}
