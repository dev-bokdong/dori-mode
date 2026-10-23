import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The lead's read path for delivered events (`dori inbox take`). It prints lead-events.log from the take cursor to the
 * last complete line, at most `maxBytes` of whole lines, and writes an immutable take receipt for exactly what it
 * printed. The supervisor consumes the receipts (supervise-journal.ts consumeTakes), moves its cursor and publishes it
 * as state/inbox-cursor.json, so this CLI never opens the supervisor's store or lock.
 */

export const EVENT_LOG = "lead-events.log";
export const CURSOR_FILE = "inbox-cursor.json";
const TAKE_FILE = /^\d+-[\w-]+\.json$/;

export const takesDir = (stateDir: string): string => join(stateDir, "takes");
const cursorPath = (stateDir: string): string => join(stateDir, CURSOR_FILE);

export class InboxError extends Error {}

const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** tmp, fsync, rename, then the directory fsync: a crash leaves either the old file or the complete new one. */
const writeDurable = (path: string, dir: string, text: string): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flush: true });
  renameSync(tmp, path);
  fsyncDir(dir);
};

export type TakeReceipt = { readonly path: string; readonly offset: number; readonly at: number };

const offsetOk = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Take receipts waiting for the supervisor; unreadable or malformed files are skipped (and never dropped). */
export const pendingTakes = (stateDir: string): TakeReceipt[] => {
  let names: string[];
  try { names = readdirSync(takesDir(stateDir)); } catch { return []; }
  return names.filter((name) => TAKE_FILE.test(name)).flatMap((name) => {
    const path = join(takesDir(stateDir), name);
    try {
      const { offset, at } = JSON.parse(readFileSync(path, "utf8")) as { offset?: unknown; at?: unknown };
      if (!offsetOk(offset)) return [];
      return [{ path, offset, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs }];
    } catch { return []; }
  });
};

export const dropTake = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};

export const readCursorFile = (stateDir: string): number | undefined => {
  try {
    const { offset } = JSON.parse(readFileSync(cursorPath(stateDir), "utf8")) as { offset?: unknown };
    return offsetOk(offset) ? offset : undefined;
  } catch { return undefined; }
};

export const writeCursorFile = (stateDir: string, offset: number): void => {
  writeDurable(cursorPath(stateDir), stateDir, JSON.stringify({ offset }));
};

/**
 * Where the next take starts: the published cursor or any receipt the supervisor has not consumed yet, whichever is
 * further. Receipts are dropped only after the cursor file covers them, so this never goes backwards.
 */
export const takeCursor = (stateDir: string): number | undefined => {
  const cursor = readCursorFile(stateDir);
  if (cursor === undefined) return undefined;
  return Math.max(cursor, ...pendingTakes(stateDir).map((receipt) => receipt.offset));
};

export type LogLine = { readonly text: string; readonly end: number };

/** The complete lines (ending in a newline) of `path` from byte `from`; a partial last line is left out. */
export const completeLines = (path: string, from: number): LogLine[] => {
  let size: number;
  try { size = statSync(path).size; } catch { return []; }
  if (size <= from) return [];
  const data = Buffer.alloc(size - from);
  const fd = openSync(path, "r");
  try {
    let at = 0;
    while (at < data.length) {
      const read = readSync(fd, data, at, data.length - at, from + at);
      if (read === 0) break;
      at += read;
    }
  } finally { closeSync(fd); }
  const lines: LogLine[] = [];
  let start = 0;
  for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
    lines.push({ text: data.subarray(start, nl).toString("utf8"), end: from + nl + 1 });
    start = nl + 1;
  }
  return lines;
};

/** One delivery log line as `{id, line}`; a line that does not parse keeps its raw text under the id `?`. */
export const parseLogLine = (text: string): { readonly id: string; readonly line: string } => {
  try {
    const event = JSON.parse(text) as { id?: unknown; line?: unknown };
    if (typeof event.id === "string" && typeof event.line === "string") return { id: event.id, line: event.line };
  } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  return { id: "?", line: text };
};

export type Take = {
  readonly events: readonly { readonly id: string; readonly line: string }[];
  /** The end of the last printed line: what the receipt covers. */
  readonly offset: number;
  /** Complete lines (and their bytes) left past `offset` because of the byte bound. */
  readonly more?: { readonly lines: number; readonly bytes: number };
  readonly receipt?: string;
};

/**
 * Takes the delivered events past the cursor: whole lines only, at most `maxBytes` of them, but always at least one so
 * a single long line cannot block progress. Unless `peek`, writes a receipt for exactly the printed range. Nothing new
 * writes no receipt.
 */
export const take = (stateDir: string, options: { readonly maxBytes: number; readonly peek?: boolean; readonly now: number; readonly session?: string }): Take => {
  const from = takeCursor(stateDir);
  if (from === undefined) throw new InboxError(`INBOX_UNAVAILABLE the supervisor has not published ${cursorPath(stateDir)} yet; read the end of ${join(stateDir, EVENT_LOG)} instead`);
  const lines = completeLines(join(stateDir, EVENT_LOG), from);
  const printed: LogLine[] = [];
  let start = from;
  for (const line of lines) {
    if (printed.length && line.end - from > options.maxBytes) break;
    printed.push(line);
    start = line.end;
  }
  const events = printed.map((line) => parseLogLine(line.text));
  const rest = lines.slice(printed.length);
  const more = rest.length ? { lines: rest.length, bytes: (rest.at(-1)?.end ?? start) - start } : undefined;
  if (!printed.length || options.peek) return { events, offset: start, ...(more ? { more } : {}) };
  const dir = takesDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${options.now}-${randomUUID()}.json`);
  writeDurable(path, dir, JSON.stringify({ offset: start, ids: events.map((event) => event.id), at: options.now, session: options.session ?? "" }));
  fsyncDir(stateDir);
  return { events, offset: start, ...(more ? { more } : {}), receipt: path };
};

/** The CLI's output for a take: one `id<TAB>line` per event, then INBOX_MORE, or INBOX_EMPTY when there was nothing. */
export const takeOutput = (result: Take): string[] => {
  if (!result.events.length) return ["INBOX_EMPTY"];
  return [
    ...result.events.map((event) => `${event.id}\t${event.line}`),
    ...(result.more ? [`INBOX_MORE ${result.more.lines} ${result.more.bytes}`] : []),
  ];
};
