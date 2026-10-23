import type { FlowDeps } from "./done-flow.ts";
import { laneRunner, listPanes, type Pane } from "./panes.ts";
import { statusOf } from "./registry.ts";
import { procTable, resolveSession } from "./session-id.ts";

export type SyncRow = { readonly key: string; readonly thread: string; readonly pane: string; readonly session: string; readonly status: string };
export type SyncResult = { readonly rows: SyncRow[]; readonly drift: string[]; readonly unregistered: SyncRow[] };

export const syncRegistry = async (deps: FlowDeps, write: boolean): Promise<SyncResult> => {
  const panes = await listPanes(deps.run);
  const live = new Map(panes.map((p) => [p.pane_id, p]));
  const machines = new Map<string, Map<string, Pane>>();
  const table = await procTable(deps.run);
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const lanes = await deps.registry.open();
  for (const lane of lanes) {
    let inventory = live;
    if (lane.machine) {
      let remote = machines.get(lane.machine);
      if (!remote) {
        try {
          remote = new Map((await listPanes(laneRunner(deps.run, lane))).map((p) => [p.pane_id, p]));
          machines.set(lane.machine, remote);
        } catch (e) {
          drift.push(`${lane.key}: machine ${lane.machine} lookup failed: ${e instanceof Error ? e.message : String(e)}`);
          rows.push({ key: lane.key, thread: lane.thread, pane: lane.pane ?? "-", session: lane.session ?? "-", status: statusOf(lane) });
          continue;
        }
      }
      inventory = remote;
    }
    const pane = lane.pane ? inventory.get(lane.pane) : undefined;
    if (!pane) drift.push(`${lane.key}: pane ${lane.pane ?? "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const hit = pane ? await resolveSession(pane.pane_id, pane.cwd ?? "", table, { run: deps.run, sessionsDir: deps.config.sessionsDir }, lane) : { id: "", via: "none" };
    if (lane.session && hit.id && hit.id !== lane.session) drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && hit.id && hit.id !== lane.session) {
      await deps.registry.update(lane.key, (current) =>
        current && current.session !== hit.id ? { ...current, session: hit.id, sessionVia: hit.via } : undefined);
    }
    rows.push({ key: lane.key, thread: lane.thread, pane: lane.pane ?? "-", session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"), status: statusOf(lane) });
  }
  const owned = new Set(lanes.filter((l) => !l.machine).map((l) => l.pane));
  const watch = new Set(deps.config.workspaces);
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  const unregistered: SyncRow[] = [];
  for (const p of panes) {
    if (owned.has(p.pane_id) || skip.has(p.pane_id) || (watch.size > 0 && !watch.has(p.workspace_id))) continue;
    if (p.agent === undefined) continue;
    const hit = await resolveSession(p.pane_id, p.cwd ?? "", table, { run: deps.run, sessionsDir: deps.config.sessionsDir });
    unregistered.push({ key: p.title ?? p.pane_id, thread: "-", pane: p.pane_id, session: hit.id ? `${hit.id} (${hit.via})` : "-", status: "unregistered" });
  }
  return { rows, drift, unregistered };
};
