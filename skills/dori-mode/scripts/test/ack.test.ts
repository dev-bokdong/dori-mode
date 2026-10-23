import { afterEach, expect, test } from "bun:test";

import { ack, AckError, EYES_EMOJI, pendingAcks, recordHandled } from "../src/ack.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = (): string => {
  const s = withState();
  cleanups.push(s.done);
  return s.dir;
};

const reactions = (fail: { unreact?: Error; react?: Error } = {}) => {
  const ops: string[] = [];
  return {
    ops,
    react: async (channel: string, message: string, emoji: string) => { ops.push(`add ${channel}/${message} ${emoji}`); if (fail.react) throw fail.react; },
    unreact: async (channel: string, message: string, emoji: string) => { ops.push(`remove ${channel}/${message} ${emoji}`); if (fail.unreact) throw fail.unreact; },
  };
};

test("dori ack removes the hourglass, adds the eyes back to back, then records the ack", async () => {
  const dir = state();
  const r = reactions();
  await ack(dir, r, "11", "22", 1_000);
  expect(r.ops).toEqual(["remove 11/22 \u23F3", `add 11/22 ${EYES_EMOJI}`]);
  expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
});

test("a message without an hourglass (404) is still acked; any other removal failure is not", async () => {
  const dir = state();
  await ack(dir, reactions({ unreact: new MessengerError("discord DELETE: 404 Unknown Reaction", 404) }), "11", "22", 1_000);
  expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
  const other = state();
  const r = reactions({ unreact: new MessengerError("discord DELETE: 403 Missing Access", 403) });
  await expect(ack(other, r, "11", "23", 1_000)).rejects.toThrow("403");
  expect(r.ops).toEqual(["remove 11/23 \u23F3"]);
  expect(pendingAcks(other)).toEqual([]);
});

test("no eyes on the message means no ack: a failed reaction leaves it for the supervisor to remind", async () => {
  const dir = state();
  await expect(ack(dir, reactions({ react: new MessengerError("discord PUT: 500", 500) }), "11", "22", 1_000)).rejects.toThrow("500");
  expect(pendingAcks(dir)).toEqual([]);
});

test("ids must be Discord snowflakes", async () => {
  const dir = state();
  const r = reactions();
  await expect(ack(dir, r, "11", "../22", 1_000)).rejects.toBeInstanceOf(AckError);
  expect(r.ops).toEqual([]);
});

test("ack declares separate tasks without claiming any are handled", async () => {
  // Given a message containing two independent tasks.
  const dir = state();
  // When the lead acknowledges it with a task count.
  await ack(dir, reactions(), "11", "22", 1_000, 2);
  // Then the durable receipt carries the count, without invented coverage.
  expect(pendingAcks(dir)[0]).toMatchObject({ id: "discord:11:22", tasks: 2 });
  expect(pendingAcks(dir)[0]?.lanes).toBeUndefined();
  expect(pendingAcks(dir)[0]?.reply).toBeUndefined();
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("invalid task count %s fails before changing reactions", async (tasks) => {
  // Given an invalid owner-task declaration.
  const dir = state();
  const r = reactions();
  // When the lead tries to acknowledge it.
  await expect(ack(dir, r, "11", "22", 1_000, tasks)).rejects.toBeInstanceOf(AckError);
  // Then neither the read receipt nor reactions change.
  expect(r.ops).toEqual([]);
  expect(pendingAcks(dir)).toEqual([]);
});

test("handled requires explicit lane or reply coverage and validates ids", () => {
  // Given no durable receipt.
  const dir = state();
  // When invalid completion declarations are submitted.
  expect(() => recordHandled(dir, "11", "22", 1_000, {})).toThrow(AckError);
  expect(() => recordHandled(dir, "../11", "22", 1_000, { reply: true })).toThrow(AckError);
  expect(() => recordHandled(dir, "11", "22", 1_000, { lanes: ["../alpha"] })).toThrow(AckError);
  // Then none falsely mark the message handled.
  expect(pendingAcks(dir)).toEqual([]);
});
