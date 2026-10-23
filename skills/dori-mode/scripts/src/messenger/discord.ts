import { createHash } from "node:crypto";

import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export const DISCORD_MESSAGE_LIMIT = 2000;
const FENCE = /^\s*(```+|~~~+)/;

/** The fence opener still open at the end of `text` (starting with `open`), or undefined when balanced. */
const openFence = (text: string, open: string | undefined): string | undefined => {
  let current = open;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (!marker) continue;
    if (current === undefined) current = line.trim();
    else if (marker.startsWith(current.slice(0, 3))) current = undefined;
  }
  return current;
};

/**
 * Ordered chunks of at most `limit` characters, cut at the last newline, else the last space, else hard. A code fence
 * left open by a cut is closed at the end of its chunk and reopened (with its language) at the start of the next.
 */
export const splitDiscordMessage = (text: string, limit = DISCORD_MESSAGE_LIMIT): string[] => {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  let fence: string | undefined;
  for (;;) {
    const prefix = fence === undefined ? "" : `${fence}\n`;
    if (prefix.length + rest.length <= limit) { chunks.push(prefix + rest); return chunks; }
    // Always leave room for a closing "\n```" so the chunk stays within the limit if a fence is open at the cut.
    const budget = Math.max(1, limit - prefix.length - 4);
    const window = rest.slice(0, budget + 1);
    let cut = window.lastIndexOf("\n", budget);
    let skip = 1;
    if (cut <= 0) { cut = window.lastIndexOf(" ", budget); }
    if (cut <= 0) {
      cut = budget;
      skip = 0;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut--;
    }
    const piece = rest.slice(0, cut);
    rest = rest.slice(cut + skip);
    const after = openFence(piece, fence);
    chunks.push(prefix + piece + (after === undefined ? "" : "\n```"));
    fence = after;
  }
};

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Record<string, unknown>): Promise<T> {
    // withBackoff adds a per-call nonce; preserve an explicit send identity at the HTTP boundary instead.
    const http: Http = body?.nonce === undefined ? this.http : (req) => this.http({ ...req, body: JSON.stringify(body) });
    const res = await withBackoff(http, this.clock, { method, url: `${this.base}${path}`, headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, undefined, retryAfter);
    if (res.status >= 300) throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  /**
   * Ordered chunks; returns the first id. Retries reuse nonces within Discord's few-minute dedupe window.
   * Without a stable id, identical content in the same channel is treated as a retry; use distinct ids for repeats.
   */
  async send(channelId: string, content: string, stableId?: string): Promise<string> {
    let first: string | undefined;
    for (const [index, chunk] of splitDiscordMessage(guardText(content)).entries()) {
      const nonce = createHash("sha256").update(JSON.stringify([channelId, stableId ?? content, index])).digest("hex").slice(0, 25);
      const id = (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, { content: chunk, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true })).id;
      first ??= id;
    }
    return first ?? "";
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(content) });
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    return (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, { name: guardText(name).slice(0, 100) })).id;
  }

  async setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void> {
    await this.call("PATCH", `/channels/${threadId}`, { ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
  }

  /** Reads a thread back: whether Discord reports it archived. A channel that is not a thread is an error. */
  async threadArchived(threadId: string): Promise<boolean> {
    const archived = (await this.call<{ thread_metadata?: { archived?: unknown } }>("GET", `/channels/${threadId}`)).thread_metadata?.archived;
    if (typeof archived !== "boolean") throw new Error(`discord channel ${threadId} is not a thread`);
    return archived;
  }
}

export type GatewaySocket = {
  send(data: string): void;
  close(code?: number): void;
  onMessage(cb: (data: string) => void): void;
  onClose?(cb: (code: number) => void): void;
  onError?(cb: () => void): void;
};

export const DISCORD_INTENTS_GUILDS = 1;
export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;
export const DISCORD_INTENTS_MESSAGE_CONTENT = 1 << 15;

export const openDiscordGateway = (url = "wss://gateway.discord.gg/?v=10&encoding=json"): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code = 4000) => ws.close(code),
    onMessage: (cb) => { ws.addEventListener("message", (event) => cb(String(event.data))); },
    onClose: (cb) => { ws.addEventListener("close", (event) => cb(event.code)); },
    onError: (cb) => { ws.addEventListener("error", cb); },
  };
};

type GatewayOptions = {
  readonly messageContent?: boolean;
  readonly onMessage?: (data: unknown) => Promise<void>;
  /** MESSAGE_UPDATE, only while Message Content is requested (otherwise the edited text is withheld). */
  readonly onMessageUpdate?: (data: unknown) => Promise<void>;
  /** MESSAGE_DELETE carries only ids, so it is delivered with or without Message Content. */
  readonly onMessageDelete?: (data: unknown) => Promise<void>;
  readonly onReady?: () => Promise<void>;
  /** Synchronous view of every dispatch (op 0) before its specific handler, e.g. to cache thread parents. */
  readonly onDispatch?: (type: string, data: unknown) => void;
  readonly log?: (line: string) => void;
  readonly random?: () => number;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A single owned connection, including while reconnecting or degrading privileged intents. */
export const discordPresence = (
  open: (url?: string) => GatewaySocket,
  token: string,
  clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void },
  onInteraction?: (data: unknown) => Promise<void>,
  options: GatewayOptions = {},
) => {
  let ws: GatewaySocket | undefined;
  let seq: number | null = null;
  let session: string | undefined;
  let resumeUrl: string | undefined;
  let beat: unknown;
  let firstBeat: unknown;
  let retry: unknown;
  let handshake: unknown;
  let failures = 0;
  let stopped = false;
  let healthy = false;
  let acknowledged = true;
  let content = options.messageContent === true;
  const handlers = new Set<Promise<void>>();
  const log = options.log ?? console.error;
  const dispatch = (work: (() => Promise<void>) | undefined) => {
    if (!work || stopped) return;
    const pending = Promise.resolve().then(work).catch(() => log("DISCORD_GATEWAY_ERROR event handler failed"));
    handlers.add(pending);
    void pending.finally(() => handlers.delete(pending));
  };
  const clearConnection = () => {
    healthy = false;
    if (beat !== undefined) clock.clearInterval(beat);
    if (firstBeat !== undefined) clock.clearInterval(firstBeat);
    if (handshake !== undefined) clock.clearInterval(handshake);
    beat = undefined;
    firstBeat = undefined;
    handshake = undefined;
  };
  const resetSession = () => { session = undefined; seq = null; resumeUrl = undefined; };
  const reconnect = (socket?: GatewaySocket) => {
    if (stopped || (socket && socket !== ws)) return;
    clearConnection();
    const previous = ws;
    ws = undefined;
    // Clear identity first: close callbacks from this socket cannot schedule a second retry.
    previous?.close();
    if (retry !== undefined) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
    log(`DISCORD_GATEWAY reconnect in ${delay}ms`);
    retry = clock.setInterval(() => {
      clock.clearInterval(retry);
      retry = undefined;
      connect();
    }, delay);
  };
  const connect = () => {
    if (stopped) return;
    try {
      const socket = open(resumeUrl);
      ws = socket;
      acknowledged = true;
      socket.onClose?.((code) => {
        if (stopped || socket !== ws) return;
        if (code === 4014 && content) {
          content = false;
          resetSession();
          log('DISCORD_GATEWAY enable "Message Content Intent" in the Developer Portal (Bot tab); using presence/interactions with REST inbound fallback');
        } else if ([4007, 4009].includes(code)) resetSession();
        reconnect(socket);
      });
      socket.onError?.(() => reconnect(socket));
      if (socket.onClose) {
        handshake = clock.setInterval(() => reconnect(socket), 30_000);
      }
      socket.onMessage((raw) => {
        if (stopped || socket !== ws) return;
        try {
          const m: unknown = JSON.parse(raw);
          if (!record(m) || typeof m.op !== "number") throw new TypeError("Invalid gateway frame");
          if (typeof m.s === "number") seq = m.s;
          switch (m.op) {
            case 0:
              if (typeof m.t === "string" && options.onDispatch) {
                try { options.onDispatch(m.t, m.d); }
                catch { log("DISCORD_GATEWAY_ERROR dispatch observer failed"); }
              }
              if (m.t === "READY" || m.t === "RESUMED") {
                if (m.t === "READY" && record(m.d)) {
                  if (typeof m.d.session_id === "string") session = m.d.session_id;
                  if (typeof m.d.resume_gateway_url === "string") resumeUrl = `${m.d.resume_gateway_url.replace(/\/$/, "")}/?v=10&encoding=json`;
                }
                if (handshake !== undefined) clock.clearInterval(handshake);
                handshake = undefined;
                healthy = true;
                failures = 0;
                dispatch(options.onReady);
              }
              if (m.t === "INTERACTION_CREATE") dispatch(onInteraction ? () => onInteraction(m.d) : undefined);
              if (m.t === "MESSAGE_CREATE" && content) dispatch(options.onMessage ? () => options.onMessage?.(m.d) ?? Promise.resolve() : undefined);
              if (m.t === "MESSAGE_UPDATE" && content) dispatch(options.onMessageUpdate ? () => options.onMessageUpdate?.(m.d) ?? Promise.resolve() : undefined);
              if (m.t === "MESSAGE_DELETE") dispatch(options.onMessageDelete ? () => options.onMessageDelete?.(m.d) ?? Promise.resolve() : undefined);
              break;
            case 1:
              socket.send(JSON.stringify({ op: 1, d: seq }));
              acknowledged = false;
              break;
            case 7:
              reconnect(socket);
              break;
            case 9:
              if (m.d !== true) resetSession();
              reconnect(socket);
              break;
            case 10:
              if (!record(m.d) || typeof m.d.heartbeat_interval !== "number" || m.d.heartbeat_interval <= 0) throw new TypeError("Invalid gateway heartbeat");
              if (beat !== undefined) clock.clearInterval(beat);
              if (firstBeat !== undefined) clock.clearInterval(firstBeat);
              const heartbeat = () => {
                if (!acknowledged) { reconnect(socket); return; }
                try { socket.send(JSON.stringify({ op: 1, d: seq })); acknowledged = false; }
                catch { reconnect(socket); }
              };
              const interval = m.d.heartbeat_interval;
              if (socket.onClose) {
                firstBeat = clock.setInterval(() => {
                  clock.clearInterval(firstBeat);
                  firstBeat = undefined;
                  heartbeat();
                  if (ws === socket && !stopped) beat = clock.setInterval(heartbeat, interval);
                }, interval * (options.random ?? Math.random)());
              } else beat = clock.setInterval(heartbeat, interval);
              if (session && seq !== null) socket.send(JSON.stringify({ op: 6, d: { token, session_id: session, seq } }));
              else socket.send(JSON.stringify({ op: 2, d: {
                token,
                intents: DISCORD_INTENTS_GUILDS | DISCORD_INTENTS_GUILD_MESSAGES | (content ? DISCORD_INTENTS_MESSAGE_CONTENT : 0),
                properties: { os: process.platform, browser: "dori", device: "dori" },
                presence: { status: "online", since: null, activities: [], afk: false },
              } }));
              break;
            case 11:
              acknowledged = true;
              break;
          }
        } catch {
          log("DISCORD_GATEWAY_ERROR invalid frame or socket failure");
          reconnect(socket);
        }
      });
    } catch {
      log("DISCORD_GATEWAY_ERROR connection failed");
      reconnect();
    }
  };
  connect();
  return {
    get healthy() { return healthy && content; },
    /** Raw socket state for the status file: connected, and whether Message Content is still requested. */
    get connected() { return healthy; },
    get messageContent() { return content; },
    async settled() { await Promise.all(handlers); },
    close() {
      stopped = true;
      clearConnection();
      if (retry !== undefined) clock.clearInterval(retry);
      ws?.close();
      ws = undefined;
    },
  };
};
