import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "./run.ts";

export type SlotDeps = {
  readonly dir: string;
  readonly slots: number;
  readonly maxLoad: number;
  readonly clock: Clock;
  readonly load: () => Promise<number>;
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
};

const ORPHAN_MS = 60_000;

const tryTake = (deps: SlotDeps, n: number, label: string): string | null => {
  const slot = join(deps.dir, `slot.${n}`);
  const claim = (): string | null => {
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    writeFileSync(join(slot, "owner"), `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`);
    return slot;
  };
  const got = claim();
  if (got) return got;
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch {
    owner = "";
  }
  const pid = Number(owner.split(" ")[0]);
  const orphaned = owner ? !deps.alive(pid) : deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  if (!orphaned) return null;
  rmSync(slot, { recursive: true, force: true });
  return claim();
};

/** One attempt: a free slot while the load is below maxLoad, else null (a scheduled job tries again on its next pass). */
export const trySlot = async (deps: SlotDeps, label: string): Promise<string | null> => {
  mkdirSync(deps.dir, { recursive: true });
  if ((await deps.load()) >= deps.maxLoad) return null;
  for (let n = 1; n <= deps.slots; n++) {
    const slot = tryTake(deps, n, label);
    if (slot) return slot;
  }
  return null;
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  for (;;) {
    const slot = await trySlot(deps, label);
    if (slot) return slot;
    await deps.clock.sleep(pollMs);
  }
};

export const releaseSlot = (slot: string): void => rmSync(slot, { recursive: true, force: true });

export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
};
