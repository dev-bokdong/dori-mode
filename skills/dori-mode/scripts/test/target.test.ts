import { expect, test } from "bun:test";

import { resolveTarget } from "../src/messenger/target.ts";

test("discord: a lane ref resolves to its thread id, plain ids pass through", () => {
  expect(resolveTarget("discord", "discord:1100000000000000259/1200000000000000866")).toEqual({ to: "1200000000000000866" });
  expect(resolveTarget("discord", "discord:1100000000000000259")).toEqual({ to: "1100000000000000259" });
  expect(resolveTarget("discord", "1100000000000000259")).toEqual({ to: "1100000000000000259" });
  expect(resolveTarget("discord", "discord:1/2", "9")).toEqual({ to: "9" });
});

test("discord: a plain channel id with --thread posts to the thread, not the parent channel", () => {
  expect(resolveTarget("discord", "1100000000000000259", "1200000000000000866")).toEqual({ to: "1200000000000000866" });
});

test("telegram and slack: a ref splits into destination and thread", () => {
  expect(resolveTarget("telegram", "telegram:-100123/45")).toEqual({ to: "-100123", thread: "45" });
  expect(resolveTarget("telegram", "telegram:-100123")).toEqual({ to: "-100123" });
  expect(resolveTarget("slack", "slack:C0123/1700000000.000100")).toEqual({ to: "C0123", thread: "1700000000.000100" });
  expect(resolveTarget("slack", "slack:C0123/1.1", "2.2")).toEqual({ to: "C0123", thread: "2.2" });
  expect(resolveTarget("slack", "C0123", "2.2")).toEqual({ to: "C0123", thread: "2.2" });
});

test("a ref of another platform is left alone, an empty ref throws", () => {
  expect(resolveTarget("discord", "slack:C1/2")).toEqual({ to: "slack:C1/2" });
  expect(() => resolveTarget("discord", "discord:")).toThrow();
});
