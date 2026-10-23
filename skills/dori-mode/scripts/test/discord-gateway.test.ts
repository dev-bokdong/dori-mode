import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordCommands } from "../src/messenger/discord-commands.ts";
import { acquireDiscordGateway } from "../src/messenger/discord-lock.ts";
import { supervisorDiscord } from "../src/messenger/discord-supervisor.ts";
import { discordSnowflakeAt } from "../src/messenger/discord-inbound.ts";
import { discordPresence, type GatewaySocket } from "../src/messenger/discord.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { Supervisor } from "../src/supervise.ts";
import type { DoriConfig } from "../src/config.ts";
import { depsFor, fakeClock, newWorld, withState, readJournal } from "./fakes.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

const timerFixture = () => {
  const live = new Map<number, { cb: () => void; ms: number }>();
  let id = 0;
  return {
    live,
    timers: {
      setInterval: (cb: () => void, ms: number) => { live.set(++id, { cb, ms }); return id; },
      clearInterval: (handle: unknown) => { if (typeof handle === "number") live.delete(handle); },
    },
    fire(ms: number) {
      for (const [key, timer] of [...live]) if (timer.ms === ms && live.has(key)) timer.cb();
    },
  };
};

const socketsFixture = () => {
  const sockets: {
    readonly sent: Record<string, unknown>[];
    readonly receive: (value: unknown) => void;
    readonly disconnect: (code: number) => void;
    readonly error: () => void;
    readonly closed: () => boolean;
  }[] = [];
  const urls: (string | undefined)[] = [];
  const open = (url?: string): GatewaySocket => {
    urls.push(url);
    const sent: Record<string, unknown>[] = [];
    let message = (_raw: string) => {};
    let close = (_code: number) => {};
    let error = () => {};
    let closed = false;
    sockets.push({
      sent, receive: (value) => message(JSON.stringify(value)), disconnect: (code) => close(code),
      error: () => error(), closed: () => closed,
    });
    return {
      send: (raw) => { sent.push(JSON.parse(raw)); },
      close: () => { closed = true; close(4000); },
      onMessage: (cb) => { message = cb; },
      onClose: (cb) => { close = cb; },
      onError: (cb) => { error = cb; },
    };
  };
  const socket = (index = sockets.length - 1) => {
    const found = sockets[index];
    if (!found) throw new Error("Expected gateway socket");
    return found;
  };
  return { open, sockets, urls, socket };
};
const hello = { op: 10, d: { heartbeat_interval: 45_000 } };
const ready = { op: 0, t: "READY", s: 1, d: { session_id: "session", resume_gateway_url: "wss://resume.example" } };
const owner = { id: "300", username: "Owner" };
const rawMessage = (id: string, channel_id = "100", author = owner) => ({
  id, channel_id, author, content: `message ${id}`, attachments: [],
});

test("a missed heartbeat ACK reconnects with resume and releases every owned timer on stop", () => {
  const t = timerFixture();
  const s = socketsFixture();
  const gateway = discordPresence(s.open, "test-token", t.timers, undefined, { messageContent: true, random: () => 0.5, log: () => {} });
  cleanups.push(() => gateway.close());
  s.socket().receive(hello);
  s.socket().receive(ready);
  t.fire(22_500);
  expect(s.socket().sent.at(-1)).toEqual({ op: 1, d: 1 });
  t.fire(45_000);
  expect(gateway.healthy).toBe(false);
  expect(s.socket().closed()).toBe(true);
  t.fire(1_000);
  expect(s.urls.at(-1)).toBe("wss://resume.example/?v=10&encoding=json");
  s.socket().receive(hello);
  expect(s.socket().sent[0]).toEqual({ op: 6, d: { token: "test-token", session_id: "session", seq: 1 } });
  gateway.close();
  expect(t.live.size).toBe(0);
});

test("unavailable connections back off without throwing and close cancels reconnect", () => {
  const t = timerFixture();
  let attempts = 0;
  const gateway = discordPresence(() => { attempts++; throw new Error("offline"); }, "test-token", t.timers, undefined, { log: () => {} });
  cleanups.push(() => gateway.close());
  expect(attempts).toBe(1);
  t.fire(1_000);
  expect(attempts).toBe(2);
  t.fire(2_000);
  expect(attempts).toBe(3);
  gateway.close();
  t.fire(4_000);
  expect(attempts).toBe(3);
  expect(t.live.size).toBe(0);
});

test("invalid sessions reidentify and heartbeat ACK keeps a ready connection alive", () => {
  const t = timerFixture();
  const s = socketsFixture();
  const gateway = discordPresence(s.open, "test-token", t.timers, undefined, { messageContent: true, random: () => 0.5, log: () => {} });
  cleanups.push(() => gateway.close());
  s.socket().receive(hello);
  s.socket().receive(ready);
  t.fire(22_500);
  s.socket().receive({ op: 11, d: null });
  t.fire(45_000);
  expect(s.sockets).toHaveLength(1);
  s.socket().receive({ op: 9, d: false });
  t.fire(1_000);
  s.socket().receive(hello);
  expect(s.socket().sent[0]?.op).toBe(2);
});

test("a gateway handshake timeout and socket error each leave exactly one reconnect timer", () => {
  const t = timerFixture();
  const s = socketsFixture();
  const gateway = discordPresence(s.open, "test-token", t.timers, undefined, { log: () => {} });
  cleanups.push(() => gateway.close());
  t.fire(30_000);
  expect(s.socket().closed()).toBe(true);
  expect(t.live.size).toBe(1);
  t.fire(1_000);
  s.socket().error();
  s.socket().disconnect(1006);
  expect(t.live.size).toBe(1);
  t.fire(2_000);
  expect(s.sockets).toHaveLength(3);
});

test("4014 warns once, drops the privileged intent and retains quota handling without crashing", async () => {
  const t = timerFixture();
  const s = socketsFixture();
  const logs: string[] = [];
  const requests: HttpRequest[] = [];
  const done = Promise.withResolvers<void>();
  const http: Http = async (request) => {
    requests.push(request);
    if (request.method === "PATCH") done.resolve();
    return { status: 200, headers: {}, body: "{}" };
  };
  const commands = new DiscordCommands(http, "test-token", { applicationId: "1", guildId: "2", ownerId: "300" }, async () => "99%");
  const gateway = discordPresence(s.open, "test-token", t.timers, (data) => commands.handle(data), { messageContent: true, log: (line) => logs.push(line) });
  cleanups.push(() => gateway.close());
  s.socket().receive(hello);
  s.socket().disconnect(4014);
  t.fire(1_000);
  s.socket().receive(hello);
  s.socket().receive(ready);
  expect(s.socket().sent[0]).toMatchObject({ op: 2, d: { intents: 513 } });
  expect(gateway.healthy).toBe(false);
  s.socket().receive({ op: 0, t: "INTERACTION_CREATE", s: 2, d: {
    type: 2, id: "4", token: "interaction", application_id: "1", guild_id: "2",
    data: { type: 1, name: "quota" }, member: { user: { id: "300" } },
  } });
  await done.promise;
  expect(requests.map((request) => request.method)).toEqual(["POST", "PATCH"]);
  s.socket().disconnect(4014);
  t.fire(1_000);
  expect(logs.filter((line) => line.includes("Message Content Intent"))).toHaveLength(1);
});

const inboundFixture = (patch: Partial<DoriConfig> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const t = timerFixture();
  const s = socketsFixture();
  const clock = fakeClock(0);
  const deps = depsFor(newWorld(), clock, state.dir, {
    discord: { applicationId: "1", guildId: "2", ownerId: "300" }, discordChannels: ["100"], ...patch,
  });
  const logs: string[] = [];
  const supervisor = new Supervisor(deps);
  let batch = [rawMessage("10")];
  const batches = new Map<string, unknown[]>();
  const channelObjects = new Map<string, unknown>();
  let active: unknown[] = [];
  const listed: string[] = [];
  const emitted = new Map<string, string>();
  const waiters = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const waitFor = (id: string): Promise<void> => {
    if (emitted.has(id)) return Promise.resolve();
    const event = Promise.withResolvers<void>();
    waiters.set(id, event);
    return event.promise;
  };
  const delivered = Promise.withResolvers<void>();
  const http: Http = async (request) => {
    if (request.method === "GET") {
      listed.push(request.url);
      const path = new URL(request.url).pathname.replace(/^\/api\/v10/, "");
      if (path === "/guilds/2/threads/active") return { status: 200, headers: {}, body: JSON.stringify({ threads: active, members: [] }) };
      const lookup = /^\/channels\/(\d+)$/.exec(path)?.[1];
      if (lookup) {
        const found = channelObjects.get(lookup);
        return found ? { status: 200, headers: {}, body: JSON.stringify(found) } : { status: 404, headers: {}, body: '{"message":"Unknown Channel"}' };
      }
      const channel = /^\/channels\/(\d+)\/messages$/.exec(path)?.[1] ?? "";
      return { status: 200, headers: {}, body: JSON.stringify(batches.get(channel) ?? batch) };
    }
    return { status: 200, headers: {}, body: "{}" };
  };
  const inbound = supervisorDiscord(deps, {
    token: "test-token", http, open: s.open, timers: t.timers, lookup: async () => "",
    emit: async (id, line) => { supervisor.enqueue(id, line); emitted.set(id, line); waiters.get(id)?.resolve(); delivered.resolve(); }, log: (line) => { logs.push(line); },
  });
  cleanups.push(() => inbound.close());
  return {
    ...state, ...s, t, clock, deps, inbound, listed, emitted, delivered, waitFor, logs,
    batch: (value: typeof batch) => { batch = value; },
    batches, channelObjects,
    active: (value: unknown[]) => { active = value; },
    queue: () => readJournal(state.dir),
  };
};

test("MESSAGE_CREATE and REST catch-up dedupe owner inbound while filtering foreign channels and bots", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  f.batch([rawMessage("11"), rawMessage("10")]);
  f.socket().receive(hello);
  f.socket().receive(ready);
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: rawMessage("11") });
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: rawMessage("12", "999") });
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: rawMessage("13", "100", { id: "301", username: "Guest" }) });
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: { ...rawMessage("14"), author: { ...owner, bot: true } } });
  const received = f.waitFor("discord:100:15");
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 6, d: rawMessage("15") });
  await received;
  await f.inbound.tick();
  await f.inbound.close();
  expect([...f.emitted.keys()].sort()).toEqual(["discord:100:10", "discord:100:11", "discord:100:13", "discord:100:15"]);
  expect(f.emitted.get("discord:100:13")).toStartWith("VISITOR 100 13 Guest (not the owner;");
  const queue = f.queue();
  expect(queue.events.filter((event: { id: string }) => event.id === "discord:100:11")).toHaveLength(1);
});

test("reconnect gap fill does not skip a missing older message after newer gateway delivery", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  f.socket().receive(hello);
  f.socket().receive(ready);
  await f.inbound.tick();
  const newer = f.waitFor("discord:100:13");
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: rawMessage("13") });
  await newer;
  f.socket().disconnect(1006);
  f.batch([rawMessage("13"), rawMessage("12"), rawMessage("11"), rawMessage("10")]);
  f.t.fire(1_000);
  f.socket().receive(hello);
  const gapDelivered = f.waitFor("discord:100:12");
  f.socket().receive({ op: 0, t: "RESUMED", s: 2, d: {} });
  await gapDelivered;
  await f.inbound.close();
  expect([...f.emitted.keys()].sort()).toEqual(["discord:100:10", "discord:100:11", "discord:100:12", "discord:100:13"]);
  expect(JSON.parse(readFileSync(join(f.dir, "discord-inbound.json"), "utf8"))).toEqual({ "100": "13", threadsSince: "0" });
});

test("healthy gateway uses the slow interval and disconnected or degraded gateway falls back to five seconds", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  f.socket().receive(hello);
  f.socket().receive(ready);
  // Await the exact next catch-up emission instead of wall-clock timing.
  f.batch([rawMessage("11")]);
  f.clock.at = 300_000;
  await f.inbound.tick();
  const healthyCount = f.listed.length;
  f.clock.at += 5_000;
  await f.inbound.tick();
  expect(f.listed).toHaveLength(healthyCount);
  f.socket().disconnect(4014);
  await f.inbound.tick();
  expect(f.listed.length).toBeGreaterThan(healthyCount);
});

test("a newly watched lane thread is caught up and receives gateway inbound without restarting", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  await f.deps.registry.write({
    key: "new", title: "new", thread: "discord:100/200", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status: "working",
  });
  f.socket().receive(hello);
  f.socket().receive(ready);
  const received = f.waitFor("discord:200:20");
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: rawMessage("20", "200") });
  await received;
  await f.inbound.tick();
  expect(f.listed.some((url) => url.includes("/channels/200/"))).toBe(true);
  expect(f.emitted.get("discord:200:20")).toBe("INBOUND 200 20 Owner message 20");
});

const thread = (id: string, parent_id = "100", archived = false) => ({
  id, type: 11, parent_id, guild_id: "2", thread_metadata: { archived, locked: false },
});
const lookups = (f: { listed: string[] }, id: string) => f.listed.filter((url) => url.endsWith(`/channels/${id}`)).length;

test("MESSAGE_CREATE in any thread under a watched channel is inbound, parents from thread events or one cached lookup", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  f.channelObjects.set("203", thread("203"));
  f.channelObjects.set("999", { id: "999", type: 0, parent_id: "555" });
  f.channelObjects.set("207", thread("207", "999"));
  f.socket().receive(hello);
  f.socket().receive(ready);
  f.socket().receive({ op: 0, t: "GUILD_CREATE", s: 2, d: { id: "2", threads: [thread("201"), thread("202", "999")] } });
  f.socket().receive({ op: 0, t: "THREAD_CREATE", s: 3, d: thread("204") });
  f.socket().receive({ op: 0, t: "THREAD_LIST_SYNC", s: 4, d: { guild_id: "2", threads: [thread("206")] } });
  let s = 5;
  const send = (d: unknown) => f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: s++, d });
  send(rawMessage("21", "201"));
  send(rawMessage("22", "201", { id: "301", username: "Guest" }));
  send({ ...rawMessage("23", "201"), author: { ...owner, bot: true } });
  send(rawMessage("24", "202"));
  send(rawMessage("25", "203"));
  send(rawMessage("26", "203"));
  send(rawMessage("27", "999"));
  send(rawMessage("28", "999"));
  send(rawMessage("29", "204"));
  send(rawMessage("30", "206"));
  send(rawMessage("31", "207"));
  send(rawMessage("32", "208"));
  // Handlers start in arrival order; once the last one delivers, every earlier one has started and close() settles them.
  const last = f.waitFor("discord:209:33");
  f.socket().receive({ op: 0, t: "THREAD_CREATE", s: s++, d: thread("209") });
  send(rawMessage("33", "209"));
  await last;
  await f.inbound.close();
  expect([...f.emitted.keys()].sort()).toEqual([
    "discord:100:10", "discord:201:21", "discord:201:22", "discord:203:25", "discord:203:26", "discord:204:29", "discord:206:30", "discord:209:33",
  ]);
  expect(f.emitted.get("discord:201:21")).toBe("INBOUND 201 21 Owner message 21");
  // Thread events and REST-known threads need no lookup; unknown ids are fetched once, including foreign and missing ones.
  expect(["201", "202", "204", "206"].map((id) => lookups(f, id))).toEqual([0, 0, 0, 0]);
  expect(["203", "999", "207", "208"].map((id) => lookups(f, id))).toEqual([1, 1, 1, 1]);
});

test("an archived thread the owner reopens by posting reaches the lead over the gateway and REST catch-up", async () => {
  const f = inboundFixture();
  const start = 1_800_000_000_000;
  f.clock.at = start;
  await f.inbound.tick();
  const floor = discordSnowflakeAt(start);
  expect(JSON.parse(readFileSync(join(f.dir, "discord-inbound.json"), "utf8"))).toMatchObject({ threadsSince: floor });

  // Gateway: the lead archived 205; the owner's post unarchives it (THREAD_UPDATE) and arrives as MESSAGE_CREATE.
  f.socket().receive(hello);
  f.socket().receive(ready);
  f.socket().receive({ op: 0, t: "THREAD_UPDATE", s: 2, d: thread("205", "100", true) });
  const later = discordSnowflakeAt(start + 60_000);
  f.socket().receive({ op: 0, t: "THREAD_UPDATE", s: 3, d: thread("205") });
  const reopened = f.waitFor(`discord:205:${later}`);
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: rawMessage(later, "205") });
  await reopened;
  // An archived thread unknown to the cache (not in GUILD_CREATE) resolves through GET /channels.
  f.channelObjects.set("209", thread("209", "100", true));
  const unknown = f.waitFor(`discord:209:${later}`);
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: rawMessage(later, "209") });
  await unknown;
  // Settle the READY catch-up so the next tick starts a fresh one.
  await f.inbound.tick();

  // REST: with the gateway down, the reopened thread shows up in threads/active; only posts after the floor import.
  f.socket().disconnect(1006);
  const missed = discordSnowflakeAt(start + 120_000);
  const old = String(BigInt(floor) - 1n);
  f.active([thread("205"), thread("210"), thread("211", "999")]);
  f.batches.set("205", [rawMessage(missed, "205"), rawMessage(later, "205"), rawMessage(old, "205")]);
  f.batches.set("210", [rawMessage(old, "210")]);
  f.batches.set("211", [rawMessage(missed, "211")]);
  const before = f.listed.length;
  f.clock.at = start + 180_000;
  await f.inbound.tick();
  const urls = f.listed.slice(before);
  expect(urls.filter((url) => url.endsWith("/guilds/2/threads/active"))).toHaveLength(1);
  expect(urls.some((url) => url.includes("/channels/211/"))).toBe(false);
  await f.inbound.close();
  expect(f.emitted.has(`discord:205:${missed}`)).toBe(true);
  expect([...f.emitted.keys()].filter((id) => id.includes(old))).toEqual([]);
  expect(f.queue().events.filter((event: { id: string }) => event.id === `discord:205:${later}`)).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.dir, "discord-inbound.json"), "utf8"))).toEqual({
    "100": "10", threadsSince: floor, "205": missed,
  });
});

test("token ownership rejects a second process before presence opens its gateway", async () => {
  const state = withState();
  cleanups.push(state.done);
  const lockDir = join(state.dir, ".dori", "gateway-locks");
  const release = acquireDiscordGateway("ownership-test", lockDir);
  try {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "presence", "discord"], {
      env: { ...process.env, HOME: state.dir, DORI_CONFIG: join(state.dir, "missing"), DORI_STATE_DIR: join(state.dir, "state"), DORI_DISCORD_TOKEN: "ownership-test" },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(out).not.toContain("PRESENCE_READY");
    expect(err).toContain("already owned");
    expect(err).not.toContain("ownership-test");
  } finally { release(); }
  const available = acquireDiscordGateway("ownership-test", lockDir);
  available();
});

test("token ownership is independent across bot tokens and shared across state directories", () => {
  const state = withState();
  cleanups.push(state.done);
  const release = acquireDiscordGateway("one", state.dir);
  try {
    expect(() => acquireDiscordGateway("one", state.dir)).toThrow("already owned");
    const other = acquireDiscordGateway("two", state.dir);
    other();
  } finally { release(); }
});

test("state() exposes the raw connection and Message Content request for the heartbeat file", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  expect(f.inbound.state()).toEqual({ connected: false, messageContent: true });
  f.socket().receive(hello);
  f.socket().receive(ready);
  expect(f.inbound.state()).toEqual({ connected: true, messageContent: true });
  f.socket().disconnect(1006);
  expect(f.inbound.state().connected).toBe(false);
});

const edited = (id: string, content: string, author: Record<string, unknown> = owner, edited_timestamp: unknown = "2026-10-22T01:00:00.000000+00:00") => ({
  ...rawMessage(id, "100", author as typeof owner), content, edited_timestamp,
});

test("item 1: an owner MESSAGE_UPDATE reaches the queue as a distinct INBOUND_EDIT; a tracked owner MESSAGE_DELETE as INBOUND_DELETE", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  f.socket().receive(hello);
  f.socket().receive(ready);
  const created = f.waitFor("discord:100:11");
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: rawMessage("11") });
  await created;
  f.socket().receive({ op: 0, t: "MESSAGE_UPDATE", s: 3, d: edited("12", "guest edit", { id: "301", username: "Guest" }) });
  f.socket().receive({ op: 0, t: "MESSAGE_UPDATE", s: 4, d: { id: "11", channel_id: "100", embeds: [{}] } });
  f.socket().receive({ op: 0, t: "MESSAGE_UPDATE", s: 5, d: { ...edited("11", "foreign"), channel_id: "999" } });
  const editKey = "discord:100:11:edit:2026-10-22T01:00:00.000000+00:00";
  const edit = f.waitFor(editKey);
  f.socket().receive({ op: 0, t: "MESSAGE_UPDATE", s: 6, d: edited("11", "deploy to staging, not prod") });
  await edit;
  f.socket().receive({ op: 0, t: "MESSAGE_DELETE", s: 7, d: { id: "77", channel_id: "100" } });
  const deleted = f.waitFor("discord:100:11:delete");
  f.socket().receive({ op: 0, t: "MESSAGE_DELETE", s: 8, d: { id: "11", channel_id: "100", guild_id: "2" } });
  await deleted;
  await f.inbound.close();
  expect(f.emitted.get(editKey)).toBe("INBOUND_EDIT 100 11 Owner (owner edited an earlier message; this text replaces it) deploy to staging, not prod");
  expect(f.emitted.get("discord:100:11:delete")).toStartWith("INBOUND_DELETE 100 11 (owner deleted");
  expect([...f.emitted.keys()].sort()).toEqual(["discord:100:10", "discord:100:11", "discord:100:11:delete", editKey]);
  expect(f.queue().events.map((event: { id: string }) => event.id)).toContain(editKey);
});

test("item 1: MESSAGE_UPDATE is dispatched only while Message Content is requested; MESSAGE_DELETE always", async () => {
  const t = timerFixture();
  const s = socketsFixture();
  const seen: string[] = [];
  const gateway = discordPresence(s.open, "test-token", t.timers, undefined, {
    messageContent: false, log: () => {},
    onMessageUpdate: async () => { seen.push("update"); },
    onMessageDelete: async () => { seen.push("delete"); },
  });
  cleanups.push(() => gateway.close());
  s.socket().receive(hello);
  s.socket().receive(ready);
  s.socket().receive({ op: 0, t: "MESSAGE_UPDATE", s: 2, d: edited("11", "x") });
  s.socket().receive({ op: 0, t: "MESSAGE_DELETE", s: 3, d: { id: "11", channel_id: "100" } });
  await gateway.settled();
  expect(seen).toEqual(["delete"]);
});

test("items 2 and 4: content-less owner messages warn once naming the intent; attachments-only pass; the bot's own id is dropped", async () => {
  const f = inboundFixture();
  await f.inbound.tick();
  f.socket().receive(hello);
  f.socket().receive({ ...ready, d: { ...ready.d, user: { id: "555", username: "Dori", bot: true } } });
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { ...rawMessage("20", "100", { id: "555", username: "Dori" }) } });
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { ...rawMessage("21"), content: "" } });
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { ...rawMessage("22"), content: "" } });
  const last = f.waitFor("discord:100:23");
  f.socket().receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: { ...rawMessage("23"), content: "", attachments: [
    { id: "9", filename: "voice-message.ogg", content_type: "audio/ogg", url: "https://cdn.discordapp.com/v.ogg" },
  ] } });
  await last;
  await f.inbound.close();
  expect(f.emitted.has("discord:100:20")).toBe(false);
  expect(f.emitted.get("discord:100:21")).toBe("INBOUND 100 21 Owner [content unavailable: Message Content intent missing]");
  expect(f.emitted.has("discord:100:22")).toBe(true);
  expect(f.emitted.get("discord:100:23")).toBe("INBOUND 100 23 Owner  [attachment name=voice-message.ogg type=audio/ogg url=https://cdn.discordapp.com/v.ogg]");
  expect(f.logs.filter((line) => line.includes("Message Content Intent"))).toHaveLength(1);
});

test("item 5: with discord.ownerId unset the supervisor warns and treats the would-be owner as a visitor", async () => {
  const f = inboundFixture({ discord: { applicationId: "1", guildId: "2", ownerId: "" } });
  await f.inbound.tick();
  await f.inbound.close();
  expect(f.logs.filter((line) => line.includes("ownerId is not configured"))).toHaveLength(1);
  expect(f.emitted.get("discord:100:10")).toStartWith("VISITOR 100 10 Owner (not the owner;");
});

test("item 6: first-seen REST catch-up uses discordFirstSeenLimit", async () => {
  const f = inboundFixture({ discordFirstSeenLimit: 40 });
  await f.inbound.tick();
  await f.inbound.close();
  expect(f.listed.filter((url) => url.includes("/channels/100/messages")).map((url) => new URL(url).searchParams.get("limit"))).toEqual(["40"]);
  expect(f.deps.config.discordFirstSeenLimit).toBe(40);
  const g = inboundFixture();
  await g.inbound.tick();
  await g.inbound.close();
  expect(g.listed.filter((url) => url.includes("/channels/100/messages")).map((url) => new URL(url).searchParams.get("limit"))).toEqual(["100"]);
});
