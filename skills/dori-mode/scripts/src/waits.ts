import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

import { fetchHttp } from "./messenger/http.ts";
import type { Runner } from "./run.ts";
import { checkSignal, parseSignal, type Check } from "./signals.ts";

export class WaitError extends Error {}
export const WAIT_CHECK_MS = 10_000;
export const WAIT_MAX_FAILURES = 30;

/** Durable quarantine notices, including those created by a different CLI process. */
export const unreportedCorruptWaits = (stateDir: string): string[] => {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((name) => name.startsWith("waits.json.corrupt-") && !name.endsWith(".reported"))
    .map((name) => join(stateDir, name))
    .filter((path) => !existsSync(`${path}.reported`))
    .sort();
};

type Outcome = "WAIT_DONE" | "WAIT_TIMEOUT" | "WAIT_FAILED";
const OUTCOMES: readonly unknown[] = ["WAIT_DONE", "WAIT_TIMEOUT", "WAIT_FAILED"];

export type Wait = {
  readonly id: string;
  readonly key: string;
  readonly until: string;
  readonly note: string;
  readonly thread?: string;
  readonly cwd: string;
  readonly everyMs: number;
  readonly deadline?: number;
  readonly nextAt: number;
  readonly outcome?: Outcome;
  /** Consecutive operational check failures; a successful check, even if unmet, resets it. */
  readonly failures?: number;
};

type Registration = {
  readonly key: string;
  readonly until: string;
  readonly note: string;
  readonly thread?: string;
  readonly cwd: string;
  readonly every?: string;
  readonly timeout?: string;
};

const positive = (value: string, name: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new WaitError(`${name} must be positive`);
  return n;
};

const decode = (value: unknown): Wait => {
  if (typeof value !== "object" || value === null ||
      !("id" in value) || typeof value.id !== "string" ||
      !("key" in value) || typeof value.key !== "string" ||
      !("until" in value) || typeof value.until !== "string" ||
      !("note" in value) || typeof value.note !== "string" ||
      !("cwd" in value) || typeof value.cwd !== "string" ||
      !("everyMs" in value) || typeof value.everyMs !== "number" || !Number.isFinite(value.everyMs) || value.everyMs <= 0 ||
      !("nextAt" in value) || typeof value.nextAt !== "number" || !Number.isFinite(value.nextAt) ||
      ("thread" in value && typeof value.thread !== "string") ||
      ("deadline" in value && (typeof value.deadline !== "number" || !Number.isFinite(value.deadline))) ||
      ("outcome" in value && !OUTCOMES.includes(value.outcome)) ||
      ("failures" in value && (typeof value.failures !== "number" || !Number.isInteger(value.failures) || value.failures < 0))) {
    throw new WaitError("invalid wait state");
  }
  return {
    id: value.id, key: value.key, until: value.until, note: value.note, cwd: value.cwd,
    everyMs: value.everyMs, nextAt: value.nextAt,
    ...("thread" in value && typeof value.thread === "string" ? { thread: value.thread } : {}),
    ...("deadline" in value && typeof value.deadline === "number" ? { deadline: value.deadline } : {}),
    ...("outcome" in value && OUTCOMES.includes(value.outcome) ? { outcome: value.outcome as Outcome } : {}),
    ...("failures" in value && typeof value.failures === "number" && value.failures > 0 ? { failures: value.failures } : {}),
  };
};

/** CLI mutations and sweep commits serialize; checks never hold this lock. */
export class Waits {
  private readonly path: string;
  constructor(private readonly stateDir: string, private readonly maxFailures = WAIT_MAX_FAILURES) {
    this.path = join(stateDir, "waits.json");
  }

  private locked<T>(act: (waits: Wait[]) => T): T {
    mkdirSync(this.stateDir, { recursive: true });
    const db = new Database(join(this.stateDir, "waits-lock.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      return act(this.load());
    } finally { db.close(); }
  }

  /** A waits.json that does not parse is renamed to waits.json.corrupt-<ms> and the store continues empty. */
  private load(): Wait[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(raw)) throw new WaitError("invalid wait list");
      return raw.map(decode);
    } catch (e) {
      const aside = `${this.path}.corrupt-${Date.now()}-${randomUUID()}`;
      renameSync(this.path, aside);
      this.syncDir();
      console.error(`WAITS_CORRUPT moved ${this.path} to ${aside}: ${e instanceof Error ? e.message : String(e)}; continuing with no waits`);
      return [];
    }
  }

  private save(waits: readonly Wait[]): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(waits)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, this.path);
    this.syncDir();
  }

  private syncDir(): void {
    const dir = openSync(this.stateDir, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  /** Emit before marking reported, so enqueue failures/restarts retry the same stable ID. */
  reportCorruptWaits(emit: (id: string, line: string) => void): void {
    this.locked(() => {
      for (const aside of unreportedCorruptWaits(this.stateDir)) {
        try {
          emit(`waits-corrupt:${aside}`, `WAITS_CORRUPT waits.json did not parse and was moved to ${aside}; every wait in it is dropped, register them again`);
          const fd = openSync(`${aside}.reported`, "w", 0o600);
          try { fsyncSync(fd); } finally { closeSync(fd); }
          this.syncDir();
        } catch (e) {
          console.error(`WAITS_CORRUPT_REPORT_ERROR ${aside} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
  }

  list(): Wait[] { return this.locked((waits) => waits); }

  register(input: Registration, now: number): Wait {
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(input.key)) throw new WaitError("wait key must be 1-61 lowercase letters, digits, dots, underscores or hyphens");
    if (!input.note.trim()) throw new WaitError("--note is required");
    parseSignal(input.until);
    const everyMs = positive(input.every ?? "60", "--every") * 1000;
    const deadline = input.timeout === undefined ? undefined : now + positive(input.timeout, "--timeout") * 60_000;
    if (!Number.isFinite(everyMs) || (deadline !== undefined && !Number.isFinite(deadline))) throw new WaitError("wait duration is too large");
    const wait: Wait = {
      id: randomUUID(), key: input.key, until: input.until, note: input.note, cwd: input.cwd,
      everyMs, nextAt: now, ...(deadline === undefined ? {} : { deadline }),
      ...(input.thread ? { thread: input.thread } : {}),
    };
    return this.locked((waits) => {
      if (waits.some((w) => w.key === wait.key)) throw new WaitError(`wait ${wait.key} already exists; cancel it first`);
      this.save([...waits, wait]);
      return wait;
    });
  }

  cancel(key: string): boolean {
    return this.locked((waits) => {
      const remaining = waits.filter((w) => w.key !== key);
      if (remaining.length === waits.length) return false;
      this.save(remaining);
      return true;
    });
  }

  async tick(
    now: () => number,
    run: Runner,
    emit: (id: string, line: string) => void,
    check: (wait: Wait, signal: AbortSignal) => Promise<Check> = (wait, signal) =>
      checkSignal(wait.until, (argv, opts) => run(argv, { ...opts, cwd: wait.cwd, timeoutMs: WAIT_CHECK_MS }), {
        cwd: wait.cwd, http: (req) => fetchHttp({ ...req, signal }),
      }),
  ): Promise<void> {
    this.reportCorruptWaits(emit);
    const due = this.locked((waits) => {
      const at = now();
      const due = waits.filter((w) => w.outcome || w.nextAt <= at || (w.deadline !== undefined && w.deadline <= at));
      if (due.length) this.save(waits.map((w) => due.includes(w) ? { ...w, nextAt: at + w.everyMs } : w));
      return due;
    });
    await Promise.all(due.map(async (wait) => {
      try {
        let outcome = wait.outcome;
        let failure: string | undefined;
        if (!outcome && wait.deadline !== undefined && wait.deadline <= now()) outcome = "WAIT_TIMEOUT";
        if (!outcome) {
          const controller = new AbortController();
          const budget = Math.min(WAIT_CHECK_MS, wait.deadline === undefined ? WAIT_CHECK_MS : Math.max(0, wait.deadline - now()));
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const checked = await Promise.race([
              check(wait, controller.signal),
              new Promise<Check>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new WaitError("wait check timed out"));
                }, budget);
              }),
            ]);
            if (wait.deadline !== undefined && wait.deadline <= now()) outcome = "WAIT_TIMEOUT";
            else if (checked.error !== undefined) failure = checked.error;
            else if (checked.ok) outcome = "WAIT_DONE";
          } catch (e) {
            if (wait.deadline !== undefined && wait.deadline <= now()) outcome = "WAIT_TIMEOUT";
            else failure = e instanceof Error ? e.message : String(e);
          } finally { clearTimeout(timer); controller.abort(); }
        }
        if (!outcome) {
          if (failure !== undefined) console.error(`WAIT_ERROR ${wait.key} ${failure}`);
          if (failure === undefined && !wait.failures) return;
          const failed = this.locked((waits) => {
            const current = waits.find((w) => w.id === wait.id);
            if (!current) return false; // cancelled/replaced during the check
            const failures = failure === undefined ? 0 : (current.failures ?? 0) + 1;
            const capped = current.deadline === undefined && failures >= this.maxFailures;
            const { failures: _, ...rest } = current;
            this.save(waits.map((w) => w.id === wait.id ? { ...rest, ...(failures ? { failures } : {}), ...(capped ? { outcome: "WAIT_FAILED" as const } : {}) } : w));
            return capped;
          });
          if (!failed) return;
          outcome = "WAIT_FAILED";
        }
        const terminal = outcome;
        this.locked((waits) => {
          const current = waits.find((w) => w.id === wait.id);
          if (!current) return; // cancelled/replaced during the check
          this.save(waits.map((w) => w.id === wait.id ? { ...w, outcome: terminal } : w));
          const why = terminal === "WAIT_FAILED" ? ` (${current.failures ?? 0} checks in a row failed; no --timeout set)` : "";
          emit(`wait:${wait.id}`, `${terminal} ${wait.key} ${wait.note}${why}${wait.thread ? ` thread=${wait.thread}` : ""}`);
          this.save(waits.filter((w) => w.id !== wait.id));
        });
      } catch (e) {
        console.error(`WAIT_ERROR ${wait.key} ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }
}
