import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordCommands, guildCommands, quotaMessage, type QuotaLookup } from "../src/messenger/discord-commands.ts";
import { discordPresence } from "../src/messenger/discord.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { withState } from "./fakes.ts";

const config = { applicationId: "100", guildId: "200", ownerId: "300" };
const interaction = {
  type: 2, id: "400", token: "interaction-secret", application_id: "100", guild_id: "200",
  data: { type: 1, name: "quota" }, member: { user: { id: "300" } },
};
const fixture = (lookup: QuotaLookup = async () => "99%", deadline?: () => AbortSignal) => {
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => {
    requests.push(req);
    return { status: 200, headers: {}, body: "{}" };
  };
  return { requests, commands: new DiscordCommands(http, "bot-secret", config, lookup, deadline) };
};
const payload = (req: HttpRequest | undefined): unknown => {
  if (typeof req?.body !== "string") throw new Error("Expected JSON request");
  return JSON.parse(req.body);
};

test("presence CLI warns once when slash-command config is absent before opening the gateway", async () => {
  const state = withState();
  try {
    const preload = join(state.dir, "gateway-stop.js");
    writeFileSync(preload, 'globalThis.WebSocket = class { constructor() { console.log("QA_GATEWAY_OPEN"); process.exit(0); } };');
    const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), "presence", "discord"], {
      env: { ...process.env, HOME: state.dir, DORI_CONFIG: join(state.dir, "missing.json"), DORI_STATE_DIR: state.dir, DORI_DISCORD_TOKEN: "fake-secret" },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("QA_GATEWAY_OPEN");
    expect(err.trim().split("\n").filter((line) => line.startsWith("PRESENCE_WARNING "))).toHaveLength(1);
    expect(err).toContain("config.discord");
    expect(out + err).not.toContain("fake-secret");
  } finally { state.done(); }
});

test("registration overwrites the configured guild list with exactly quota", async () => {
  // Given a configured guild and fake Discord HTTP.
  const { commands, requests } = fixture();
  // When presence startup registers commands.
  await commands.register();
  // Then the guild gets precisely the supported command list.
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: "PUT", url: "https://discord.com/api/v10/applications/100/guilds/200/commands", headers: { Authorization: "Bot bot-secret" } });
  expect(payload(requests[0])).toEqual(guildCommands);
});

test("the existing gateway defers an owner quota before lookup and edits the ephemeral original", async () => {
  // Given the presence socket and a lookup that records when its work starts.
  const order: string[] = [];
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => {
    order.push(req.method);
    requests.push(req);
    return { status: 200, headers: {}, body: "{}" };
  };
  const commands = new DiscordCommands(http, "bot-secret", config, async () => { order.push("lookup"); return "Weekly 92%"; });
  let onMessage: (raw: string) => void = () => {};
  let opened = 0;
  let closed = false;
  const done = Promise.withResolvers<void>();
  const presence = discordPresence(() => {
    opened++;
    return { send: () => {}, close: () => { closed = true; }, onMessage: (cb) => { onMessage = cb; } };
  }, "bot-secret", { setInterval: () => 0, clearInterval: () => {} }, async (data) => {
    try { await commands.handle(data); done.resolve(); } catch (error) { done.reject(error); }
  });
  // When Discord delivers quota through that same gateway.
  try {
    onMessage(JSON.stringify({ op: 0, t: "INTERACTION_CREATE", s: 3, d: interaction }));
    await done.promise;
    // Then acknowledgement precedes lookup, and the original is edited without pings.
    expect(opened).toBe(1);
    expect(order).toEqual(["POST", "lookup", "PATCH"]);
    expect(payload(requests[0])).toEqual({ type: 5, data: { flags: 64 } });
    expect(payload(requests[1])).toEqual({ content: "```\nWeekly 92%\n```", allowed_mentions: { parse: [] } });
    expect(requests[1]?.url).toBe("https://discord.com/api/v10/webhooks/100/interaction-secret/messages/@original");
  } finally {
    presence.close();
  }
  expect(closed).toBe(true);
});

test("lookup cannot start until the deferred acknowledgement is accepted", async () => {
  // Given a pending acknowledgement and a subscribed lookup-start signal.
  const ack = Promise.withResolvers<void>();
  let started = false;
  const http: Http = async () => { await ack.promise; return { status: 204, headers: {}, body: "" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => { started = true; return "99%"; });
  // When the interaction arrives while its acknowledgement is still pending.
  const pending = commands.handle(interaction);
  expect(started).toBe(false);
  ack.resolve();
  await pending;
  // Then the accepted acknowledgement releases lookup.
  expect(started).toBe(true);
});

test("a non-owner receives an ephemeral refusal and never reads credentials", async () => {
  // Given another guild member.
  let lookups = 0;
  const { commands, requests } = fixture(async () => { lookups++; return "private"; });
  // When they invoke quota.
  await commands.handle({ ...interaction, member: { user: { id: "999" } } });
  // Then one immediate private refusal is the only effect.
  expect(lookups).toBe(0);
  expect(requests).toHaveLength(1);
  expect(payload(requests[0])).toMatchObject({ type: 4, data: { flags: 64 } });
});

const channelFixture = (channels: readonly string[]) => {
  const requests: HttpRequest[] = [];
  let lookups = 0;
  const http: Http = async (req) => { requests.push(req); return { status: 200, headers: {}, body: "{}" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => { lookups++; return "99%"; }, undefined, channels);
  return { requests, commands, lookups: () => lookups };
};

test("an owned channel gets the normal deferred quota", async () => {
  const { commands, requests, lookups } = channelFixture(["500"]);
  await commands.handle({ ...interaction, channel_id: "500" });
  expect(lookups()).toBe(1);
  expect(payload(requests[0])).toEqual({ type: 5, data: { flags: 64 } });
});

test("a thread under an owned channel is owned through parent_id", async () => {
  const { commands, requests, lookups } = channelFixture(["500"]);
  await commands.handle({ ...interaction, channel_id: "777", channel: { parent_id: "500" } });
  expect(lookups()).toBe(1);
  expect(payload(requests[0])).toEqual({ type: 5, data: { flags: 64 } });
});

test("a foreign channel is refused ephemerally without a lookup", async () => {
  const { commands, requests, lookups } = channelFixture(["500"]);
  await commands.handle({ ...interaction, channel_id: "999", channel: { parent_id: "998" } });
  expect(lookups()).toBe(0);
  expect(requests).toHaveLength(1);
  expect(payload(requests[0])).toMatchObject({ type: 4, data: { flags: 64, content: expect.stringContaining("/quota") } });
});

test("an empty channel list keeps answering everywhere", async () => {
  const { commands, lookups } = channelFixture([]);
  await commands.handle({ ...interaction, channel_id: "999" });
  expect(lookups()).toBe(1);
});

test("wrong guilds, applications, commands and malformed payloads are ignored", async () => {
  // Given valid configuration.
  const { commands, requests } = fixture();
  // When out-of-scope or invalid gateway events arrive.
  for (const value of [null, {}, { ...interaction, guild_id: "999" }, { ...interaction, application_id: "999" }, { ...interaction, data: { type: 1, name: "other" } }, { ...interaction, member: {} }, { ...interaction, type: 3 }]) {
    await commands.handle(value);
  }
  // Then no interaction is acknowledged or credential read.
  expect(requests).toHaveLength(0);
});

test("a lookup exception becomes a short response without its secret error material", async () => {
  // Given a provider that throws sensitive diagnostics.
  const { commands, requests } = fixture(async () => { throw new Error("sk-secret refresh-token bot-secret"); });
  // When the owner invokes quota.
  await commands.handle(interaction);
  // Then only the generic response reaches Discord.
  expect(payload(requests[1])).toEqual({ content: "Quota lookup failed. Try again.", allowed_mentions: { parse: [] } });
});

test("a deadline abort settles the response even when lookup ignores cancellation", async () => {
  // Given an injectable deadline and a lookup that never settles.
  const controller = new AbortController();
  const { commands, requests } = fixture(async () => {
    controller.abort(new Error("private-timeout-detail"));
    return new Promise<string>(() => {});
  }, () => controller.signal);
  // When that deadline fires during lookup.
  await commands.handle(interaction);
  // Then the deferred original is completed with a timeout, not left pending.
  expect(payload(requests[1])).toEqual({ content: "Quota lookup timed out. Try again.", allowed_mentions: { parse: [] } });
});

test("quota output is a closed length-safe code block with escaped labels and no ANSI", () => {
  // Given adversarial labels, control characters and a long Unicode result.
  const text = "\u001b[97m```@everyone\u0000" + "😀".repeat(3000);
  // When formatting for Discord.
  const message = quotaMessage(text);
  // Then it stays within 2000 UTF-16 units and cannot escape the fence.
  expect(message.length).toBeLessThanOrEqual(2000);
  expect(message.split("```")).toHaveLength(3);
  expect(message).not.toContain("\u001b");
  expect(message).not.toContain("\u0000");
  expect(message).toEndWith("\n```");
  expect(message).toContain("[truncated]");
});

test("empty lookup output still completes the deferred response", async () => {
  // Given no authenticated subscription providers.
  const { commands, requests } = fixture(async () => "");
  // When the owner invokes quota.
  await commands.handle(interaction);
  // Then there is a nonempty code-block response rather than a stuck spinner.
  expect(payload(requests[1])).toEqual({ content: "```\nNo subscription quota is configured.\n```", allowed_mentions: { parse: [] } });
});

test("registration rejects invalid IDs before writing to any Discord endpoint", async () => {
  // Given an invalid guild target.
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => { requests.push(req); return { status: 200, headers: {}, body: "{}" }; };
  const commands = new DiscordCommands(http, "bot", { ...config, guildId: "../other" }, async () => "");
  // When presence startup tries to register.
  await expect(commands.register()).rejects.toThrow("IDs must be configured");
  // Then no command list is changed.
  expect(requests).toHaveLength(0);
});

const statusInteraction = { ...interaction, data: { type: 1, name: "status" } };
const statusFixture = (channels: readonly string[] = []) => {
  const requests: HttpRequest[] = [];
  const looked: string[] = [];
  const http: Http = async (req) => { requests.push(req); return { status: 200, headers: {}, body: "{}" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => { looked.push("quota"); return "99%"; }, undefined, channels, async () => { looked.push("status"); return "DORI STATUS\nlead: warm"; });
  return { requests, looked, commands };
};

test("guild registration lists quota, status and emergency", () => {
  expect(guildCommands.map((c) => c.name)).toEqual(["quota", "status", "emergency"]);
});

test("/status from the owner defers ephemerally, runs only the status lookup and edits in a code block", async () => {
  const { commands, requests, looked } = statusFixture(["500"]);
  await commands.handle({ ...statusInteraction, channel_id: "500" });
  expect(looked).toEqual(["status"]);
  expect(payload(requests[0])).toEqual({ type: 5, data: { flags: 64 } });
  expect(payload(requests[1])).toEqual({ content: "```\nDORI STATUS\nlead: warm\n```", allowed_mentions: { parse: [] } });
});

test("/status registers an optional page option and hands its value to the status lookup, page 1 without it", async () => {
  expect(guildCommands.find((c) => c.name === "status")).toMatchObject({ options: [{ type: 4, name: "page", required: false, min_value: 1 }] });
  const pages: number[] = [];
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => { requests.push(req); return { status: 200, headers: {}, body: "{}" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => "q", undefined, [], async (_signal, page) => { pages.push(page); return `page ${page}`; });
  await commands.handle({ ...statusInteraction, data: { ...statusInteraction.data, options: [{ type: 4, name: "page", value: 3 }] } });
  await commands.handle(statusInteraction);
  await commands.handle({ ...statusInteraction, data: { ...statusInteraction.data, options: [{ type: 4, name: "page", value: "x" }] } });
  expect(pages).toEqual([3, 1, 1]);
  expect(payload(requests[1])).toMatchObject({ content: "```\npage 3\n```" });
});

test("/status from a non-owner gets the private refusal and never runs the lookup", async () => {
  const { commands, requests, looked } = statusFixture();
  await commands.handle({ ...statusInteraction, member: { user: { id: "999" } } });
  expect(looked).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(payload(requests[0])).toMatchObject({ type: 4, data: { flags: 64, content: "This command is only available to the owner." } });
});

test("/status in another Dori's channel is redirected naming /status, with no lookup", async () => {
  const { commands, requests, looked } = statusFixture(["500"]);
  await commands.handle({ ...statusInteraction, channel_id: "900" });
  expect(looked).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(payload(requests[0])).toMatchObject({ type: 4, data: { flags: 64 } });
  expect(JSON.stringify(payload(requests[0]))).toContain("/status");
});

test("without a status lookup /status is ignored, and a failing lookup reports Status, not Quota", async () => {
  const bare = fixture();
  await bare.commands.handle(statusInteraction);
  expect(bare.requests).toHaveLength(0);
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => { requests.push(req); return { status: 200, headers: {}, body: "{}" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => "q", undefined, [], async () => { throw new Error("boom"); });
  await commands.handle(statusInteraction);
  expect(payload(requests[1])).toMatchObject({ content: "Status lookup failed. Try again." });
});
