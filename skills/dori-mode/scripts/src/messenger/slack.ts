import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import type { ThreadLedger } from "./thread-ledger.ts";

export type SlackAuth = { readonly token: string; readonly cookie?: string };
export type Posted = { readonly channel: string; readonly ts: string };

export class Slack {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly auth: SlackAuth,
    private readonly base = "https://slack.com/api",
    private readonly ledger?: ThreadLedger,
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.token}`,
      ...(json ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(this.auth.cookie ? { Cookie: `d=${this.auth.cookie}` } : {}),
    };
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await withBackoff(this.http, this.clock, { method: "POST", url: `${this.base}/${method}`, headers: this.headers(true), body: JSON.stringify(params) });
    const body = JSON.parse(res.body || "{}") as Record<string, unknown>;
    if (res.status !== 200 || body.ok !== true) throw new MessengerError(`slack ${method}: ${String(body.error ?? res.status)}`, res.status, String(body.error ?? ""));
    if (this.ledger && method === "chat.postMessage" && typeof body.ts === "string") {
      const channel = String(body.channel ?? params.channel);
      await this.ledger.record(channel, typeof params.thread_ts === "string" ? params.thread_ts : body.ts, body.ts);
    }
    return body;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<Posted> {
    const r = await this.call("chat.postMessage", { channel, text: guardText(text), ...(threadTs ? { thread_ts: threadTs } : {}) });
    return { channel: String(r.channel), ts: String(r.ts) };
  }

  async edit(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text: guardText(text) });
  }

  async upload(channel: string, filename: string, bytes: Uint8Array<ArrayBuffer>, threadTs?: string, title?: string): Promise<string> {
    const slot = await this.call("files.getUploadURLExternal", { filename, length: bytes.byteLength });
    const put = await withBackoff(this.http, this.clock, { method: "POST", url: String(slot.upload_url), body: bytes });
    if (put.status !== 200) throw new MessengerError(`slack upload: ${put.status}`, put.status);
    await this.call("files.completeUploadExternal", { files: [{ id: slot.file_id, title: title ?? filename }], channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) });
    return String(slot.file_id);
  }

  async setPresence(presence: "auto" | "away"): Promise<void> {
    await this.call("users.setPresence", { presence });
  }
}
