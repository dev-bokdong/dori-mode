import { mock } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const [mode, stateDir = ""] = process.argv.slice(2);
const signal = (event: string) => fs.writeSync(1, `${event}\n`);
const barrier = () => {
  if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("parent closed barrier");
};

if (mode === "registry-contender") {
  // Advance only the contender's clock: the holder is healthy but looks older than the former lease.
  const now = Date.now();
  Date.now = () => now + 120_000;
  Bun.sleep = (() => { signal("waiting"); barrier(); return Promise.resolve(); }) as typeof Bun.sleep;
}

if (mode === "registry-publication-holder") {
  const originalOpen = fs.openSync;
  mock.module("node:fs", () => ({
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (args[1] === "wx" && String(args[0]).endsWith("race-lane.lock")) {
        signal("published");
        barrier();
      }
      return fd;
    },
  }));
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (sql: string) {
    const result = exec.call(this, sql);
    if (sql.includes("BEGIN")) { signal("published"); barrier(); }
    return result;
  };
}

if (mode === "hold-fsync") {
  const originalSync = fs.fsyncSync;
  mock.module("node:fs", () => ({
    ...fs,
    fsyncSync: (fd: number) => {
      signal(fs.fstatSync(fd).isDirectory() ? "dir-sync" : "file-sync");
      originalSync(fd);
    },
  }));
}

if (mode === "hold-first" || mode === "hold-second") {
  const originalRead = fs.readFileSync;
  let intercepted = false;
  mock.module("node:fs", () => ({
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = originalRead(...args);
      if (!intercepted && String(args[0]) === join(stateDir, "launch-hold.json")) {
        intercepted = true;
        signal("read");
        barrier();
      }
      return result;
    },
  }));
  if (mode === "hold-second") {
    const exec = Database.prototype.exec;
    Database.prototype.exec = function (sql: string) {
      if (sql.includes("BEGIN")) { signal("locking"); barrier(); }
      return exec.call(this, sql);
    };
  }
}

if (mode === "registry-holder" || mode === "registry-publication-holder" || mode === "registry-contender") {
  const { Registry } = await import("../../src/registry.ts");
  const registry = new Registry(stateDir);
  await registry.update("race-lane", (current) => {
    signal("entered");
    if (mode === "registry-holder") barrier();
    if (!current) throw new Error("missing fixture lane");
    return { ...current, recoveryAttempts: (current.recoveryAttempts ?? 0) + 1 };
  });
} else if (mode === "launch-first" || mode === "launch-second") {
  const { launchLane, LaunchError } = await import("../../src/launch.ts");
  const { depsFor, fakeClock, newWorld } = await import("../fakes.ts");
  const base = depsFor(newWorld(), fakeClock(1), stateDir);
  const pane = mode === "launch-first" ? "w:p1" : "w:p2";
  const run: typeof base.run = async (argv, opts) => {
    if (argv[1] === "tab" && argv[2] === "create") {
      signal("creating");
      barrier();
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: pane } } }), err: "" };
    }
    return base.run(argv, opts);
  };
  try {
    await launchLane({ ...base, run }, {
      key: "double-lane", title: "race", brief: join(stateDir, `${mode}.md`), done: "merged acme/app#1",
    });
  } catch (error) {
    if (!(error instanceof LaunchError) || !error.message.includes("already registered")) throw error;
    signal("refused");
  }
} else {
  const { enqueueLaunch } = await import("../../src/routing.ts");
  enqueueLaunch(stateDir, {
    key: mode === "hold-first" ? "first-lane" : "second-lane",
    title: "held", brief: "/brief.md", done: "merged acme/app#1",
    queuedAt: "2026-10-22T00:00:00.000Z", reasons: ["host full"],
  });
}
signal("done");
