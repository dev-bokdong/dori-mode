import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class StateLockError extends Error {}
export const LOCK_WAIT_MS = 10_000;

/** The kernel owns the lock: no publication gap, age expiry, or unlink of another holder's lock. */
export const acquireStateLock = async (path: string): Promise<() => void> => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  const deadline = performance.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        return () => db.close();
      } catch (error) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
        if (performance.now() >= deadline) throw new StateLockError(`state lock timed out: ${path}`);
        // Yield for other operations in this process; a SQLite busy timeout would block their release.
        await Bun.sleep(20);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
};

/** The lock if it is free right now, else undefined (a live holder keeps it; a killed one released it). */
export const tryStateLock = (path: string): (() => void) | undefined => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    return () => db.close();
  } catch (error) {
    db.close();
    if (error instanceof SQLiteError && error.code === "SQLITE_BUSY") return undefined;
    throw error;
  }
};

/** Short synchronous transactions, also used by supervisor callers whose API must stay synchronous. */
export const withStateLockSync = <T>(path: string, act: () => T): T => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`PRAGMA busy_timeout=${LOCK_WAIT_MS}; BEGIN IMMEDIATE`);
    return act();
  } finally { db.close(); }
};
