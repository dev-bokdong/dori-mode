import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { DEFAULT_EVENT_POLICY, type EventPolicy, eventKind } from "./event-policy.ts";
import { redactSecrets } from "./redact.ts";
import type { Runner } from "./run.ts";
import { type ScheduleDeps, Scheduler, type ScheduleSpec, SCHEDULE_FAILED, validateSchedule } from "./schedule.ts";

/*
 * The event source registry (design 1.8). Every event the supervisor journals comes from a named
 * source and goes through Supervisor.enqueue, so the store dedupes it and the policy table (event-policy.ts) decides
 * who hears it. The built-ins are the code paths that existed before (discord, github, sweeps, waits) plus `emit`, the
 * spool `dori emit` writes. The user sources live in <stateDir>/sources.json, managed by `dori source add/remove/list`:
 *   poll     runs an argv every `everySec`; each stdout line matching `match` is one `<kind> <line>` event, deduped by its
 *            first capture group (else the whole line), so a source polls for ever and reports each match once;
 *   webhook  a local HTTP endpoint on 127.0.0.1:<port>; a POST carrying the secret is one event. It never listens beyond
 *            localhost: exposing it is a separate tunnel's job, never the owner's remote-access cloudflared;
 *   file     tails a file from its end at first sight; each new line matching `match` is one event;
 *   schedule a job on a cron expression or interval that emits an event or runs a command (schedule.ts).
 * Each source runs on its own: one that throws is recorded as failing (one SOURCE_FAILED event when it starts failing)
 * and the others keep running. The per-source last event and error are written to sources-status.json for dori status.
 */

export const BUILTIN_SOURCES = ["discord", "github", "sweeps", "waits", "emit"] as const;
export type BuiltinSource = (typeof BUILTIN_SOURCES)[number];
export const SOURCE_TYPES = ["poll", "webhook", "file", "schedule"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type PollSpec = {
  readonly name: string; readonly type: "poll"; readonly kind: string;
  readonly command: readonly string[]; readonly everySec: number; readonly match: string; readonly cwd?: string;
};
export type WebhookSpec = { readonly name: string; readonly type: "webhook"; readonly kind: string; readonly port: number; readonly secret: string };
export type FileSpec = { readonly name: string; readonly type: "file"; readonly kind: string; readonly path: string; readonly match: string };
export type SourceSpec = PollSpec | WebhookSpec | FileSpec | ScheduleSpec;

export class SourceError extends Error {}

export const SOURCES_FILE = "sources.json";
export const SOURCE_STATUS_FILE = "sources-status.json";
export const EMIT_DIR = "emit";
export const POLL_MIN_SEC = 5;
/** A poll command running longer than this is killed and counts as a failure of that source only. */
export const POLL_TIMEOUT_MS = 30_000;
export const WEBHOOK_MAX_BYTES = 64 * 1024;
export const WEBHOOK_SECRET_MIN = 16;
/** At most this much of a tailed file is read per pass; the rest follows on the next one. */
export const FILE_MAX_READ = 1 << 20;
export const TEXT_MAX = 500;

const NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const KIND = /^[A-Z][A-Z0-9_]{1,40}$/;
const EMIT_ID = /^[\w.:@/-]{1,120}$/;

/**
 * Kinds the built-in code emits that change what the lead or the engine does (owner messages, lane claims, waits, ...):
 * a registered source or `dori emit` may not use them, so no source can pass itself off as the owner or a lane.
 */
const RESERVED_KINDS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_EVENT_POLICY.kinds).map((kind) => kind.split(" ")[0] as string),
  "SOURCE_FAILED", SCHEDULE_FAILED, "OWNER_QUARANTINED", "SWEEP_WARN", "LANE_WATCH_WARN", "GH_ISSUE_UNTRUSTED",
]);

export const validKind = (kind: string): string => {
  if (!KIND.test(kind)) throw new SourceError(`kind "${kind}" must be 2-41 uppercase letters, digits or underscores, starting with a letter`);
  if (RESERVED_KINDS.has(kind)) throw new SourceError(`kind ${kind} is a built-in event kind; a source may not use it`);
  return kind;
};

/** One line: whitespace collapsed, clipped to TEXT_MAX. */
export const sourceText = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}~` : flat;
};

const regex = (match: unknown, name: string): string => {
  if (typeof match !== "string" || !match) throw new SourceError(`source ${name}: match must be a regular expression`);
  try { new RegExp(match); } catch (e) { throw new SourceError(`source ${name}: match is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`); }
  return match;
};

/** A spec from sources.json or `dori source add`; throws SourceError naming the bad field. */
export const validateSpec = (raw: unknown): SourceSpec => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SourceError("a source must be an object");
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : "";
  if (!NAME.test(name)) throw new SourceError(`source name "${name}" must be 1-41 lowercase letters, digits, dots, underscores or hyphens`);
  if ((BUILTIN_SOURCES as readonly string[]).includes(name)) throw new SourceError(`source name ${name} is a built-in source`);
  const kind = validKind(typeof r.kind === "string" ? r.kind : "");
  switch (r.type) {
    case "poll": {
      const command = r.command;
      if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string") || !(command[0] as string).trim()) {
        throw new SourceError(`source ${name}: command must be a non-empty argv array of strings`);
      }
      const everySec = r.everySec;
      if (typeof everySec !== "number" || !Number.isFinite(everySec) || everySec < POLL_MIN_SEC) throw new SourceError(`source ${name}: everySec must be at least ${POLL_MIN_SEC}`);
      if (r.cwd !== undefined && (typeof r.cwd !== "string" || !isAbsolute(r.cwd))) throw new SourceError(`source ${name}: cwd must be an absolute path`);
      return { name, type: "poll", kind, command: command as string[], everySec, match: regex(r.match, name), ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}) };
    }
    case "webhook": {
      const port = r.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new SourceError(`source ${name}: port must be an integer from 1024 to 65535`);
      if (typeof r.secret !== "string" || r.secret.length < WEBHOOK_SECRET_MIN) throw new SourceError(`source ${name}: secret must be at least ${WEBHOOK_SECRET_MIN} characters`);
      return { name, type: "webhook", kind, port, secret: r.secret };
    }
    case "file": {
      if (typeof r.path !== "string" || !isAbsolute(r.path)) throw new SourceError(`source ${name}: path must be an absolute path`);
      return { name, type: "file", kind, path: r.path, match: regex(r.match, name) };
    }
    case "schedule":
      return validateSchedule(r, name, kind);
    default:
      throw new SourceError(`source ${name}: type must be one of ${SOURCE_TYPES.join(", ")}`);
  }
};

/** Writes `text` to `path` atomically (fsynced, then renamed), owner-readable only. */
const writeAtomic = (dir: string, path: string, text: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    const handle = openSync(dir, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } finally { rmSync(tmp, { force: true }); }
};

/** The user sources in <stateDir>/sources.json (mode 0600: webhook secrets). Every read sees CLI changes. */
export class SourceSpecs {
  readonly path: string;
  constructor(private readonly stateDir: string) { this.path = join(stateDir, SOURCES_FILE); }

  list(): SourceSpec[] {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw e;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new SourceError(`${this.path} is not valid JSON`); }
    if (!Array.isArray(raw)) throw new SourceError(`${this.path} must hold a JSON array of sources`);
    return raw.map(validateSpec);
  }

  add(raw: unknown): SourceSpec {
    const spec = validateSpec(raw);
    const specs = this.list();
    if (specs.some((s) => s.name === spec.name)) throw new SourceError(`source ${spec.name} already exists; remove it first`);
    if (spec.type === "webhook" && specs.some((s) => s.type === "webhook" && s.port === spec.port)) throw new SourceError(`port ${spec.port} is already used by another webhook source`);
    writeAtomic(this.stateDir, this.path, `${JSON.stringify([...specs, spec], null, 2)}\n`);
    return spec;
  }

  remove(name: string): boolean {
    const specs = this.list();
    const kept = specs.filter((s) => s.name !== name);
    if (kept.length === specs.length) return false;
    writeAtomic(this.stateDir, this.path, `${JSON.stringify(kept, null, 2)}\n`);
    return true;
  }
}

/** A spec as printed by `dori source list`: the webhook secret is never shown. */
export const publicSpec = (spec: SourceSpec): Record<string, unknown> => spec.type === "webhook" ? { ...spec, secret: "(set)" } : { ...spec };

/**
 * `dori emit`: spools one event for the supervisor's `emit` source and returns its event id. With `id` a repeat of the
 * same id is dropped by the store's dedupe; without one every call is its own event.
 */
export const queueEmit = (stateDir: string, kind: string, text: string, now: number, id?: string): string => {
  validKind(kind);
  const line = sourceText(text);
  if (!line) throw new SourceError("--text must not be empty");
  if (id !== undefined && !EMIT_ID.test(id)) throw new SourceError("--id must be 1-120 letters, digits or . _ : @ / -");
  const eventId = `emit:${id ?? randomUUID()}`;
  const dir = join(stateDir, EMIT_DIR);
  writeAtomic(dir, join(dir, `${now}-${randomUUID()}.json`), JSON.stringify({ id: eventId, kind, text: line, at: now }));
  return eventId;
};

export type SourceStatus = {
  readonly type: "builtin" | SourceType;
  /** New events journaled, and events dropped as duplicates of an id the store already had. */
  readonly events: number;
  readonly duplicates: number;
  readonly lastEventAt?: number;
  /** The policy kind of the last new event (never its text: dori status is posted to Discord). */
  readonly lastKind?: string;
  readonly failing?: true;
  readonly lastError?: string;
  readonly lastErrorAt?: number;
  /** Webhook requests refused for a missing or wrong secret. */
  readonly rejected?: number;
  /** A file source's read position. */
  readonly cursor?: { readonly path: string; readonly offset: number };
  /** A schedule's newest planned slot, when its last run settled, how it ended, and what a due run waits for. */
  readonly lastSlot?: number;
  readonly lastRunAt?: number;
  readonly lastResult?: string;
  readonly waiting?: string;
};
export type SourceStatusFile = { readonly at: number; readonly sources: Readonly<Record<string, SourceStatus>> };

export const readSourceStatus = (stateDir: string): SourceStatusFile | undefined => {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, SOURCE_STATUS_FILE), "utf8")) as SourceStatusFile;
    return typeof raw === "object" && raw !== null && typeof raw.sources === "object" && raw.sources !== null ? raw : undefined;
  } catch { return undefined; }
};

/** One row of dori status: the built-ins, then every registered source (also one the supervisor has not run yet). */
export type SourceView = { readonly name: string } & Partial<SourceStatus> & { readonly type: SourceStatus["type"]; readonly kind?: string };

export const sourceViews = (stateDir: string): { readonly sources: readonly SourceView[]; readonly error?: string } => {
  const status = readSourceStatus(stateDir)?.sources ?? {};
  let specs: SourceSpec[] = [];
  let error: string | undefined;
  try { specs = new SourceSpecs(stateDir).list(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const view = (name: string, type: SourceView["type"], kind?: string): SourceView => {
    const { cursor: _, ...rest } = status[name] ?? { events: 0, duplicates: 0 };
    return { ...rest, name, type, ...(kind ? { kind } : {}) };
  };
  return {
    sources: [...BUILTIN_SOURCES.map((name) => view(name, "builtin")), ...specs.map((spec) => view(spec.name, spec.type, spec.kind))],
    ...(error ? { error } : {}),
  };
};

export type SourceEnqueue = (id: string, line: string) => boolean;
export type EventSourcesDeps = {
  readonly stateDir: string;
  /** Supervisor.enqueue: durable, deduped by id, classified by the policy table. */
  readonly enqueue: SourceEnqueue;
  readonly now: () => number;
  readonly run: Runner;
  readonly policy?: EventPolicy;
  readonly log?: (line: string) => void;
  /** The schedule sources run, their runs kept in this operation store; absent leaves them unrun. */
  readonly schedules?: ScheduleDeps;
};

const sha = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
const message = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha(a), "hex"), Buffer.from(sha(b), "hex"));

/** The webhook secret as `X-Dori-Secret: <secret>`, or as GitHub's `X-Hub-Signature-256: sha256=<hmac of the body>`. */
export const webhookAuthorized = (secret: string, headers: Headers, body: Uint8Array): boolean => {
  const plain = headers.get("x-dori-secret");
  if (plain !== null) return sameSecret(plain, secret);
  const signed = headers.get("x-hub-signature-256");
  return signed !== null && sameSecret(signed, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
};

type Listener = { readonly key: string; readonly stop: () => void };

export class EventSources {
  private readonly status = new Map<string, SourceStatus>();
  private readonly nextPoll = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly listeners = new Map<string, Listener>();
  /** The last sources.json that read cleanly: a broken edit keeps the sources running as they were. */
  private lastSpecs: SourceSpec[] = [];
  private dirty = true;
  private readonly scheduler?: Scheduler;

  constructor(private readonly deps: EventSourcesDeps) {
    if (deps.schedules) {
      this.scheduler = new Scheduler({
        stateDir: deps.stateDir, now: deps.now, run: deps.run, enqueueFor: (name) => this.enqueueFor(name),
        update: (name, patch) => { this.set(name, { ...this.entry(name, "schedule"), ...patch }); },
        fail: (name, e) => { this.fail(name, e); }, ok: (name) => { this.ok(name); },
        ...(deps.log ? { log: deps.log } : {}),
      }, deps.schedules);
    }
    for (const [name, entry] of Object.entries(readSourceStatus(deps.stateDir)?.sources ?? {})) this.status.set(name, entry);
    for (const name of BUILTIN_SOURCES) if (!this.status.has(name)) this.status.set(name, { type: "builtin", events: 0, duplicates: 0 });
  }

  private entry(name: string, type: SourceStatus["type"]): SourceStatus {
    const found = this.status.get(name);
    return found?.type === type ? found : { type, events: 0, duplicates: 0 };
  }

  private set(name: string, entry: SourceStatus): void {
    this.status.set(name, entry);
    this.dirty = true;
  }

  private typeOf(name: string): SourceStatus["type"] { return this.status.get(name)?.type ?? "builtin"; }

  /** Journals one event of source `name`; false when the store already had its id (a duplicate, dropped). */
  enqueueFor(name: string): SourceEnqueue {
    return (id, line) => {
      const added = this.deps.enqueue(id, line);
      const entry = this.entry(name, this.typeOf(name));
      this.set(name, added
        ? { ...entry, events: entry.events + 1, lastEventAt: this.deps.now(), lastKind: eventKind(line, this.deps.policy ?? DEFAULT_EVENT_POLICY) }
        : { ...entry, duplicates: entry.duplicates + 1 });
      return added;
    };
  }

  /**
   * Records a failure of `name`. A user source (or the emit spool) that starts failing journals one SOURCE_FAILED
   * event; a built-in already reports its errors its own way (logs, SWEEP_WARN), so it is only shown in dori status.
   */
  fail(name: string, error: unknown): void {
    const entry = this.entry(name, this.typeOf(name));
    const text = message(error);
    const at = this.deps.now();
    this.deps.log?.(`SOURCE_ERROR ${name} ${text}`);
    this.set(name, { ...entry, failing: true, lastError: text, lastErrorAt: at });
    if (entry.failing || (entry.type === "builtin" && name !== "emit")) return;
    try {
      this.deps.enqueue(`source-failed:${name}:${at}`, `SOURCE_FAILED ${name} ${entry.type}: ${text}; the other sources keep running (dori source list)`);
    } catch (e) { this.deps.log?.(`SOURCE_FAILED_ENQUEUE_FAILED ${name} ${message(e)}`); }
  }

  /** A pass of `name` finished without an error: it is no longer failing (its last error stays for dori status). */
  ok(name: string): void {
    const entry = this.status.get(name);
    if (!entry?.failing) return;
    const { failing: _, ...rest } = entry;
    this.set(name, rest);
  }

  /** A built-in's pass: an error is recorded under `name` and rethrown, so the caller's own handling stays as it was. */
  async guard<T>(name: BuiltinSource, work: Promise<T>): Promise<T> {
    try {
      const value = await work;
      this.ok(name);
      return value;
    } catch (e) {
      this.fail(name, e);
      throw e;
    }
  }

  /**
   * One pass over the emit spool and the user sources: due polls run, files are read, webhook listeners follow
   * sources.json. Each source is isolated; the status file is written at the end.
   */
  async tick(): Promise<void> {
    try { this.drainEmit(); this.ok("emit"); } catch (e) { this.fail("emit", e); }
    let specs: SourceSpec[] = [];
    try { specs = new SourceSpecs(this.deps.stateDir).list(); } catch (e) { this.deps.log?.(`SOURCES_INVALID ${message(e)}`); specs = this.lastSpecs; }
    this.lastSpecs = specs;
    const names = new Set(specs.map((spec) => spec.name));
    for (const [name, entry] of this.status) if (entry.type !== "builtin" && !names.has(name)) { this.status.delete(name); this.dirty = true; }
    this.reconcileWebhooks(specs.filter((spec): spec is WebhookSpec => spec.type === "webhook"));
    const now = this.deps.now();
    await Promise.all(specs.map(async (spec) => {
      if (spec.type === "webhook") return;
      if (spec.type === "schedule") {
        if (!this.status.has(spec.name) || this.typeOf(spec.name) !== "schedule") this.set(spec.name, { type: "schedule", events: 0, duplicates: 0 });
        return;
      }
      if (!this.status.has(spec.name) || this.typeOf(spec.name) !== spec.type) this.set(spec.name, { type: spec.type, events: 0, duplicates: 0 });
      if (this.running.has(spec.name)) return;
      if (spec.type === "poll") {
        if ((this.nextPoll.get(spec.name) ?? -Infinity) > now) return;
        this.nextPoll.set(spec.name, now + spec.everySec * 1_000);
      }
      this.running.add(spec.name);
      try {
        if (spec.type === "poll") await this.poll(spec); else this.tail(spec);
        this.ok(spec.name);
      } catch (e) { this.fail(spec.name, e); }
      finally { this.running.delete(spec.name); }
    }));
    this.scheduler?.tick(specs.filter((spec): spec is ScheduleSpec => spec.type === "schedule"));
    this.save();
  }

  /** Resolves once every scheduled job started so far has finished, and writes the status (tests). */
  async settled(): Promise<void> {
    await this.scheduler?.idle();
    this.save();
  }

  /** Spool files in name (time) order; each is removed only after its event is journaled, so a crash re-reads it (deduped). */
  private drainEmit(): void {
    const dir = join(this.deps.stateDir, EMIT_DIR);
    if (!existsSync(dir)) return;
    const put = this.enqueueFor("emit");
    const bad: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
      const path = join(dir, file);
      let item: { id?: unknown; kind?: unknown; text?: unknown };
      try {
        item = JSON.parse(readFileSync(path, "utf8"));
        if (typeof item.id !== "string" || !item.id.startsWith("emit:") || typeof item.kind !== "string" || typeof item.text !== "string") throw new SourceError("not an emit record");
        validKind(item.kind);
      } catch (e) {
        renameSync(path, `${path}.bad`);
        bad.push(`${file}: ${message(e)}`);
        continue;
      }
      put(item.id, `${item.kind} ${sourceText(item.text)}`);
      rmSync(path, { force: true });
    }
    if (bad.length) throw new SourceError(`${bad.length} malformed spool file(s) moved aside as .bad: ${bad.join("; ")}`);
  }

  private async poll(spec: PollSpec): Promise<void> {
    const ran = await this.deps.run(spec.command, { timeoutMs: POLL_TIMEOUT_MS, ...(spec.cwd ? { cwd: spec.cwd } : {}) });
    if (ran.code !== 0) throw new SourceError(`${spec.command[0]} exited ${ran.code}${ran.timedOut ? " (timed out)" : ""}: ${(ran.err || ran.out).trim().slice(0, 150) || "(no output)"}`);
    const re = new RegExp(spec.match);
    const put = this.enqueueFor(spec.name);
    for (const raw of ran.out.split("\n")) {
      const line = sourceText(raw);
      const hit = line ? re.exec(line) : null;
      if (!hit) continue;
      put(`src:${spec.name}:${sha(hit[1] ?? line).slice(0, 32)}`, `${spec.kind} ${line}`);
    }
  }

  /** From the saved offset to the last complete line; a file seen for the first time starts at its end. */
  private tail(spec: FileSpec): void {
    const entry = this.entry(spec.name, "file");
    const size = statSync(spec.path).size;
    const cursor = entry.cursor?.path === spec.path ? entry.cursor : undefined;
    if (!cursor) { this.set(spec.name, { ...entry, cursor: { path: spec.path, offset: size } }); return; }
    const from = size < cursor.offset ? 0 : cursor.offset;
    const length = Math.min(size - from, FILE_MAX_READ);
    if (length <= 0) {
      if (from !== cursor.offset) this.set(spec.name, { ...entry, cursor: { path: spec.path, offset: from } });
      return;
    }
    const data = Buffer.alloc(length);
    const fd = openSync(spec.path, "r");
    let read = 0;
    try { while (read < length) { const n = readSync(fd, data, read, length - read, from + read); if (!n) break; read += n; } } finally { closeSync(fd); }
    const end = data.subarray(0, read).lastIndexOf(10) + 1;
    // One line longer than FILE_MAX_READ is skipped rather than stalling the source.
    const upTo = end || (read === FILE_MAX_READ ? read : 0);
    const re = new RegExp(spec.match);
    const put = this.enqueueFor(spec.name);
    let at = from;
    for (const raw of data.subarray(0, end).toString("utf8").split("\n").slice(0, -1)) {
      const line = sourceText(raw);
      if (line && re.test(line)) put(`src:${spec.name}:${at}:${sha(line).slice(0, 16)}`, `${spec.kind} ${line}`);
      at += Buffer.byteLength(raw) + 1;
    }
    this.set(spec.name, { ...this.entry(spec.name, "file"), cursor: { path: spec.path, offset: from + upTo } });
  }

  private reconcileWebhooks(specs: readonly WebhookSpec[]): void {
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    for (const [name, listener] of this.listeners) {
      const spec = wanted.get(name);
      if (spec && listener.key === this.listenKey(spec)) continue;
      listener.stop();
      this.listeners.delete(name);
    }
    for (const spec of specs) {
      if (!this.status.has(spec.name) || this.typeOf(spec.name) !== "webhook") this.set(spec.name, { type: "webhook", events: 0, duplicates: 0 });
      if (this.listeners.has(spec.name)) continue;
      try {
        const server = Bun.serve({
          hostname: "127.0.0.1", port: spec.port, maxRequestBodySize: WEBHOOK_MAX_BYTES,
          fetch: (request) => this.webhook(spec, request),
          error: (e) => { this.fail(spec.name, e); return new Response("error", { status: 500 }); },
        });
        this.listeners.set(spec.name, { key: this.listenKey(spec), stop: () => { void server.stop(true); } });
        this.ok(spec.name);
      } catch (e) { this.fail(spec.name, `cannot listen on 127.0.0.1:${spec.port}: ${message(e)}`); }
    }
  }

  private listenKey(spec: WebhookSpec): string { return `${spec.port}\0${spec.secret}\0${spec.kind}`; }

  /**
   * POST with the secret: the body's JSON `text` (else the raw body) becomes `<kind> <text>`, deduped by the body's
   * `id`, an X-Dori-Id or X-GitHub-Delivery header, else the body's hash. 202 only after the event is journaled.
   */
  async webhook(spec: WebhookSpec, request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > WEBHOOK_MAX_BYTES) return new Response("too large\n", { status: 413 });
    if (!webhookAuthorized(spec.secret, request.headers, body)) {
      const entry = this.entry(spec.name, "webhook");
      this.set(spec.name, { ...entry, rejected: (entry.rejected ?? 0) + 1 });
      return new Response("unauthorized\n", { status: 401 });
    }
    const raw = Buffer.from(body).toString("utf8");
    let text: string | undefined;
    let id: string | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const fields = parsed as { text?: unknown; id?: unknown };
        if (typeof fields.text === "string") text = fields.text;
        if (typeof fields.id === "string" || typeof fields.id === "number") id = String(fields.id);
      }
    } catch { /* not JSON: the raw body is the text */ }
    const line = sourceText(text ?? raw);
    if (!line) return new Response("empty event\n", { status: 400 });
    id ??= request.headers.get("x-dori-id") ?? request.headers.get("x-github-delivery") ?? sha(body);
    try {
      const added = this.enqueueFor(spec.name)(`src:${spec.name}:${id.slice(0, 120)}`, `${spec.kind} ${line}`);
      this.ok(spec.name);
      return Response.json({ ok: true, duplicate: !added }, { status: 202 });
    } catch (e) {
      this.fail(spec.name, e);
      return new Response("not journaled; retry\n", { status: 503 });
    }
  }

  /** Writes sources-status.json when anything changed (dori status reads it). */
  save(): void {
    if (!this.dirty) return;
    try {
      const file: SourceStatusFile = { at: this.deps.now(), sources: Object.fromEntries(this.status) };
      writeAtomic(this.deps.stateDir, join(this.deps.stateDir, SOURCE_STATUS_FILE), `${JSON.stringify(file)}\n`);
      this.dirty = false;
    } catch (e) { this.deps.log?.(`SOURCE_STATUS_WRITE_FAILED ${message(e)}`); }
  }

  /** Stops the webhook listeners and writes the status (shutdown and tests). */
  close(): void {
    for (const listener of this.listeners.values()) listener.stop();
    this.listeners.clear();
    this.save();
  }
}
