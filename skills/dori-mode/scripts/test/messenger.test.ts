import { expect, test } from "bun:test";

import { Discord, discordPresence } from "../src/messenger/discord.ts";
import { type Http, type HttpRequest, type HttpResponse, MessengerError, UnsafeMessageError } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { slackPresence } from "../src/messenger/slack-presence.ts";
import { htmlTable, startThinking, Telegram, THINKING } from "../src/messenger/telegram.ts";
import { typingWhile } from "../src/messenger/typing.ts";
import { transcribe, TranscriptionError } from "../src/messenger/voice.ts";
import { fakeClock } from "./fakes.ts";

type Script = (req: HttpRequest, n: number) => HttpResponse;
const fakeHttp = (script: Script) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: JSON.stringify(body) });
const sleeps = () => {
  const waited: number[] = [];
  const clock = { ...fakeClock(0), sleep: async (ms: number) => { waited.push(ms); } };
  return { clock, waited };
};
const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: { setInterval: (cb: () => void) => { live.add(cb); return cb; }, clearInterval: (h: unknown) => { live.delete(h as () => void); } },
    fire: () => { for (const cb of live) cb(); },
  };
};

test("a Slack post that hits the rate limit waits retry-after seconds, retries, and lands in the thread", async () => {
  const { http, seen } = fakeHttp((_, n) => (n === 1 ? ok({ ok: false, error: "ratelimited" }, 429, { "retry-after": "3" }) : ok({ ok: true, channel: "C1", ts: "111.222" })));
  const { clock, waited } = sleeps();
  const posted = await new Slack(http, clock, { token: "t" }).post("C1", "deploy finished", "100.1");
  expect(posted).toEqual({ channel: "C1", ts: "111.222" });
  expect(waited).toEqual([3000]);
  expect(JSON.parse(String(seen[1]?.body))).toEqual({ channel: "C1", text: "deploy finished", thread_ts: "100.1" });
});

test("a Slack error that is not transient fails at once with the API error, without retries", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: false, error: "channel_not_found" }));
  const err = await new Slack(http, sleeps().clock, { token: "t" }).edit("C9", "1.2", "x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MessengerError);
  expect((err as MessengerError).code).toBe("channel_not_found");
  expect(seen).toHaveLength(1);
});

test("text carrying a $( substitution is refused before any request goes out, on every platform", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: true }));
  const clock = sleeps().clock;
  await expect(new Slack(http, clock, { token: "t" }).post("C1", "result: $(whoami)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Telegram(http, clock, "b").send({ chatId: 1 }, "$(id)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Discord(http, clock, "b").send("9", "x $(ls)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("a Slack upload asks for an upload URL, sends the bytes there, then shares the file into the thread", async () => {
  const { http, seen } = fakeHttp((req) => {
    if (req.url.endsWith("files.getUploadURLExternal")) return ok({ ok: true, upload_url: "https://files.example/up/1", file_id: "F1" });
    if (req.url.startsWith("https://files.example")) return { status: 200, headers: {}, body: "OK" };
    return ok({ ok: true });
  });
  const id = await new Slack(http, sleeps().clock, { token: "t" }).upload("C1", "report.png", new Uint8Array([1, 2, 3]), "5.6");
  expect(id).toBe("F1");
  expect(seen.map((r) => r.url.split("/").pop())).toEqual(["files.getUploadURLExternal", "1", "files.completeUploadExternal"]);
  expect(JSON.parse(String(seen[2]?.body))).toMatchObject({ channel_id: "C1", thread_ts: "5.6" });
});

test("a Telegram reply starts as Thinking…, streams drafts no faster than the interval, then persists as a real message", async () => {
  const { http, seen } = fakeHttp((req) => ok({ ok: true, result: req.url.endsWith("sendMessage") ? { message_id: 77 } : true }));
  const clock = fakeClock(10_000);
  const tg = new Telegram(http, clock, "b");
  const s = await startThinking(tg, clock, { chatId: 5, threadId: 9 });
  clock.at += 100;
  await s.push("Half");
  clock.at += 900;
  await s.push("Half done");
  const id = await s.finish("All done");
  const calls = seen.map((r) => [r.url.split("/").pop(), JSON.parse(String(r.body)).text]);
  expect(calls).toEqual([["sendMessageDraft", THINKING], ["sendMessageDraft", "Half done"], ["sendMessage", "All done"]]);
  expect(id).toBe(77);
  expect(JSON.parse(String(seen[0]?.body)).message_thread_id).toBe(9);
});

test("Telegram's retry_after in the error body is honored", async () => {
  const { http } = fakeHttp((_, n) => (n === 1 ? ok({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429) : ok({ ok: true, result: { message_id: 1 } })));
  const { clock, waited } = sleeps();
  await new Telegram(http, clock, "b").send({ chatId: 1 }, "hi");
  expect(waited).toEqual([7000]);
});

test("a rich Telegram table escapes HTML and lines columns up inside one pre block", () => {
  expect(htmlTable(["name", "n"], [["a<b", "10"], ["c", "2"]])).toBe("<pre>name  n \n----  --\na&lt;b   10\nc     2 </pre>");
});

test("Discord messages are sent without pinging anyone and edited in place; threads are named and archived", async () => {
  const { http, seen } = fakeHttp((req) => ok(req.method === "POST" && req.url.endsWith("/messages") ? { id: "M1" } : { id: "T1" }));
  const dc = new Discord(http, sleeps().clock, "b");
  expect(await dc.send("C1", "hello @everyone")).toBe("M1");
  await dc.edit("C1", "M1", "hello again");
  expect(await dc.startThread("C1", "M1", "[working] fix login")).toBe("T1");
  await dc.setThread("T1", { name: "[done] fix login", archived: true });
  expect(JSON.parse(String(seen[0]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`)).toEqual(["POST /channels/C1/messages", "PATCH /channels/C1/messages/M1", "POST /channels/C1/messages/M1/threads", "PATCH /channels/T1"]);
});

test("the typing indicator is sent at once, repeats while work runs, and stops when it ends even on failure", async () => {
  const sent: number[] = [];
  const t = fakeTimers();
  const send = async () => { sent.push(1); };
  const result = await typingWhile(send, t.timers, async () => { t.fire(); t.fire(); return 42; });
  expect(result).toBe(42);
  expect(sent).toHaveLength(3);
  expect(t.live.size).toBe(0);
  await expect(typingWhile(send, t.timers, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(t.live.size).toBe(0);
});

test("a voice note becomes text through the configured hook, and a failing or empty transcription is an error", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, out: "  ship it  ", err: "" }; };
  expect(await transcribe(run, ["stt", "--file", "{file}"], "/tmp/v 1.ogg")).toBe("ship it");
  expect(calls[0]).toEqual(["stt", "--file", "/tmp/v 1.ogg"]);
  await expect(transcribe(async () => ({ code: 0, out: "", err: "" }), ["stt", "{file}"], "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
  await expect(transcribe(run, undefined, "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
});

test("Slack presence opens one client-type socket with the cookie, then only tickles it; release closes it and sets away", async () => {
  const { http, seen } = fakeHttp((req) => (req.url.endsWith("client.getWebSocketURL") ? ok({ ok: true, primary_websocket_url: "wss://wss-primary.example/", routing_context: "gw-1" }) : ok({ ok: true })));
  const frames: string[] = [];
  let opened: { url: string; headers: Record<string, string> } | null = null;
  let open = false;
  const p = slackPresence(new Slack(http, sleeps().clock, { token: "xt", cookie: "dc" }), (url, headers) => {
    opened = { url, headers: { ...headers } };
    open = true;
    return { isOpen: () => open, send: (f) => frames.push(f), close: () => { open = false; } };
  }, { token: "xt", cookie: "dc" });
  expect(await p.hold()).toBe("opened");
  expect(await p.hold()).toBe("tickled");
  expect(await p.hold()).toBe("tickled");
  const url = new URL(opened!.url);
  expect(url.searchParams.get("slack_client")).toBe("desktop");
  expect(url.searchParams.get("gateway_server")).toBe("gw-1");
  expect(opened!.headers).toEqual({ Cookie: "d=dc", Origin: "https://app.slack.com" });
  expect(frames.map((f) => JSON.parse(f).type)).toEqual(["tickle", "tickle"]);
  await p.release();
  expect(open).toBe(false);
  expect(seen.filter((r) => r.url.endsWith("users.setPresence")).map((r) => JSON.parse(String(r.body)).presence)).toEqual(["auto", "away"]);
});

test("Discord presence identifies as online after hello, heartbeats with the last sequence, and stops beating on close", () => {
  const sent: string[] = [];
  let onMsg: (d: string) => void = () => {};
  const t = fakeTimers();
  let closed = false;
  const p = discordPresence(() => ({ send: (d) => sent.push(d), close: () => { closed = true; }, onMessage: (cb) => { onMsg = cb; } }), "BOT", t.timers);
  onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  onMsg(JSON.stringify({ op: 0, s: 3, t: "READY", d: {} }));
  t.fire();
  const identify = JSON.parse(sent[0] ?? "{}");
  expect(identify.op).toBe(2);
  expect(identify.d.presence.status).toBe("online");
  expect(JSON.parse(sent[1] ?? "{}")).toEqual({ op: 1, d: 3 });
  p.close();
  expect(closed).toBe(true);
  expect(t.live.size).toBe(0);
});
