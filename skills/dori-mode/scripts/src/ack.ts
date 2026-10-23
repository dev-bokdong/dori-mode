import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { COLD_START_EMOJI } from "./supervise.ts";
import { MessengerError } from "./messenger/http.ts";

/** The lead's read receipt, the one reaction it puts on an owner message. */
export const EYES_EMOJI = "\u{1F440}";

const DISCORD_ID = /^\d+$/;
const ACK_FILE = /^(\d+)-(\d+)(?:-[\w-]+)?\.json$/;

const ackDir = (stateDir: string): string => join(stateDir, "acks");

export class AckError extends Error {}

export type MessageCoverage = {
  readonly tasks?: number;
  readonly lanes?: readonly string[];
  readonly reply?: boolean;
};

export const checkTasks = (tasks: number | undefined): void => {
  if (tasks !== undefined && (!Number.isSafeInteger(tasks) || tasks < 1)) throw new AckError("--tasks must be a positive integer");
};

export type AckReactions = {
  readonly react: (channel: string, message: string, emoji: string) => Promise<void>;
  readonly unreact: (channel: string, message: string, emoji: string) => Promise<void>;
};

/**
 * The lead's read receipt for one owner message: the handed-over hourglass comes off and the eyes go on back to back,
 * then the ack is recorded for the supervisor. It is recorded only once the eyes are really on the message, so a
 * failed reaction leaves the message unacked and the supervisor keeps reminding.
 */
export const ack = async (stateDir: string, discord: AckReactions, channel: string, message: string, now: number, tasks?: number): Promise<void> => {
  if (!DISCORD_ID.test(channel) || !DISCORD_ID.test(message)) throw new AckError("usage: dori ack <channel> <messageId> (Discord ids, digits only)");
  checkTasks(tasks);
  try { await discord.unreact(channel, message, COLD_START_EMOJI); }
  catch (e) {
    // No hourglass on the message (a warm delivery) is the normal case, not a failure.
    if (!(e instanceof MessengerError && e.status === 404)) throw e;
  }
  await discord.react(channel, message, EYES_EMOJI);
  recordAck(stateDir, channel, message, now, tasks);
};

/** Immutable receipts avoid a concurrent supervisor consuming a newer lead update by unlinking an older one. */
const recordReceipt = (stateDir: string, channel: string, message: string, at: number, coverage: MessageCoverage): void => {
  if (!DISCORD_ID.test(channel) || !DISCORD_ID.test(message)) throw new AckError("channel and message must be Discord ids, digits only");
  checkTasks(coverage.tasks);
  const dir = ackDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${channel}-${message}-${randomUUID()}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ channel, message, at, ...coverage }), { mode: 0o600, flush: true });
  renameSync(tmp, path);
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(stateDir, "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
};

export const recordAck = (stateDir: string, channel: string, message: string, at: number, tasks?: number): void =>
  recordReceipt(stateDir, channel, message, at, { tasks });

/** Each distinct lane and the optional reply cover one declared task; replaying the same link never adds coverage. */
export const recordHandled = (stateDir: string, channel: string, message: string, at: number, coverage: MessageCoverage): void => {
  if (!coverage.lanes?.length && !coverage.reply) throw new AckError("handled needs --lane <key> and/or --reply");
  if (coverage.lanes?.some((lane) => !/^[\w.-]+$/.test(lane))) throw new AckError("--lane must name a lane key");
  recordReceipt(stateDir, channel, message, at, coverage);
};

/** Acks waiting for the supervisor, as inbound ids (discord:<channel>:<message>) with their file paths and ack times. */
export const pendingAcks = (stateDir: string): (MessageCoverage & { readonly id: string; readonly path: string; readonly at: number })[] => {
  let names: string[];
  try { names = readdirSync(ackDir(stateDir)); } catch { return []; }
  return names.flatMap((name) => {
    const m = ACK_FILE.exec(name);
    if (!m) return [];
    const path = join(ackDir(stateDir), name);
    try {
      const { at, tasks, lanes, reply } = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown; tasks?: unknown; lanes?: unknown; reply?: unknown };
      if (tasks !== undefined && (typeof tasks !== "number" || !Number.isSafeInteger(tasks) || tasks < 1)) return [];
      if (lanes !== undefined && (!Array.isArray(lanes) || !lanes.every((lane): lane is string => typeof lane === "string" && /^[\w.-]+$/.test(lane)))) return [];
      return [{
        id: `discord:${m[1]}:${m[2]}`, path, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs,
        ...(typeof tasks === "number" ? { tasks } : {}),
        ...(Array.isArray(lanes) ? { lanes } : {}),
        ...(reply === true ? { reply: true } : {}),
      }];
    } catch { return []; }
  });
};

export const dropAck = (path: string): void => {
  try { unlinkSync(path); } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
};
