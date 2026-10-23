/**
 * A startup or first-loop-pass step still running after this long is logged as `STARTUP_SLOW <step>`. It is well under
 * the unit's TimeoutStartSec=300, so the line reaches the journal before systemd kills a start that hangs.
 */
export const STARTUP_STEP_BUDGET_MS = 60_000;

/** Messages from the probe to its watcher thread (`startup-watch.ts`). `at` is wall-clock milliseconds. */
export type WatchMessage =
  | { readonly kind: "config"; readonly budgetMs: number; readonly fd: number }
  | { readonly kind: "begin"; readonly step: string; readonly at: number }
  | { readonly kind: "end"; readonly step: string };

/**
 * Times the named steps of the supervisor's startup and its first loop pass, and logs them as one
 * `STARTUP_TIMINGS <label> <total>ms <step>=<ms>ms ...` line per report. A worker thread watches the running step and
 * writes `STARTUP_SLOW <step>` straight to `fd` once it passes the budget, so the line appears even while the main
 * thread is blocked in synchronous code, which is all of the pre-READY path (journal reads, SQLite locks).
 */
export class StartupProbe {
  private timings: [step: string, ms: number][] = [];
  private since = performance.now();
  private watcher?: Worker;
  private watchFailed = false;
  private open = true;

  constructor(
    private readonly budgetMs = STARTUP_STEP_BUDGET_MS,
    private readonly log: (line: string) => void = (line) => { console.error(line); },
    private readonly fd = 2,
  ) {}

  get active(): boolean { return this.open; }

  /** A separate probe with the same budget and log, for work running beside this one (its timings never mix in). */
  span(): StartupProbe { return new StartupProbe(this.budgetMs, this.log, this.fd); }

  step<T>(name: string, work: () => T): T {
    if (!this.open) return work();
    const at = performance.now();
    this.watch({ kind: "begin", step: name, at: Date.now() });
    const finish = (): void => {
      this.watch({ kind: "end", step: name });
      this.timings.push([name, Math.round(performance.now() - at)]);
    };
    let result: T;
    try { result = work(); } catch (e) { finish(); throw e; }
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  }

  /** Logs the steps finished since the last report, then starts a new span. */
  report(label: string): void {
    const now = performance.now();
    const steps = this.timings.map(([step, ms]) => ` ${step}=${ms}ms`).join("");
    this.log(`STARTUP_TIMINGS ${label} ${Math.round(now - this.since)}ms${steps}`);
    this.timings = [];
    this.since = now;
  }

  close(): void {
    this.open = false;
    void this.watcher?.terminate();
    this.watcher = undefined;
  }

  private watch(message: WatchMessage): void {
    if (this.watchFailed) return;
    try {
      if (!this.watcher) {
        const watcher = new Worker(new URL("./startup-watch.ts", import.meta.url).href);
        // The watcher never keeps the supervisor alive on its own.
        watcher.unref();
        watcher.postMessage({ kind: "config", budgetMs: this.budgetMs, fd: this.fd } satisfies WatchMessage);
        this.watcher = watcher;
      }
      this.watcher.postMessage(message);
    } catch (e) {
      // Timings still work; only a slow step goes unannounced until it finishes.
      this.watchFailed = true;
      this.log(`STARTUP_WATCH_ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
