import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { GITHUB_FILE, importGithub, retireGithubFile } from "./github-events.ts";
import { acquireSupervisor } from "./supervise-loop.ts";
import { JOURNAL_FIELDS, JOURNAL_FILE, PRE_SQLITE_FILE, SQLITE_FILE, SqliteStore, StoreError } from "./store.ts";
import type { Journal } from "./supervise.ts";
import { byAt, JsonOperations, OPERATIONS_DDL, OPERATIONS_FILE, putRows, readRows } from "./operations.ts";

/** A source file as the import read it: absent, or its byte size and sha256 (for the log: complete lines only). */
export type SourceCursor = { readonly path: string; readonly present: boolean; readonly size: number; readonly sha256: string };

export type ImportReport = {
  readonly at: number;
  readonly database: string;
  readonly sources: { readonly journal: SourceCursor; readonly log: SourceCursor & { readonly lines: number }; readonly githubEvents: SourceCursor };
  readonly counts: Record<string, number>;
  /** Events whose source had no `at`: stored with the import time and flagged at_synthetic. */
  readonly syntheticAt: number;
};

export const cursor = (path: string, bytes: Buffer | undefined): SourceCursor => ({
  path, present: bytes !== undefined, size: bytes?.length ?? 0, sha256: createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex"),
});

const readIf = (path: string): Buffer | undefined => (existsSync(path) ? readFileSync(path) : undefined);

export const fsyncPath = (path: string): void => {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** Collections that are empty mean the same as absent; JSON drops undefined fields. */
export const normalize = (journal: Journal): unknown => {
  const plain = JSON.parse(JSON.stringify(journal)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(plain)) {
    if ((Array.isArray(value) && !value.length) || (typeof value === "object" && value !== null && !Array.isArray(value) && !Object.keys(value).length)) delete plain[key];
  }
  return plain;
};

export const firstDiff = (a: unknown, b: unknown, path = "$"): string | undefined => {
  if (Bun.deepEquals(a, b)) return undefined;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return path;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return path;
};

/**
 * Moves a state dir from supervisor.json to supervisor.sqlite under a quiesced barrier: the supervisor lock is held for
 * the whole import, so no supervisor runs and nothing writes the sources. It records the source cursors, imports every
 * journal field (Appendix D) and every delivery in lead-events.log into a temporary database, reads it back and refuses
 * unless the read-back equals the source field by field, then moves the database into place and keeps supervisor.json
 * read-only as supervisor.json.pre-sqlite; github-events.json moves into the same database the same way (importGithub).
 * lead-events.log stays where it is: the lead tails it, and the store records the byte offset it has read. Any refusal leaves the state dir exactly as it was.
 */
export const importStore = (stateDir: string, now: number, lock: (stateDir: string) => () => void = acquireSupervisor): ImportReport => {
  let release: () => void;
  try { release = lock(stateDir); } catch (e) {
    throw new StoreError(`STORE_SUPERVISOR_RUNNING stop the supervisor before importing (${e instanceof Error ? e.message : String(e)})`);
  }
  const database = join(stateDir, SQLITE_FILE);
  const tmp = `${database}.import-${process.pid}`;
  let opsImported = false;
  try {
    const jsonPath = join(stateDir, JOURNAL_FILE);
    const prePath = join(stateDir, PRE_SQLITE_FILE);
    if (existsSync(database) || existsSync(prePath)) throw new StoreError(`STORE_EXISTS ${stateDir} was already imported (${existsSync(database) ? SQLITE_FILE : PRE_SQLITE_FILE} exists)`);
    const raw = readIf(jsonPath);
    const parsed: unknown = raw ? JSON.parse(raw.toString("utf8")) : { events: [] };
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { events?: unknown }).events)) {
      throw new StoreError(`STORE_IMPORT_MALFORMED ${jsonPath} has no events array`);
    }
    const unknown = Object.keys(parsed).filter((key) => !JOURNAL_FIELDS.includes(key));
    if (unknown.length) throw new StoreError(`STORE_IMPORT_UNKNOWN_FIELD ${jsonPath}: ${unknown.join(", ")} has no destination table; nothing imported`);
    const journal = parsed as Journal;
    const logPath = join(stateDir, "lead-events.log");
    const logBytes = readIf(logPath);
    // A partial final line was never a delivery (the supervisor truncates it at its next start).
    const logEnd = logBytes ? logBytes.lastIndexOf(10) + 1 : 0;
    const logLines = logBytes ? logBytes.subarray(0, logEnd).toString("utf8").split("\n").filter(Boolean) : [];
    const delivered = logLines.map((line) => (JSON.parse(line) as { id: string }).id);
    const sources = {
      journal: cursor(jsonPath, raw),
      log: { ...cursor(logPath, logBytes?.subarray(0, logEnd)), present: logBytes !== undefined, lines: logLines.length },
      githubEvents: cursor(join(stateDir, GITHUB_FILE), readIf(join(stateDir, GITHUB_FILE))),
    };
    const stamped: string[] = [];
    const events = journal.events.map((event) => {
      if (event.at !== undefined) return event;
      stamped.push(event.id);
      return { ...event, at: now };
    });
    rmSync(tmp, { force: true });
    const store = new SqliteStore(tmp, { create: true, wal: false });
    let counts: Record<string, number>;
    try {
      store.save({ ...journal, events }, "full");
      store.markSynthetic(stamped);
      store.recordDeliveries(delivered, logEnd, now);
      if (sources.githubEvents.present) importGithub(store.database, stateDir, now);
      // Operation rows move from operations.json into the database's operations table.
      const ops = existsSync(join(stateDir, OPERATIONS_FILE)) ? new JsonOperations(stateDir).list() : [];
      if (ops.length) {
        store.transaction("full", () => { store.database.exec(OPERATIONS_DDL); putRows(store.database, ops); });
        if (!Bun.deepEquals(readRows(store.database), [...ops].sort(byAt))) {
          throw new StoreError(`STORE_IMPORT_MISMATCH operations differ from ${OPERATIONS_FILE}; nothing imported`);
        }
      }
      opsImported = ops.length > 0;
      store.transaction("full", () => store.setMeta("import", JSON.stringify({ at: now, sources })));
      const diff = firstDiff(normalize(store.read(true)), normalize(journal));
      if (diff) throw new StoreError(`STORE_IMPORT_MISMATCH the imported journal differs from ${jsonPath} at ${diff}; nothing imported`);
      const ids = store.deliveredIds();
      if (ids.size !== new Set(delivered).size || delivered.some((id) => !ids.has(id))) throw new StoreError(`STORE_IMPORT_MISMATCH deliveries differ from ${logPath}; nothing imported`);
      counts = store.counts();
    } finally { store.close(); }
    fsyncPath(tmp);
    renameSync(tmp, database);
    if (raw) {
      renameSync(jsonPath, prePath);
      chmodSync(prePath, 0o400);
    }
    if (sources.githubEvents.present) retireGithubFile(stateDir);
    if (opsImported) {
      renameSync(join(stateDir, OPERATIONS_FILE), join(stateDir, `${OPERATIONS_FILE}.pre-sqlite`));
      chmodSync(join(stateDir, `${OPERATIONS_FILE}.pre-sqlite`), 0o400);
    }
    fsyncPath(stateDir);
    return { at: now, database, sources, counts, syntheticAt: stamped.length };
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    release();
  }
};
