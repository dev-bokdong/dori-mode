import { expect, test } from "bun:test";
import { join } from "node:path";

import { Registry } from "../src/registry.ts";
import { clearLaunchHold, launchHeld, launchQueue, recordLaunchVerdict } from "../src/routing.ts";
import { withState } from "./fakes.ts";

const worker = (mode: string, dir: string) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/concurrency-worker.ts"), mode, dir], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let buffer = "";
  const next = async (): Promise<string> => {
    const timeout = setTimeout(() => child.kill(), 5_000);
    try {
      while (!buffer.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`worker exited ${await child.exited}: ${await new Response(child.stderr).text()}`);
        buffer += new TextDecoder().decode(chunk.value);
      }
      const at = buffer.indexOf("\n");
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      return line;
    } finally { clearTimeout(timeout); }
  };
  return {
    child, next,
    release: () => { child.stdin.write("x"); child.stdin.flush(); },
    finish: async () => {
      expect(await next()).toBe("done");
      expect(await child.exited).toBe(0);
    },
  };
};

for (const mode of ["registry-holder", "registry-publication-holder"] as const) {
test(mode === "registry-holder"
  ? "subprocess registry race never steals a healthy lock older than sixty seconds"
  : "subprocess registry race cannot enter between lock creation and owner publication", async () => {
  // Given a live holder blocked inside its actual registry mutation.
  const state = withState();
  const registry = new Registry(state.dir);
  await registry.write({ key: "race-lane", title: "race", thread: "none", brief: "/b", done: "merged acme/app#1", openedAt: "2026-10-22T00:00:00Z", recoveryAttempts: 0 });
  const holder = worker(mode, state.dir);
  let contender: ReturnType<typeof worker> | undefined;
  try {
    expect(await holder.next()).toBe(mode === "registry-holder" ? "entered" : "published");
    // When another process tries to update with a clock beyond the old stale-age threshold.
    contender = worker("registry-contender", state.dir);
    const event = await contender.next();
    holder.release();
    if (mode === "registry-publication-holder") expect(await holder.next()).toBe("entered");
    await holder.finish();
    if (event === "waiting") { contender.release(); expect(await contender.next()).toBe("entered"); }
    await contender.finish();
    // Then contention, not entry, was observed before the holder released, and neither update was lost.
    expect(event).toBe("waiting");
    expect((await registry.read("race-lane"))?.recoveryAttempts).toBe(2);
  } finally {
    holder.child.kill();
    contender?.child.kill();
    await Promise.all([holder.child.exited, contender?.child.exited]);
    state.done();
  }
});
}

test("a killed subprocess releases its registry lock without stealing or deleting a successor lock", async () => {
  const state = withState();
  const registry = new Registry(state.dir);
  await registry.write({ key: "race-lane", title: "race", thread: "none", brief: "/b", done: "merged acme/app#1", openedAt: "2026-10-22T00:00:00Z", recoveryAttempts: 0 });
  const holder = worker("registry-holder", state.dir);
  let successor: ReturnType<typeof worker> | undefined;
  try {
    expect(await holder.next()).toBe("entered");
    holder.child.kill("SIGKILL");
    await holder.child.exited;
    successor = worker("registry-contender", state.dir);
    expect(await successor.next()).toBe("entered");
    await successor.finish();
    expect((await registry.read("race-lane"))?.recoveryAttempts).toBe(1);
  } finally {
    holder.child.kill();
    successor?.child.kill();
    await Promise.all([holder.child.exited, successor?.child.exited]);
    state.done();
  }
});

test("subprocess HOLD enqueues preserve both entries across a paused read-modify-write", async () => {
  // Given a first enqueue paused immediately after reading the queue.
  const state = withState();
  recordLaunchVerdict(state.dir, { ok: false, reasons: ["host full"] }, 1);
  const first = worker("hold-first", state.dir);
  let second: ReturnType<typeof worker> | undefined;
  try {
    expect(await first.next()).toBe("read");
    second = worker("hold-second", state.dir);
    // When the second enqueue reaches the lock (or, in the buggy code, reads stale state).
    const event = await second.next();
    if (event === "locking") {
      first.release();
      await first.finish();
      second.release();
      expect(await second.next()).toBe("read");
      second.release();
      await second.finish();
    } else {
      expect(event).toBe("read");
      second.release();
      await second.finish();
      first.release();
      await first.finish();
    }
    // Then both held launches are durable and the host remains blocked.
    expect(launchQueue(state.dir).map((q) => q.key).sort()).toEqual(["first-lane", "second-lane"]);
    expect(launchHeld(state.dir)).toBe(true);
  } finally {
    first.child.kill();
    second?.child.kill();
    await Promise.all([first.child.exited, second?.child.exited]);
    state.done();
  }
});

test("clearing an observed HOLD cannot lower a new subprocess enqueue's blocked flag", async () => {
  const state = withState();
  recordLaunchVerdict(state.dir, { ok: false, reasons: ["old hold"] }, 1);
  expect(launchHeld(state.dir)).toBe(true);
  const enqueue = worker("hold-first", state.dir);
  try {
    expect(await enqueue.next()).toBe("read");
    enqueue.release();
    await enqueue.finish();
    clearLaunchHold(state.dir);
    expect(launchHeld(state.dir)).toBe(true);
    expect(launchQueue(state.dir).map((q) => q.key)).toEqual(["first-lane"]);
  } finally {
    enqueue.child.kill();
    await enqueue.child.exited;
    state.done();
  }
});

test("a held enqueue fsyncs its file and directory before returning", async () => {
  const state = withState();
  const enqueue = worker("hold-fsync", state.dir);
  try {
    expect(await enqueue.next()).toBe("file-sync");
    expect(await enqueue.next()).toBe("dir-sync");
    await enqueue.finish();
    expect(launchHeld(state.dir)).toBe(true);
    expect(launchQueue(state.dir)).toHaveLength(1);
  } finally {
    enqueue.child.kill();
    await enqueue.child.exited;
    state.done();
  }
});

test("subprocess launch double reservation refuses the second agent before any external write", async () => {
  // Given a launch stopped at tab creation while another process can inspect its reservation.
  const state = withState();
  await Bun.write(join(state.dir, "launch-first.md"), "work\n");
  await Bun.write(join(state.dir, "launch-second.md"), "work\n");
  const first = worker("launch-first", state.dir);
  let second: ReturnType<typeof worker> | undefined;
  try {
    expect(await first.next()).toBe("creating");
    // When a separate CLI process tries to launch the same key.
    second = worker("launch-second", state.dir);
    const event = await second.next();
    if (event === "creating") second.release();
    await second.finish();
    first.release();
    await first.finish();
    // Then it was refused before tab/agent creation and the first lane remains tracked.
    expect(event).toBe("refused");
    expect(await new Registry(state.dir).read("double-lane")).toMatchObject({ pane: "w:p1" });
  } finally {
    first.child.kill();
    second?.child.kill();
    await Promise.all([first.child.exited, second?.child.exited]);
    state.done();
  }
});
