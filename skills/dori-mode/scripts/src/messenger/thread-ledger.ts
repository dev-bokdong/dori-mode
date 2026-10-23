import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const tsAfter = (a: string, b: string): boolean => Number(a) > Number(b);

export type LedgerThread = { readonly channel: string; readonly rootTs: string; readonly seenTs: string };

export class ThreadLedger {
  private threads = new Map<string, LedgerThread>();
  private loaded = false;

  constructor(private readonly file: string) {}

  private key(channel: string, rootTs: string): string {
    return `${channel}:${rootTs}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const f = Bun.file(this.file);
    if (await f.exists()) for (const t of (await f.json()) as LedgerThread[]) this.threads.set(this.key(t.channel, t.rootTs), t);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify([...this.threads.values()], null, 1));
    renameSync(tmp, this.file);
  }

  async record(channel: string, rootTs: string, postedTs: string): Promise<void> {
    await this.load();
    const k = this.key(channel, rootTs);
    const prev = this.threads.get(k);
    const seenTs = prev && tsAfter(prev.seenTs, postedTs) ? prev.seenTs : postedTs;
    this.threads.set(k, { channel, rootTs, seenTs });
    await this.save();
  }

  async markSeen(channel: string, rootTs: string, ts: string): Promise<void> {
    await this.load();
    const prev = this.threads.get(this.key(channel, rootTs));
    if (!prev || !tsAfter(ts, prev.seenTs)) return;
    this.threads.set(this.key(channel, rootTs), { ...prev, seenTs: ts });
    await this.save();
  }

  async list(): Promise<LedgerThread[]> {
    await this.load();
    return [...this.threads.values()];
  }
}
