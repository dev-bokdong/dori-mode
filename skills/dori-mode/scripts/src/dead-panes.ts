import type { DoriConfig } from "./config.ts";
import { ALIVE_STATUSES } from "./panes.ts";
import type { Lane } from "./registry.ts";
import type { Runner } from "./run.ts";
import { passthroughView, type SweepView } from "./sweep-view.ts";

/** Unrecognised ticks in a row before one alert names the pane. */
export const UNRECOGNISED_ALERT_AFTER = 3;

/** Per-pane memory across ticks: the CLI keeps one of these for the life of the loop. */
export type DeadPaneState = { readonly unknown: Map<string, number>; readonly lastTail: Map<string, string> };
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map() });

/**
 * A pane is alive when herdr reports a running agent status for it; that wins over any screen text. Otherwise it is
 * dead only when this tick's tail carries a configured dead marker AND equals the previous tick's tail, so the two
 * reads are a full loop interval apart and a screen mid-redraw never counts. A marker seen once is pending. Anything
 * else is unrecognised, counted per pane, with one alert after UNRECOGNISED_ALERT_AFTER ticks in a row.
 */
export const deadPaneTick = async (run: Runner, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState = newDeadPaneState(), lanes: readonly Lane[] = [], view: SweepView = passthroughView(run)): Promise<string[]> => {
  const out: string[] = [];
  const machines = new Set(lanes.flatMap((lane) => lane.machine ? [lane.machine] : []));
  for (const machine of machines) {
    // Remote inventories contain other people's panes too: inspect only registered lane panes.
    const owned = new Set(lanes.flatMap((lane) => lane.machine === machine && lane.pane ? [lane.pane] : []));
    try {
      out.push(...await inspect(view, { ...config, workspaces: [], leadPane: "", ignorePanes: [] }, seen, hourKey, state, machine, owned));
    } catch (e) {
      out.push(`DEAD_PANES_WARN machine=${machine} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  out.push(...await inspect(view, config, seen, hourKey, state));
  return out;
};

const inspect = async (view: SweepView, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState, machine?: string, owned?: ReadonlySet<string>): Promise<string[]> => {
  const out: string[] = [];
  const watch = new Set(config.workspaces);
  const skip = new Set([config.leadPane, ...config.ignorePanes].filter(Boolean));
  const marked = (tail: string) => config.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()));
  for (const pane of await view.panes(machine)) {
    if (owned && !owned.has(pane.pane_id)) continue;
    if (skip.has(pane.pane_id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    const id = machine ? `${machine}/${pane.pane_id}` : pane.pane_id;
    if (pane.agent_status && ALIVE_STATUSES.has(pane.agent_status)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      continue;
    }
    const tail = (await view.screen({ ...(machine ? { machine } : {}), pane: pane.pane_id }, 6)).toLowerCase();
    const previous = state.lastTail.get(id);
    state.lastTail.set(id, tail);
    if (marked(tail)) {
      state.unknown.delete(id);
      if (previous !== tail) continue;
      const mark = `${id} ${hourKey}`;
      if (seen.has(mark)) continue;
      seen.add(mark);
      out.push(`DEAD_PANE ${pane.pane_id}${machine ? ` machine=${machine}` : ""}`);
      continue;
    }
    const n = (state.unknown.get(id) ?? 0) + 1;
    state.unknown.set(id, n);
    if (n === UNRECOGNISED_ALERT_AFTER) out.push(`UNRECOGNISED_PANE ${pane.pane_id}${machine ? ` machine=${machine}` : ""} dead-panes: no alive status and no dead marker for ${n} ticks`);
  }
  return out;
};
