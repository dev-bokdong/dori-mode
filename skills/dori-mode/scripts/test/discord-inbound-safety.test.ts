import { afterEach, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  discordAttachments, discordThreadFloor, emitDiscordDelete, emitDiscordEdit, emitDiscordInbound, listDiscordInbound,
  MISSING_CONTENT_NOTE, pollDiscordInbound,
} from "../src/messenger/discord-inbound.ts";
import { Discord, DISCORD_MESSAGE_LIMIT, splitDiscordMessage } from "../src/messenger/discord.ts";
import type { HttpRequest } from "../src/messenger/http.ts";
import type { Runner } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const collect = () => {
  const emitted: [string, string][] = [];
  return { emitted, emit: async (id: string, line: string) => { emitted.push([id, line]); } };
};
const noRun: Runner = async () => ({ code: 1, out: "", err: "unused" });
const owner = (id: string, patch: Record<string, unknown> = {}) => ({ id, author: "Owner", authorId: "300", content: `message ${id}`, attachments: [], ...patch });

test("item 3: each attachment carries filename, content type and URL", async () => {
  const c = collect();
  const voice = { id: "1", filename: "voice-message.ogg", content_type: "audio/ogg", url: "https://cdn.discordapp.com/a/voice-message.ogg", size: 9 };
  const shot = { id: "2", filename: "my screen shot.png", content_type: "image/png", url: "https://cdn.discordapp.com/a/shot.png" };
  await emitDiscordInbound("100", owner("11", { content: "see", attachments: [voice, shot] }), c.emit, "300");
  expect(c.emitted).toEqual([["discord:100:11",
    "INBOUND 100 11 Owner see [attachment name=voice-message.ogg type=audio/ogg url=https://cdn.discordapp.com/a/voice-message.ogg]"
    + " [attachment name=my_screen_shot.png type=image/png url=https://cdn.discordapp.com/a/shot.png]"]]);
  expect(discordAttachments([{ proxy_url: "https://media/x" }, "junk"])).toBe(
    " [attachment name=unnamed type=unknown url=https://media/x] [attachment name=unnamed type=unknown url=none]");
});

test("item 4: the bot is dropped by author.bot or its user id, never by display name", async () => {
  const c = collect();
  await emitDiscordInbound("100", owner("11", { author: "Dori" }), c.emit, "300", { botId: "999" });
  await emitDiscordInbound("100", owner("12", { author: "Dori", authorId: "999" }), c.emit, "300", { botId: "999" });
  await emitDiscordInbound("100", owner("13", { author: "Helper", authorId: "301", bot: true }), c.emit, "300");
  expect(c.emitted).toEqual([["discord:100:11", "INBOUND 100 11 Dori message 11"]]);
});

test("item 5: with ownerId unset or blank no one is the owner", async () => {
  for (const ownerId of [undefined, "", "not-a-snowflake"]) {
    const c = collect();
    const owners: string[] = [];
    await emitDiscordInbound("100", owner("11"), c.emit, ownerId, { onOwner: (_ch, id) => owners.push(id) });
    expect(c.emitted[0]?.[1]).toStartWith("VISITOR 100 11 Owner (not the owner;");
    expect(owners).toEqual([]);
  }
});

test("item 2: content-less messages are forwarded marked and reported; attachments-only messages are not", async () => {
  const c = collect();
  let missing = 0;
  const options = { onMissingContent: () => { missing++; } };
  await emitDiscordInbound("100", owner("11", { content: "" }), c.emit, "300", options);
  await emitDiscordInbound("100", owner("12", { content: "  ", attachments: [{ filename: "a.png", content_type: "image/png", url: "https://x/a.png" }] }), c.emit, "300", options);
  expect(c.emitted).toEqual([
    ["discord:100:11", `INBOUND 100 11 Owner ${MISSING_CONTENT_NOTE}`],
    ["discord:100:12", "INBOUND 100 12 Owner  [attachment name=a.png type=image/png url=https://x/a.png]"],
  ]);
  expect(missing).toBe(1);
});

test("item 1: owner edits become distinct INBOUND_EDIT events, others and partial updates are ignored; deletes are marked", async () => {
  const c = collect();
  const edit = (id: string, author: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
    id, channel_id: "100", author, content: "new\n text", attachments: [], edited_timestamp: "2026-10-22T01:00:00.000000+00:00", ...patch,
  });
  expect(await emitDiscordEdit("100", edit("11", { id: "300", username: "Owner" }), c.emit, "300")).toBe(true);
  expect(await emitDiscordEdit("100", edit("11", { id: "300", username: "Owner" }, { edited_timestamp: "2026-10-22T02:00:00.000000+00:00", content: "third" }), c.emit, "300")).toBe(true);
  expect(await emitDiscordEdit("100", edit("12", { id: "301", username: "Guest" }), c.emit, "300")).toBe(false);
  expect(await emitDiscordEdit("100", edit("13", { id: "300", username: "Owner" }, { edited_timestamp: null }), c.emit, "300")).toBe(false);
  expect(await emitDiscordEdit("100", { id: "14", channel_id: "100", embeds: [] }, c.emit, "300")).toBe(false);
  expect(await emitDiscordEdit("100", edit("15", { id: "300", username: "Owner", bot: true }), c.emit, "300")).toBe(false);
  expect(await emitDiscordEdit("100", edit("16", { id: "300", username: "Owner" }), c.emit, undefined)).toBe(false);
  await emitDiscordDelete("100", "11", c.emit);
  expect(c.emitted).toEqual([
    ["discord:100:11:edit:2026-10-22T01:00:00.000000+00:00", "INBOUND_EDIT 100 11 Owner (owner edited an earlier message; this text replaces it) new text"],
    ["discord:100:11:edit:2026-10-22T02:00:00.000000+00:00", "INBOUND_EDIT 100 11 Owner (owner edited an earlier message; this text replaces it) third"],
    ["discord:100:11:delete", "INBOUND_DELETE 100 11 (owner deleted an earlier message; disregard it unless already acted on)"],
  ]);
});

test("item 6: first sight fetches one page of up to 100 by default, configurable and clamped", async () => {
  const urls: string[] = [];
  const discord = new Discord(async (request) => { urls.push(request.url); return { status: 200, headers: {}, body: "[]" }; }, fakeClock(0), "t");
  await listDiscordInbound(discord, "100");
  await listDiscordInbound(discord, "100", undefined, 40);
  await listDiscordInbound(discord, "100", undefined, 500);
  await listDiscordInbound(discord, "100", undefined, 0);
  await listDiscordInbound(discord, "100", "5", 40);
  expect(urls.map((url) => new URL(url).searchParams.get("limit"))).toEqual(["100", "40", "100", "100", "100"]);
});

test("item 7: cursor writes leave no temporary file and a corrupt file is quarantined for the thread floor too", async () => {
  const state = withState();
  cleanups.push(state.done);
  const statePath = join(state.dir, "discord-inbound.json");
  const c = collect();
  await pollDiscordInbound(noRun, ["100"], statePath, c.emit, async () => [owner("11")], "300");
  expect(await readdir(state.dir)).toEqual(["discord-inbound.json"]);
  expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ "100": "11" });
  await writeFile(statePath, '{"100":');
  const logs: string[] = [];
  const floor = await discordThreadFloor(statePath, 1_420_070_400_000 + 1_000, (line) => logs.push(line));
  expect(floor).toBe(String(1_000n << 22n));
  expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ threadsSince: floor });
  const names = (await readdir(state.dir)).sort();
  expect(names).toHaveLength(2);
  expect(names[1]).toMatch(/^discord-inbound\.json\.corrupt-\d+$/);
  expect(logs.join("\n")).toContain("DISCORD_INBOUND_WARNING corrupt cursor file");
});

test("item 8: long text splits at newline, then space, then hard, every chunk within the limit", () => {
  expect(splitDiscordMessage("short")).toEqual(["short"]);
  expect(splitDiscordMessage("aaaa\nbbbb\ncccc", 10)).toEqual(["aaaa", "bbbb\ncccc"]);
  expect(splitDiscordMessage("aaaa bbbb cccc", 10)).toEqual(["aaaa", "bbbb cccc"]);
  expect(splitDiscordMessage("abcdefghijklmnop", 10)).toEqual(["abcdef", "ghijklmnop"]);
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = splitDiscordMessage(long);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
  expect(chunks.join("\n")).toBe(long);
});

test("item 8: a code fence cut by a split is closed and reopened with its language", () => {
  const body = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const text = `Intro\n\`\`\`ts\n${body}\n\`\`\`\nOutro`;
  const chunks = splitDiscordMessage(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
  }
  expect(chunks[1]).toStartWith("```ts\n");
  expect(chunks.at(-1)).toEndWith("```\nOutro");
  const restored = chunks.map((chunk, i) => {
    let value = chunk;
    if (i > 0) value = value.replace(/^```ts\n/, "");
    if (i < chunks.length - 1) value = value.replace(/\n```$/, "");
    return value;
  }).join("\n");
  expect(restored).toBe(text);
});

test("item 8: Discord.send posts ordered chunks and returns the first message id", async () => {
  const requests: HttpRequest[] = [];
  let next = 0;
  const discord = new Discord(async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: JSON.stringify({ id: String(++next) }) };
  }, fakeClock(0), "t");
  const text = `${"a".repeat(1500)}\n${"b".repeat(1500)}\n${"c".repeat(10)}`;
  expect(await discord.send("100", text)).toBe("1");
  const contents = requests.map((request) => (JSON.parse(String(request.body ?? "{}")) as { content: string }).content);
  expect(contents).toEqual(["a".repeat(1500), `${"b".repeat(1500)}\n${"c".repeat(10)}`]);
  expect(await discord.send("100", "hi")).toBe("3");
});
