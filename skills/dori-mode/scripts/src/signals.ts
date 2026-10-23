import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { fetchHttp, type Http } from "./messenger/http.ts";
import type { Runner } from "./run.ts";

/** `error` means the check failed to run, rather than the condition being unmet. */
export type Check = { readonly signal: string; readonly ok: boolean; readonly detail: string; readonly error?: string };

export type Signal =
  | { readonly kind: "merged" | "closed"; readonly repo: string; readonly n: string }
  | { readonly kind: "published"; readonly pkg: string; readonly version: string }
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly stdout?: RegExp }
  | { readonly kind: "file"; readonly path: string; readonly sha256?: string; readonly json?: { readonly path: readonly (string | number)[]; readonly value: unknown } }
  | { readonly kind: "url"; readonly url: string; readonly status: number; readonly body?: RegExp };

export type SignalIo = { readonly http?: Http; readonly cwd?: string; readonly home?: string };

export const COMMAND_TIMEOUT_MS = 120_000;

export const UNREADABLE = [
  "unreadable signal; use one of:",
  "merged <owner/repo>#N | closed <owner/repo>#N | published <pkg>@<version>",
  'command ["argv","as","json"] [stdout~"regex"]',
  'file <path> [sha256=<hex>] [json:.a.b=<json value>]',
  'url <http(s) url> [status=200] [body~"regex"]',
].join(" ");

export class SignalSyntaxError extends Error {}

const readJson = (s: string, i: number): { readonly value: unknown; readonly end: number } => {
  const open = s[i];
  let end = i;
  if (open === '"') {
    end++;
    while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
    end++;
  } else if (open === "[" || open === "{") {
    let depth = 0;
    for (; end < s.length; end++) {
      const c = s[end];
      if (c === '"') {
        end++;
        while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
      } else if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && --depth === 0) break;
    }
    end++;
  } else {
    while (end < s.length && !/\s/.test(s[end] ?? "")) end++;
  }
  const text = s.slice(i, end);
  try {
    return { value: JSON.parse(text), end };
  } catch {
    if (open === '"' || open === "[" || open === "{") throw new SignalSyntaxError(`not valid JSON at "${text.slice(0, 40)}"`);
    return { value: text, end };
  }
};

export const splitDone = (done: string): string[] => {
  const body = done.replace(/^Done\s*=\s*/i, "");
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

type Opt = { readonly key: string; readonly op: "=" | "~"; readonly value: unknown };

const readOptions = (s: string, i: number): Opt[] => {
  const opts: Opt[] = [];
  while (i < s.length) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (i >= s.length) break;
    const m = /^([a-z0-9_]+(?::[^=~\s]+)?)([=~])/i.exec(s.slice(i));
    if (!m?.[1] || !m[2]) throw new SignalSyntaxError(`expected key=value or key~"regex" at "${s.slice(i, i + 30)}"`);
    i += m[0].length;
    const r = readJson(s, i);
    opts.push({ key: m[1], op: m[2] as "=" | "~", value: r.value });
    i = r.end;
  }
  return opts;
};

const regex = (o: Opt | undefined, what: string): RegExp | undefined => {
  if (!o) return undefined;
  if (o.op !== "~" || typeof o.value !== "string") throw new SignalSyntaxError(`${what} takes ~"regex"`);
  try {
    return new RegExp(o.value);
  } catch {
    throw new SignalSyntaxError(`${what}: invalid regex ${o.value}`);
  }
};

const onlyKeys = (opts: readonly Opt[], allowed: (k: string) => boolean, kind: string) => {
  const bad = opts.find((o) => !allowed(o.key));
  if (bad) throw new SignalSyntaxError(`${kind}: unknown option ${bad.key}`);
};

export const parseSignal = (raw: string): Signal => {
  const s = raw.trim();
  const gh = /^(merged|closed)\s+([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)(\d+)\s*$/i.exec(s);
  if (gh?.[1] && gh[2] && gh[3]) return { kind: gh[1].toLowerCase() as "merged" | "closed", repo: gh[2], n: gh[3] };
  const pub = /^published\s+(\S+)@(\S+)\s*$/i.exec(s);
  if (pub?.[1] && pub[2]) return { kind: "published", pkg: pub[1], version: pub[2] };
  const head = /^(command|file|url)\s+/i.exec(s);
  if (!head?.[1]) throw new SignalSyntaxError(UNREADABLE);
  const kind = head[1].toLowerCase();
  const at = head[0].length;
  if (kind === "command") {
    if (s[at] !== "[") throw new SignalSyntaxError('command takes a JSON argv array, e.g. command ["bun","test"]');
    const { value, end } = readJson(s, at);
    if (!Array.isArray(value) || !value.length || !value.every((a) => typeof a === "string" && a.length > 0)) throw new SignalSyntaxError("command argv must be a non-empty array of non-empty strings");
    const opts = readOptions(s, end);
    onlyKeys(opts, (k) => k === "stdout", "command");
    return { kind: "command", argv: value as string[], stdout: regex(opts.find((o) => o.key === "stdout"), "stdout") };
  }
  if (kind === "file") {
    const pathTok = s[at] === '"' ? readJson(s, at) : { value: /^\S+/.exec(s.slice(at))?.[0] ?? "", end: at + (/^\S+/.exec(s.slice(at))?.[0].length ?? 0) };
    if (typeof pathTok.value !== "string" || !pathTok.value) throw new SignalSyntaxError("file needs a path");
    const opts = readOptions(s, pathTok.end);
    onlyKeys(opts, (k) => k === "sha256" || k.startsWith("json:"), "file");
    const sha = opts.find((o) => o.key === "sha256");
    if (sha && (sha.op !== "=" || typeof sha.value !== "string" || !/^[0-9a-f]{64}$/i.test(sha.value))) throw new SignalSyntaxError("sha256= takes 64 hex characters");
    const js = opts.find((o) => o.key.startsWith("json:"));
    if (js && js.op !== "=") throw new SignalSyntaxError("json:<path> takes =<json value>");
    const jsonPath = js ? js.key.slice(5).replace(/^\./, "").split(".").filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
    if (js && !jsonPath.length) throw new SignalSyntaxError("json: needs a field path like json:.version");
    return { kind: "file", path: pathTok.value, ...(sha ? { sha256: String(sha.value).toLowerCase() } : {}), ...(js ? { json: { path: jsonPath, value: js.value } } : {}) };
  }
  const urlTok = /^\S+/.exec(s.slice(at))?.[0] ?? "";
  if (!/^https?:\/\/\S+$/i.test(urlTok)) throw new SignalSyntaxError("url needs an http(s) URL");
  const opts = readOptions(s, at + urlTok.length);
  onlyKeys(opts, (k) => k === "status" || k === "body", "url");
  const st = opts.find((o) => o.key === "status");
  if (st && (st.op !== "=" || !Number.isInteger(st.value))) throw new SignalSyntaxError("status= takes an integer");
  return { kind: "url", url: urlTok, status: st ? Number(st.value) : 200, body: regex(opts.find((o) => o.key === "body"), "body") };
};

const resolvePath = (p: string, io: SignalIo): string => {
  const home = io.home ?? homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : join(io.cwd ?? process.cwd(), expanded);
};

const dig = (v: unknown, path: readonly (string | number)[]): { readonly found: boolean; readonly value: unknown } => {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object" || !(k in (cur as object))) return { found: false, value: undefined };
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return { found: true, value: cur };
};

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

export const checkSignal = async (signal: string, run: Runner, io: SignalIo = {}): Promise<Check> => {
  const s = signal.trim();
  let sig: Signal;
  try {
    sig = parseSignal(s);
  } catch (e) {
    const detail = e instanceof SignalSyntaxError ? e.message : String(e);
    return { signal: s, ok: false, detail, error: detail };
  }
  switch (sig.kind) {
    case "merged": {
      const r = await run(["gh", "pr", "view", sig.n, "--repo", sig.repo, "--json", "state,mergeCommit"]);
      if (r.code !== 0 || r.timedOut) {
        const detail = r.err || `gh exited ${r.code}`;
        return { signal: s, ok: false, detail, error: detail };
      }
      const j = JSON.parse(r.out) as { state?: string; mergeCommit?: { oid?: string } | null };
      const sha = j.mergeCommit?.oid ?? "";
      return { signal: s, ok: j.state === "MERGED" && sha.length > 0, detail: j.state ? `${j.state} ${sha.slice(0, 10)}`.trim() : r.err || "no answer" };
    }
    case "closed": {
      const r = await run(["gh", "issue", "view", sig.n, "--repo", sig.repo, "--json", "state"]);
      if (r.code !== 0 || r.timedOut) {
        const detail = r.err || `gh exited ${r.code}`;
        return { signal: s, ok: false, detail, error: detail };
      }
      const j = JSON.parse(r.out) as { state?: string };
      return { signal: s, ok: j.state === "CLOSED", detail: j.state ?? (r.err || "no answer") };
    }
    case "published": {
      const r = await run(["npm", "view", `${sig.pkg}@${sig.version}`, "version", "--json"]);
      if (r.timedOut || (r.code !== 0 && !/\bE404\b/.test(r.err || r.out))) {
        const detail = r.err || r.out || `npm exited ${r.code}`;
        return { signal: s, ok: false, detail, error: detail };
      }
      const ok = r.code === 0 && r.out.replace(/"/g, "").trim() === sig.version;
      return { signal: s, ok, detail: ok ? `registry has ${sig.pkg}@${sig.version}` : r.err || r.out || "not published" };
    }
    case "command": {
      const r = await run(sig.argv, { ...(io.cwd ? { cwd: io.cwd } : {}), timeoutMs: COMMAND_TIMEOUT_MS });
      if (r.code !== 0 || r.timedOut) {
        const detail = `exit ${r.code}: ${short(r.err || r.out) || "no output"}`;
        return { signal: s, ok: false, detail, ...(r.timedOut || [124, 126, 127].includes(r.code) ? { error: detail } : {}) };
      }
      if (sig.stdout && !sig.stdout.test(r.out)) return { signal: s, ok: false, detail: `exit 0 but stdout does not match ${sig.stdout}: ${short(r.out) || "(empty)"}` };
      return { signal: s, ok: true, detail: sig.stdout ? `exit 0, stdout matches ${sig.stdout}` : "exit 0" };
    }
    case "file": {
      const path = resolvePath(sig.path, io);
      const f = Bun.file(path);
      if (!(await f.exists())) return { signal: s, ok: false, detail: `missing: ${path}` };
      if (sig.sha256) {
        const got = new Bun.CryptoHasher("sha256").update(await f.arrayBuffer()).digest("hex");
        if (got !== sig.sha256) return { signal: s, ok: false, detail: `sha256 ${got.slice(0, 12)}… != ${sig.sha256.slice(0, 12)}…` };
      }
      if (sig.json) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await f.text());
        } catch {
          return { signal: s, ok: false, detail: `not JSON: ${path}` };
        }
        const hit = dig(parsed, sig.json.path);
        const want = JSON.stringify(sig.json.value);
        if (!hit.found) return { signal: s, ok: false, detail: `no field .${sig.json.path.join(".")}` };
        if (JSON.stringify(hit.value) !== want) return { signal: s, ok: false, detail: `.${sig.json.path.join(".")} is ${short(JSON.stringify(hit.value))}, want ${want}` };
      }
      return { signal: s, ok: true, detail: `present${sig.sha256 ? ", sha256 matches" : ""}${sig.json ? `, .${sig.json.path.join(".")} matches` : ""}` };
    }
    case "url": {
      let res: { readonly status: number; readonly body: string };
      try {
        res = await (io.http ?? fetchHttp)({ method: "GET", url: sig.url });
      } catch (e) {
        const detail = `request failed: ${short(String(e))}`;
        return { signal: s, ok: false, detail, error: detail };
      }
      if (res.status !== sig.status) return { signal: s, ok: false, detail: `status ${res.status}, want ${sig.status}` };
      if (sig.body && !sig.body.test(res.body)) return { signal: s, ok: false, detail: `status ${res.status} but body does not match ${sig.body}` };
      return { signal: s, ok: true, detail: `status ${res.status}${sig.body ? ", body matches" : ""}` };
    }
  }
};

export const checkDone = async (done: string, run: Runner, io: SignalIo = {}): Promise<Check[]> => {
  const parts = splitDone(done);
  if (!parts.length) return [{ signal: done, ok: false, detail: "empty Done line" }];
  return Promise.all(parts.map((p) => checkSignal(p, run, io)));
};

export const doneSyntaxErrors = (done: string): string[] => {
  const parts = splitDone(done);
  if (!parts.length) return ["(empty Done line)"];
  return parts.flatMap((p) => {
    try {
      parseSignal(p);
      return [];
    } catch (e) {
      return [`${p} -> ${e instanceof Error ? e.message : String(e)}`];
    }
  });
};
