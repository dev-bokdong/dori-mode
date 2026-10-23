import { expect, test } from "bun:test";

import { Discord } from "../src/messenger/discord.ts";
import { guardText, type Http, type HttpRequest, type HttpResponse, withBackoff } from "../src/messenger/http.ts";
import { redactSecrets } from "../src/redact.ts";
import { fakeClock } from "./fakes.ts";

const sleeps = () => {
  const waited: number[] = [];
  return { clock: { ...fakeClock(0), sleep: async (ms: number) => { waited.push(ms); } }, waited };
};
const res = (status: number, body: unknown = {}): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });
const scripted = (steps: readonly (HttpResponse | Error)[]) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    const step = steps[Math.min(seen.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  };
  return { http, seen };
};
const policy = { attempts: 4, baseMs: 10, maxMs: 100 };

test("a thrown fetch is retried with bounded backoff and then succeeds", async () => {
  const { http, seen } = scripted([new Error("ECONNRESET"), new Error("ECONNRESET"), res(200)]);
  const { clock, waited } = sleeps();
  const out = await withBackoff(http, clock, { method: "GET", url: "https://x.example/a" }, policy);
  expect(out.status).toBe(200);
  expect(seen).toHaveLength(3);
  expect(waited).toEqual([10, 20]);
});

test("a fetch that keeps throwing rethrows after the bounded attempts", async () => {
  const { http, seen } = scripted([new Error("down")]);
  await expect(withBackoff(http, sleeps().clock, { method: "PUT", url: "https://x.example/a" }, policy)).rejects.toThrow("down");
  expect(seen).toHaveLength(4);
});

test("an aborted request is not retried", async () => {
  const { http, seen } = scripted([new Error("aborted")]);
  await expect(withBackoff(http, sleeps().clock, { method: "GET", url: "https://x.example/a", signal: AbortSignal.abort() }, policy)).rejects.toThrow("aborted");
  expect(seen).toHaveLength(1);
});

test("Discord message create carries the same nonce with enforce_nonce on every attempt", async () => {
  const { http, seen } = scripted([new Error("reset"), res(502), res(200, { id: "M1" })]);
  const id = await new Discord(http, sleeps().clock, "b").send("C1", "hello");
  expect(id).toBe("M1");
  expect(seen).toHaveLength(3);
  const bodies = seen.map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
  const nonce = bodies[0]!.nonce;
  expect(typeof nonce).toBe("string");
  expect((nonce as string).length).toBeLessThanOrEqual(25);
  for (const b of bodies) {
    expect(b.nonce).toBe(nonce);
    expect(b.enforce_nonce).toBe(true);
    expect(b.content).toBe("hello");
  }
});

test("each Discord create call gets its own nonce", async () => {
  const { http, seen } = scripted([res(200, { id: "M" })]);
  const dc = new Discord(http, sleeps().clock, "b");
  await dc.send("C1", "a");
  await dc.send("C1", "b");
  const [n1, n2] = seen.map((r) => (JSON.parse(r.body as string) as { nonce: string }).nonce);
  expect(n1).not.toBe(n2);
});

test("a split Discord send reuses chunk nonces after chunk two exhausts fetch retries", async () => {
  const { http, seen } = scripted([
    res(200, { id: "M1" }),
    ...Array.from({ length: 5 }, () => new Error("chunk two failed")),
    res(200, { id: "M1" }),
    res(200, { id: "M2" }),
  ]);
  const text = "x".repeat(3000);
  await expect(new Discord(http, sleeps().clock, "b").send("C1", text)).rejects.toThrow("chunk two failed");

  // A fresh adapter also covers a caller retry after a process restart.
  expect(await new Discord(http, sleeps().clock, "b").send("C1", text)).toBe("M1");
  expect(seen).toHaveLength(8);
  const bodies = seen.map((req) => JSON.parse(String(req.body)) as { nonce: string; enforce_nonce: boolean; content: string });
  expect(bodies[6]?.nonce).toBe(bodies[0]?.nonce);
  expect(bodies[7]?.nonce).toBe(bodies[1]?.nonce);
  expect(bodies[0]?.nonce).not.toBe(bodies[1]?.nonce);
  for (const body of bodies) {
    expect(typeof body.nonce).toBe("string");
    expect(body.nonce.length).toBeLessThanOrEqual(25);
    expect(body.enforce_nonce).toBe(true);
  }
});

test("Discord stable send ids distinguish identical messages and channels", async () => {
  const { http, seen } = scripted([res(200, { id: "M" })]);
  const dc = new Discord(http, sleeps().clock, "b");
  await dc.send("C1", "same text", "notice-1");
  await dc.send("C1", "same text", "notice-1");
  await dc.send("C1", "same text", "notice-2");
  await dc.send("C2", "same text", "notice-1");
  const nonces = seen.map((req) => (JSON.parse(String(req.body)) as { nonce: string }).nonce);
  expect(nonces[0]).toBe(nonces[1]);
  expect(new Set([nonces[0], nonces[2], nonces[3]]).size).toBe(3);
});

test("an unkeyed POST is not re-sent after a 5xx or a thrown fetch, but still honors 429", async () => {
  const post: HttpRequest = { method: "POST", url: "https://api.example/do", body: "{}" };
  const five = scripted([res(500), res(200)]);
  expect((await withBackoff(five.http, sleeps().clock, post, policy)).status).toBe(500);
  expect(five.seen).toHaveLength(1);
  const thrown = scripted([new Error("reset"), res(200)]);
  await expect(withBackoff(thrown.http, sleeps().clock, post, policy)).rejects.toThrow("reset");
  expect(thrown.seen).toHaveLength(1);
  const limited = scripted([res(429), res(200)]);
  expect((await withBackoff(limited.http, sleeps().clock, post, policy)).status).toBe(200);
  expect(limited.seen).toHaveLength(2);
});

test("Discord edits and non-create endpoints get no nonce", async () => {
  const { http, seen } = scripted([res(200, { id: "M" })]);
  await new Discord(http, sleeps().clock, "b").edit("C1", "M1", "x");
  expect(JSON.parse(seen[0]!.body as string)).not.toHaveProperty("nonce");
});

const secrets: Record<string, string> = {
  // Joined at runtime so secret scanners do not take this fake fixture for a real bot token.
  discord: ["MTA1NjY3ODkwMTIzNDU2Nzg5MA", "GabcDE", "abcdefghijklmnopqrstuvwxyz0123456789"].join("."),
  slack: "xoxb-1234567890-abcdefghijkl",
  telegram: "123456789:AAEhBOweik6ad9r_QXMENQjcrTu-oq3hGsW",
  ghp: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  gho: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  pat: "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz",
  openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123456789",
  aws: "AKIAIOSFODNN7EXAMPLE",
  bearer: "abcdefghijklmnop.qrstuvwx.yz0123",
};

test("redactSecrets masks every listed secret kind", () => {
  for (const [kind, secret] of Object.entries(secrets)) {
    const out = redactSecrets(kind === "bearer" ? `Authorization: Bearer ${secret}` : `value ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  }
});

test("redactSecrets masks assignments and PEM blocks but keeps the key names", () => {
  expect(redactSecrets("password=hunter2 ok")).toBe("password=[REDACTED] ok");
  expect(redactSecrets("token: abc123xyz")).toBe("token: [REDACTED]");
  expect(redactSecrets('API_KEY="a b c"')).toBe("API_KEY=[REDACTED]");
  expect(redactSecrets("pwd: 123456")).toBe("pwd: [REDACTED]");
  expect(redactSecrets("token: abcdefghijklmnopqrstuvwx")).toBe("token: [REDACTED]");
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAbCd\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`before\n${pem}\nafter`);
  expect(out).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
});

test("redactSecrets leaves ordinary text untouched", () => {
  const plain = [
    "Deploy finished at 12:30 for lane build-7; 3 tests passed.",
    "See https://example.com/a/b?x=1 and PR #42, sk-learn is a library.",
    "the token budget is large; password policy docs updated",
    "commit 3676533abc and ratio 10:20",
    "한국어 메시지도 그대로 둡니다.",
  ];
  for (const t of plain) expect(redactSecrets(t)).toBe(t);
});

test("guardText preserves ordinary English and Korean assignment values", () => {
  const plain = [
    "token: 3 left",
    "secret: plan",
    "secret: 계획",
    "token: 3개 남음",
    "secret: 다음계획을확인하세요",
    "token: remaining",
    'secret: "plan"',
    "password=policy",
    "api_key: documentation",
  ];
  for (const text of plain) expect(guardText(text)).toBe(text);
});

test("guardText redacts secrets and still rejects $(", () => {
  expect(guardText(`key ${secrets.ghp}`)).toBe("key [REDACTED]");
  expect(() => guardText("x $(id)")).toThrow();
});

test("Discord send redacts secrets in the outbound body", async () => {
  const { http, seen } = scripted([res(200, { id: "M" })]);
  await new Discord(http, sleeps().clock, "b").send("C1", `leak ${secrets.aws}`);
  expect(JSON.parse(seen[0]!.body as string).content).toBe("leak [REDACTED]");
});
