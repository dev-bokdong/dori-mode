import { redactSecrets } from "../redact.ts";
import type { Clock } from "../run.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
};
export type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$(")) throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return redactSecrets(text);
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

const DISCORD_CREATE = /^https:\/\/discord\.com\/api\/v\d+\/channels\/[^/]+\/messages$/;

/** Discord message-create POSTs get one per-call nonce so Discord dedupes retried attempts. Returns the keyed request, or undefined. */
const withDiscordNonce = (req: HttpRequest): HttpRequest | undefined => {
  if (req.method !== "POST" || !DISCORD_CREATE.test(req.url) || typeof req.body !== "string") return;
  try {
    const body: unknown = JSON.parse(req.body);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 25);
    return { ...req, body: JSON.stringify({ ...body, nonce, enforce_nonce: true }) };
  } catch {
    return;
  }
};

/**
 * 429 is always safe to retry (not processed). Thrown fetches and 5xx are retried only for idempotent methods
 * or POSTs carrying a dedupe key (Discord nonce); other POSTs surface the failure instead of risking a duplicate.
 */
export const withBackoff = async (http: Http, clock: Clock, original: HttpRequest, policy: RetryPolicy = DEFAULT_RETRY, retryAfterFromBody?: (body: string) => number | undefined): Promise<HttpResponse> => {
  const keyed = withDiscordNonce(original);
  const req = keyed ?? original;
  const replaySafe = keyed !== undefined || original.method !== "POST";
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    const final = attempt >= policy.attempts - 1;
    let waitMs = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    try {
      last = await http(req);
    } catch (error) {
      if (!replaySafe || final || req.signal?.aborted) throw error;
      await clock.sleep(waitMs);
      continue;
    }
    if (last.status !== 429 && last.status < 500) return last;
    if (last.status !== 429 && !replaySafe) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = Number.isFinite(header) && header > 0 ? header : fromBody;
    if (waitS !== undefined) waitMs = waitS * 1000;
    if (!final) await clock.sleep(Math.min(policy.maxMs, waitMs));
  }
  return last as HttpResponse;
};
