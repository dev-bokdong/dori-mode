import { existsSync, readFileSync } from "node:fs";

import type { DoriConfig } from "./config.ts";
import { eventKind } from "./event-policy.ts";
import { sessionDirFor } from "./session-id.ts";
import type { JournalStore } from "./store.ts";

/**
 * Lead wake metrics (design 1.7). A wake is a delivery that starts a lead turn: events appended for an idle warm lead,
 * or a confirmed cold start. Each wake records the kinds that caused it (`trigger`: its urgent events, else the overdue
 * digest ones) and every kind it carried. When the next wake starts, the open one is closed with its model calls: the
 * assistant records its lead session wrote since the wake.
 */
export type Wake = {
  readonly at: number;
  /** The lead session id, or its session file path when the warm lookup resolved one. */
  readonly session: string;
  readonly trigger: readonly string[];
  readonly kinds: Readonly<Record<string, number>>;
  /** Set when the wake is closed; absent while open, or when the session file could not be read. */
  readonly calls?: number;
  readonly closed?: true;
};

/** The trigger of a wake that carried no event (a lead restart by request, or to make owner messages readable). */
export const RESTART_TRIGGER = "(restart)";

/** Assistant records (model calls) in an omo session file at or after `since`. */
export const callsSince = (file: string, since: number): number => {
  let calls = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    const record = entry as { type?: unknown; timestamp?: unknown; message?: { role?: unknown } } | null;
    if (record?.type !== "message" || record.message?.role !== "assistant" || typeof record.timestamp !== "string") continue;
    if (Date.parse(record.timestamp) >= since) calls++;
  }
  return calls;
};

export class WakeMeter {
  constructor(private readonly store: JournalStore, private readonly config: () => DoriConfig, private readonly now: () => number) {}

  /**
   * Closes the open wake, then opens one for `events` handed to `session`, triggered by `trigger`. Called after the
   * delivery: a failure here is logged and never undoes or retries it.
   */
  record(session: string, events: readonly { readonly line: string }[], trigger: readonly { readonly line: string }[]): void {
    try { this.open(session, events, trigger); } catch (e) {
      if (!(e instanceof Error)) throw e;
      console.error(`LEAD_WAKE_RECORD_FAILED ${session} ${e.message}`);
    }
  }

  private open(session: string, events: readonly { readonly line: string }[], trigger: readonly { readonly line: string }[]): void {
    const policy = this.config().eventPolicy;
    const kinds: Record<string, number> = {};
    for (const event of events) {
      const kind = eventKind(event.line, policy);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    const triggers = [...new Set(trigger.map((event) => eventKind(event.line, policy)))];
    this.close();
    this.store.recordWake({ at: this.now(), session, trigger: triggers.length ? triggers : [RESTART_TRIGGER], kinds });
  }

  private close(): void {
    const open = this.store.openWake();
    if (!open) return;
    let calls: number | undefined;
    try {
      const file = this.sessionFile(open.session);
      calls = file ? callsSince(file, open.at) : undefined;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      console.error(`LEAD_WAKE_CALLS_UNREADABLE ${open.session} ${e.message}`);
    }
    this.store.closeWake(open.at, calls);
  }

  private sessionFile(session: string): string | undefined {
    if (session.includes("/")) return existsSync(session) ? session : undefined;
    const config = this.config();
    const dir = sessionDirFor(config.sessionsDir, config.defaultCwd);
    if (!existsSync(dir)) return undefined;
    return Array.from(new Bun.Glob(`*${session}.jsonl`).scanSync({ cwd: dir, absolute: true, onlyFiles: true }))
      .find((path) => path.endsWith(`_${session}.jsonl`) || path.endsWith(`/${session}.jsonl`));
  }
}
