import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_LEAD, readStoreView } from "./store.ts";

/**
 * The owner's approval for the lead's paid emergency models (`leadEmergencyModels`), for one quota episode only. The
 * supervisor never moves the lead onto one without it. It is given with the owner's `/emergency` slash command or
 * `dori lead-emergency approve` (both work while the lead itself is stalled) and names the episode that was open
 * (`quotaExhausted.since` in the supervisor journal). It is refused when no episode is open, and it is worthless in any later
 * episode: the next one asks the owner again.
 */
const path = (stateDir: string): string => join(stateDir, "lead-emergency-approval.json");

type Approval = { readonly at: number; readonly episode: number };

const read = (stateDir: string): Approval | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path(stateDir), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { at, episode } = value as { at?: unknown; episode?: unknown };
    // An approval without an episode predates episode binding: it approves nothing.
    return typeof at === "number" && typeof episode === "number" ? { at, episode } : undefined;
  } catch { return undefined; }
};

/** The open quota episode (the journal's `quotaExhausted.since`, from whichever store holds it), or undefined. */
export const openEpisode = (stateDir: string): number | undefined => {
  const since: unknown = readStoreView(stateDir, {
    json: (journal) => (journal as { quotaExhausted?: { since?: unknown } }).quotaExhausted?.since,
    sqlite: (db) => {
      const row = db.query("SELECT quota_exhausted FROM lead_state WHERE lead = ?").get(DEFAULT_LEAD) as { quota_exhausted: string | null } | null;
      return row?.quota_exhausted ? (JSON.parse(row.quota_exhausted) as { since?: unknown }).since : undefined;
    },
  });
  return typeof since === "number" ? since : undefined;
};

/** The episode the stored approval belongs to, or undefined when there is none. */
export const approvedEpisode = (stateDir: string): number | undefined => read(stateDir)?.episode;

/** True when an approval is stored and the episode it names is still open. */
export const emergencyApproved = (stateDir: string): boolean => {
  const episode = approvedEpisode(stateDir);
  return episode !== undefined && episode === openEpisode(stateDir);
};

/** Records the owner's approval for the open episode and returns it; undefined (nothing recorded) when none is open. */
export const approveEmergency = (stateDir: string, at: number): number | undefined => {
  const episode = openEpisode(stateDir);
  if (episode === undefined) return undefined;
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path(stateDir)}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify({ at, episode })); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path(stateDir));
  const dir = openSync(stateDir, "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return episode;
};

export const clearEmergencyApproval = (stateDir: string): void => {
  if (!existsSync(path(stateDir))) return;
  try { unlinkSync(path(stateDir)); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};

export const emergencyApprovedAt = (stateDir: string): number | undefined => read(stateDir)?.at;
