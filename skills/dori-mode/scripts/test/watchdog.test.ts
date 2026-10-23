import { expect, test } from "bun:test";

import { Watchdog, WATCHDOG_STALL_MS } from "../src/supervise-loop.ts";

const setup = () => {
  const clock = { at: 1_800_000_000_000 };
  const sent: string[] = [];
  const watchdog = new Watchdog(() => clock.at, async (state) => { sent.push(state); return true; });
  return { clock, sent, watchdog };
};

const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = error; }
};

test("the watchdog is petted while the loop makes progress, and withheld once it has not for the stall budget", async () => {
  const { clock, sent, watchdog } = setup();
  expect(await watchdog.pet()).toBe(true);
  clock.at += WATCHDOG_STALL_MS - 1;
  expect(await watchdog.pet()).toBe(true);
  clock.at += 1;
  expect(await quietly(() => watchdog.pet())).toBe(false);
  watchdog.progress();
  expect(await watchdog.pet()).toBe(true);
  expect(sent).toEqual(["WATCHDOG=1", "WATCHDOG=1", "WATCHDOG=1"]);
});

test("a stuck background task withholds the watchdog even while the loop keeps turning, until it settles", async () => {
  const { clock, sent, watchdog } = setup();
  let finish = () => {};
  const work = watchdog.track("delivery", new Promise<void>((resolve) => { finish = resolve; }));
  clock.at += WATCHDOG_STALL_MS;
  watchdog.progress();
  expect(watchdog.stalled()).toBe("delivery");
  expect(await quietly(() => watchdog.pet())).toBe(false);
  finish();
  await work;
  expect(await watchdog.pet()).toBe(true);
  expect(sent).toEqual(["WATCHDOG=1"]);
});
