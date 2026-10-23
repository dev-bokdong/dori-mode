import { laneRunner, listPanes, type Pane, readScreen, statusLookup } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { defaultRunTimeout, RUN_TIMEOUT_CODE, type Ran, type Runner } from "./run.ts";

/** A pane on a machine (a lane, or any pane of a snapshot). */
export type PaneRef = { readonly machine?: string; readonly pane?: string };

/**
 * How the sweeps observe panes. Outside a supervisor round (CLI, tests) every call goes to herdr as before
 * (`passthroughView`); inside one (`sweepRound`) they share one pane list per machine and cached reads.
 */
export type SweepView = {
  readonly panes: (machine?: string) => Promise<Pane[]>;
  /** The pane's row, or undefined when it does not exist; throws when herdr cannot list the machine's panes. */
  readonly find: (ref: PaneRef) => Promise<Pane | undefined>;
  /** herdr's agent_status for the pane; a failed lookup comes back as its error text (like `statusLookup`). */
  readonly status: (ref: PaneRef) => Promise<{ readonly status?: string; readonly error?: string }>;
  readonly screen: (ref: PaneRef, lines: number) => Promise<string>;
  readonly processInfo: (ref: PaneRef) => Promise<Ran>;
};

/** Concurrent herdr calls per machine in a round. */
export const SWEEP_CONCURRENCY = 4;
/** One screen read per pane serves every sweep: the largest any of them asks for (remote reports, freshness posts). */
export const SWEEP_SCREEN_LINES = 200;

const on = (run: Runner, machine?: string): Runner => laneRunner(run, machine ? { machine } : {});

/** Every call goes straight to herdr, exactly as the sweeps did before the round view. */
export const passthroughView = (run: Runner): SweepView => ({
  panes: (machine) => listPanes(on(run, machine)),
  find: async (ref) => (await listPanes(on(run, ref.machine))).find((p) => p.pane_id === ref.pane),
  status: (ref) => statusLookup(on(run, ref.machine), ref.pane ?? ""),
  screen: (ref, lines) => readScreen(on(run, ref.machine), ref.pane ?? "", lines),
  processInfo: (ref) => on(run, ref.machine)(["herdr", "pane", "process-info", "--pane", ref.pane ?? ""]),
});

/**
 * At most `limit` calls at once; once `deadlineAt` has passed a call is not started and comes back timed out, and a
 * started call is given only the time left. A freed slot is handed to the next waiter directly, so the limit holds.
 */
export const boundedRunner = (run: Runner, limit: number, deadlineAt: number, now: () => number): Runner => {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < limit) { active++; return; }
    await new Promise<void>((resolve) => { waiting.push(resolve); });
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (argv, opts = {}) => {
    await acquire();
    try {
      const left = deadlineAt - now();
      if (left <= 0) return { code: RUN_TIMEOUT_CODE, out: "", err: `sweep machine deadline passed before: ${argv.join(" ")}`, timedOut: true };
      const own = opts.timeoutMs ?? defaultRunTimeout();
      return await run(argv, { ...opts, timeoutMs: own > 0 ? Math.min(own, left) : left });
    } finally { release(); }
  };
};

type Seen = { readonly token: string; readonly screen?: string; readonly lines?: number; readonly infoToken?: string; readonly info?: Ran };

/** Reads kept across rounds, keyed by machine and pane; valid while the pane's herdr `revision` is unchanged. */
export type SweepCache = Map<string, Seen>;
export const newSweepCache = (): SweepCache => new Map();

export type RoundOptions = {
  readonly now: () => number;
  /** Per machine: no herdr call of this round starts later than this many ms after the round began. */
  readonly deadlineMs: number;
  readonly concurrency?: number;
};

type Snapshot = { readonly panes: Pane[]; readonly byId: ReadonlyMap<string, Pane> } | { readonly error: unknown };

let rounds = 0;

const cacheKey = (machine: string | undefined, pane: string): string => `${machine ?? ""}\u0000${pane}`;

/**
 * One sweep round: one `herdr pane list` per machine, taken now and shared by every sweep. A screen or process-info
 * read is cached by the pane's `revision` (herdr bumps it when the pane's content changes), so a pane that did not
 * change costs no call at all; a row without a revision is cached for this round only. Reads of open lanes whose pane
 * changed are prefetched with at most `concurrency` calls per machine, each machine within its own deadline.
 * A pane missing from the snapshot (a lane launched meanwhile) is confirmed with one fresh list before it counts as gone.
 */
export const sweepRound = async (run: Runner, cache: SweepCache, lanes: readonly Lane[], opts: RoundOptions): Promise<SweepView> => {
  const round = ++rounds;
  const started = opts.now();
  const runners = new Map<string, Runner>();
  const runnerFor = (machine?: string): Runner => {
    const key = machine ?? "";
    let r = runners.get(key);
    if (!r) { r = boundedRunner(on(run, machine), opts.concurrency ?? SWEEP_CONCURRENCY, started + opts.deadlineMs, opts.now); runners.set(key, r); }
    return r;
  };
  const snapshots = new Map<string, Promise<Snapshot>>();
  const snapshot = (machine?: string): Promise<Snapshot> => {
    const key = machine ?? "";
    let s = snapshots.get(key);
    if (!s) {
      s = listPanes(runnerFor(machine)).then(
        (panes): Snapshot => ({ panes, byId: new Map(panes.map((p) => [p.pane_id, p])) }),
        (error: unknown): Snapshot => ({ error }),
      );
      snapshots.set(key, s);
    }
    return s;
  };
  const confirmed = new Map<string, Promise<Pane | undefined>>();
  const find = async (ref: PaneRef): Promise<Pane | undefined> => {
    const pane = ref.pane ?? "";
    const snap = await snapshot(ref.machine);
    const row = "byId" in snap ? snap.byId.get(pane) : undefined;
    if (row) return row;
    const key = cacheKey(ref.machine, pane);
    let fresh = confirmed.get(key);
    if (!fresh) { fresh = listPanes(runnerFor(ref.machine)).then((panes) => panes.find((p) => p.pane_id === pane)); confirmed.set(key, fresh); }
    return fresh;
  };
  const token = (row: Pane): string => row.revision === undefined ? `round:${round}` : `revision:${row.revision}`;
  const screen = async (ref: PaneRef, lines: number): Promise<string> => {
    const pane = ref.pane ?? "";
    let row: Pane | undefined;
    try { row = await find(ref); }
    catch { return readScreen(runnerFor(ref.machine), pane, lines); }
    if (!row) return "";
    const key = cacheKey(ref.machine, pane);
    const seen = cache.get(key);
    const want = Math.max(lines, SWEEP_SCREEN_LINES);
    if (seen?.token === token(row) && seen.screen !== undefined && (seen.lines ?? 0) >= lines) return seen.screen.split("\n").slice(-lines).join("\n");
    const r = await runnerFor(ref.machine)(["herdr", "pane", "read", pane, "--source", "recent", "--lines", String(want)]);
    if (r.code === 0) {
      const current = cache.get(key);
      cache.set(key, { ...(current?.token === token(row) ? current : {}), token: token(row), screen: r.out, lines: want });
    }
    return r.out.split("\n").slice(-lines).join("\n");
  };
  const processInfo = async (ref: PaneRef): Promise<Ran> => {
    const pane = ref.pane ?? "";
    const argv = ["herdr", "pane", "process-info", "--pane", pane];
    const row = await find(ref).catch(() => undefined);
    if (!row) return runnerFor(ref.machine)(argv);
    const key = cacheKey(ref.machine, pane);
    const infoToken = `${token(row)}|${row.agent ?? ""}|${row.agent_status ?? ""}`;
    const seen = cache.get(key);
    if (seen?.infoToken === infoToken && seen.info) return seen.info;
    const r = await runnerFor(ref.machine)(argv);
    if (r.code === 0) {
      const current = cache.get(key);
      cache.set(key, { ...(current?.token === token(row) ? current : { token: token(row) }), infoToken, info: r });
    }
    return r;
  };
  const view: SweepView = {
    panes: async (machine) => {
      const snap = await snapshot(machine);
      if ("error" in snap) throw snap.error;
      return snap.panes;
    },
    find,
    status: async (ref) => {
      try { return { status: (await find(ref))?.agent_status }; }
      catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    },
    screen,
    processInfo,
  };
  const machines = [...new Set<string | undefined>([undefined, ...lanes.map((l) => l.machine)])];
  const taken = await Promise.all(machines.map(async (machine) => [machine, await snapshot(machine)] as const));
  // Forget panes that are gone, so the cache never outgrows the machines' pane lists.
  for (const [machine, snap] of taken) {
    if (!("byId" in snap)) continue;
    for (const key of cache.keys()) {
      const [m, pane] = key.split("\u0000");
      if (m === (machine ?? "") && pane !== undefined && !snap.byId.has(pane)) cache.delete(key);
    }
  }
  // The reads the sweeps will make anyway (quota and freshness read working local lanes, watch reads remote ones,
  // recovery checks the process of every working lane), started together within each machine's limit.
  await Promise.all(lanes.flatMap((lane) => {
    const status = statusOf(lane);
    if (!lane.pane || !(status === "working" || (status === "not-done" && lane.machine))) return [];
    const snap = taken.find(([m]) => m === lane.machine)?.[1];
    if (!snap || !("byId" in snap) || !snap.byId.has(lane.pane)) return [];
    const reads: Promise<unknown>[] = [screen(lane, SWEEP_SCREEN_LINES)];
    if (status === "working") reads.push(processInfo(lane));
    return reads.map((p) => p.catch(() => undefined));
  }));
  return view;
};
