import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";

import { GITHUB_FILE, loadGithub } from "./github-events.ts";
import { acquireSupervisor } from "./supervise-loop.ts";
import { cursor, firstDiff, fsyncPath, normalize, type SourceCursor } from "./store-import.ts";
import { JOURNAL_FILE, SQLITE_FILE, SqliteStore, StoreError } from "./store.ts";
import { OPERATIONS_FILE, readRows } from "./operations.ts";

/** The database after an export: kept read-only for audit, never read again (a later import starts from the exported files). */
export const EXPORTED_SQLITE_FILE = "supervisor.sqlite.exported";

export type ExportReport = {
  readonly at: number;
  readonly database: string;
  readonly retired: string;
  /** What the export left on disk: size and sha256 of each file (for the log: complete lines only). */
  readonly files: {
    readonly journal: SourceCursor;
    readonly log: SourceCursor & { readonly lines: number; readonly appended: number };
    readonly githubEvents: SourceCursor;
  };
  /** The source cursors the store held: the log offset its deliveries reach, the last GitHub poll, and the import's record. */
  readonly cursors: { readonly logOffset: number; readonly githubPolledAt?: number; readonly import?: unknown };
  readonly counts: Record<string, number>;
};

const writeSynced = (path: string, text: string, flag: "w" | "a"): void => {
  const fd = openSync(path, flag, 0o600);
  try {
    const data = Buffer.from(text);
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
};

/**
 * The rollback path of the sqlite store (scale 0.5): under the same quiesced barrier as the import (the supervisor lock
 * is held throughout), writes supervisor.json and github-events.json from the store and makes lead-events.log hold
 * every delivery the store recorded. The log is the lead's transport and the sqlite supervisor keeps appending it, so
 * it normally holds them all already and stays byte for byte as it was (the lead's tail offset stays valid); a recorded
 * delivery it lacks is appended. Events the store pruned to tombstones are still lines of that log, and a json
 * supervisor recovers them from it at its start. Each written file is read back and must equal the store, or nothing is
 * moved into place; supervisor.json is renamed last, and the database then becomes the read-only
 * supervisor.sqlite.exported. Afterwards the state dir is a json state dir: set "store": "json" before starting.
 */
export const exportStore = (stateDir: string, now: number, lock: (stateDir: string) => () => void = acquireSupervisor): ExportReport => {
  let release: () => void;
  try { release = lock(stateDir); } catch (e) {
    throw new StoreError(`STORE_SUPERVISOR_RUNNING stop the supervisor before exporting (${e instanceof Error ? e.message : String(e)})`);
  }
  const database = join(stateDir, SQLITE_FILE);
  const jsonPath = join(stateDir, JOURNAL_FILE);
  const githubPath = join(stateDir, GITHUB_FILE);
  const retired = join(stateDir, EXPORTED_SQLITE_FILE);
  const tmpJson = `${jsonPath}.export-${process.pid}`;
  const tmpGithub = `${githubPath}.export-${process.pid}`;
  const opsPath = join(stateDir, OPERATIONS_FILE);
  const tmpOps = `${opsPath}.export-${process.pid}`;
  let hasOps = false;
  try {
    if (existsSync(jsonPath)) throw new StoreError(`STORE_EXPORT_EXISTS ${jsonPath} exists: ${stateDir} is already a json state dir`);
    if (existsSync(retired)) throw new StoreError(`STORE_EXPORT_EXISTS ${retired} exists: ${stateDir} was already exported`);
    if (!existsSync(database)) throw new StoreError(`STORE_MISSING ${database}; nothing to export`);
    const store = new SqliteStore(database);
    let report: Omit<ExportReport, "files"> & { files: Omit<ExportReport["files"], "log"> };
    let log: ExportReport["files"]["log"];
    try {
      const journal = store.read(false);
      const github = loadGithub(store.database);
      const deliveries = store.database.query(`SELECT d.event_id AS id, e.line AS line FROM deliveries d LEFT JOIN events e ON e.id = d.event_id
        ORDER BY d.delivered_at, e.seq`).all() as { id: string; line: string | null }[];
      // The log: complete lines are deliveries; a partial final line never was one (the supervisor truncates it too).
      const logPath = join(stateDir, "lead-events.log");
      const bytes = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
      const end = bytes.lastIndexOf(10) + 1;
      if (end < bytes.length) truncateSync(logPath, end);
      const inLog = new Set(bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id));
      const missing = deliveries.filter((row) => !inLog.has(row.id));
      const lost = missing.filter((row) => row.line === null).map((row) => row.id);
      if (lost.length) throw new StoreError(`STORE_EXPORT_MISMATCH ${lost.length} recorded deliveries have neither an event row nor a line in ${logPath} (${lost.slice(0, 5).join(", ")}); nothing exported`);
      if (missing.length || !existsSync(logPath)) writeSynced(logPath, missing.map((row) => `${JSON.stringify({ id: row.id, line: row.line })}\n`).join(""), "a");
      // Write both files beside their targets and read them back before anything is moved into place.
      writeSynced(tmpJson, JSON.stringify(journal), "w");
      writeSynced(tmpGithub, JSON.stringify(github), "w");
      // Operation rows become operations.json, where the json store keeps them.
      const ops = readRows(store.database);
      hasOps = ops.length > 0;
      if (hasOps) {
        writeSynced(tmpOps, JSON.stringify({ ops: Object.fromEntries(ops.map((op) => [op.id, op])) }), "w");
        if (!Bun.deepEquals(Object.values((JSON.parse(readFileSync(tmpOps, "utf8")) as { ops: Record<string, unknown> }).ops), JSON.parse(JSON.stringify(ops)))) {
          throw new StoreError(`STORE_EXPORT_MISMATCH the exported operations differ from the store; nothing exported`);
        }
      }
      const diff = firstDiff(normalize(JSON.parse(readFileSync(tmpJson, "utf8"))), normalize(journal));
      if (diff) throw new StoreError(`STORE_EXPORT_MISMATCH the exported journal differs from the store at ${diff}; nothing exported`);
      if (!Bun.deepEquals(JSON.parse(readFileSync(tmpGithub, "utf8")), JSON.parse(JSON.stringify(github)))) {
        throw new StoreError(`STORE_EXPORT_MISMATCH the exported GitHub state differs from the store; nothing exported`);
      }
      const logBytes = readFileSync(logPath);
      const logIds = new Set(logBytes.toString("utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id));
      if (deliveries.some((row) => !logIds.has(row.id))) throw new StoreError(`STORE_EXPORT_MISMATCH ${logPath} lacks a recorded delivery; nothing exported`);
      log = { ...cursor(logPath, logBytes), lines: logIds.size, appended: missing.length };
      const imported = store.meta("import");
      report = {
        at: now, database, retired,
        files: { journal: cursor(jsonPath, readFileSync(tmpJson)), githubEvents: cursor(githubPath, readFileSync(tmpGithub)) },
        cursors: { logOffset: store.logCursor(), ...(github.polledAt !== undefined ? { githubPolledAt: github.polledAt } : {}), ...(imported ? { import: JSON.parse(imported) } : {}) },
        counts: store.counts(),
      };
      store.transaction("full", () => store.setMeta("export", JSON.stringify({ at: now, files: { ...report.files, log } })));
      // Everything into the main file; a WAL or shm left beside it moves with it, so the retired copy stays complete.
      store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { store.close(); }
    renameSync(tmpGithub, githubPath);
    if (hasOps) renameSync(tmpOps, opsPath);
    // supervisor.json is the commit point: from here the state dir is a json state dir.
    renameSync(tmpJson, jsonPath);
    fsyncPath(stateDir);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (!existsSync(database + suffix)) continue;
      renameSync(database + suffix, retired + suffix);
      chmodSync(retired + suffix, 0o400);
    }
    fsyncPath(stateDir);
    return { ...report, files: { ...report.files, log } };
  } catch (e) {
    rmSync(tmpJson, { force: true });
    rmSync(tmpGithub, { force: true });
    rmSync(tmpOps, { force: true });
    throw e;
  } finally {
    release();
  }
};
