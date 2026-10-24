import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { eventPriority, Supervisor } from "../src/supervise.ts";
import { handoffLines, outcomeLane, pendingReported, recordReported, REPORTED_DIR, takeReminders } from "../src/lane-outcomes.ts";
import type { Lane } from "../src/registry.ts";
import { renderStatus, type Status } from "../src/status.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, state.dir);
  const unreported = () => (readJournal(state.dir).events as { id: string; line: string }[]).filter((event) => event.line.startsWith("UNREPORTED "));
  return { state, clock, deps, unreported };
};

const lane = (key: string, extra: Partial<Lane> = {}): Lane => ({
  key, title: key, thread: "none", pane: undefined, brief: "/tmp/brief.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), ...extra,
} as Lane);

test("outcome lines name their lane; other lines and malformed keys name none", () => {
  expect(outcomeLane("LANE_CLOSED alpha {\"checks\":[]}")).toBe("alpha");
  expect(outcomeLane("CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x")).toBe("alpha");
  expect(outcomeLane("CI_MERGED acme/app#7 into dev head=abc")).toBeUndefined();
  expect(outcomeLane("LANE_AUTO_CLOSED alpha x")).toBeUndefined();
  expect(outcomeLane("LANE_CLOSED $(rm) x")).toBeUndefined();
});

test("CI_MERGED and LANE_CLOSED of one lane are one obligation: UNREPORTED after reportTimeoutMin, re-sent with backoff, stopped by dori reported", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("ci-merged:acme/app#7", "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x");
  f.clock.at += MIN;
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha {\"checks\":[]}");
  expect(readJournal(f.state.dir).outcomes).toEqual([
    { lane: "alpha", since: T0, line: "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x", events: ["ci-merged:acme/app#7", "lane-closed:alpha"] },
  ]);
  f.clock.at = T0 + 5 * MIN - 1;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  f.clock.at = T0 + 5 * MIN;
  await supervisor.reportTick();
  const [first] = f.unreported();
  expect(first?.line).toStartWith("UNREPORTED alpha finished 5 min ago and the owner has not been told: report the outcome to the owner yourself, then run dori reported alpha. CI_MERGED acme/app#7");
  expect(eventPriority(first?.line ?? "")).toBe("urgent");
  // Re-sent one window later, then after twice the previous wait; a restarted supervisor keeps the count.
  f.clock.at += 5 * MIN;
  await new Supervisor(f.deps).reportTick();
  expect(f.unreported()).toHaveLength(2);
  const restarted = new Supervisor(f.deps);
  f.clock.at += 10 * MIN - 1;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(2);
  f.clock.at += 1;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(3);
  // The lead reports; nothing more is sent, and a later outcome event of the lane opens nothing.
  recordReported(f.state.dir, "alpha", f.clock.now(), "told in its thread");
  await restarted.reportTick();
  expect(readdirSync(join(f.state.dir, REPORTED_DIR))).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "alpha", reportedAt: f.clock.now(), note: "told in its thread" });
  restarted.enqueue("lane-closed:alpha:again", "LANE_CLOSED alpha again");
  f.clock.at += 120 * MIN;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(3);
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
});

test("a report recorded before the outcome event arrives settles it, and two lanes are two obligations", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  recordReported(f.state.dir, "beta", f.clock.now());
  await supervisor.reportTick();
  supervisor.enqueue("lane-closed:beta", "LANE_CLOSED beta x");
  supervisor.enqueue("lane-closed:gamma", "LANE_CLOSED gamma x");
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported().map((event) => event.line.split(" ")[1])).toEqual(["gamma"]);
});

test("outcomes in the history at startup open nothing, and an engine-only outcome is not owed", async () => {
  const f = fixture();
  writeJournal(f.state.dir, { events: [{ id: "lane-closed:old", line: "LANE_CLOSED old x", at: T0 - 60 * MIN }] });
  const supervisor = new Supervisor({ ...f.deps, config: { ...f.deps.config, eventPolicy: { default: "lead-digest", kinds: { ...f.deps.config.eventPolicy.kinds, LANE_CLOSED: "engine-only" } } } });
  supervisor.enqueue("lane-closed:quiet", "LANE_CLOSED quiet x");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes ?? []).toEqual([]);
  expect(f.unreported()).toEqual([]);
});

test("a lane with autoClose: machine owes no report", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("robot", { autoClose: "machine" }));
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-closed:robot", "LANE_CLOSED robot x");
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "robot", reportedAt: f.clock.now(), note: "autoClose: machine" });
});

test("open obligations are listed for inbox take and the cold handoff until reported", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  expect(takeReminders(f.state.dir)).toEqual([]);
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha done");
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([
    `unreported:alpha\tUNREPORTED alpha since ${new Date(T0).toISOString()}: report the outcome to the owner yourself, then run dori reported alpha`,
  ]);
  expect(handoffLines(readJournal(f.state.dir))).toEqual([
    "Lane outcomes not yet reported to the owner follow: for each, report the outcome to the owner yourself, then run dori reported <key>.",
    "UNREPORTED alpha LANE_CLOSED alpha done",
  ]);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([]);
  expect(handoffLines(readJournal(f.state.dir))).toEqual([]);
});

test("dori status names unreported lanes as a problem", () => {
  const base = {
    at: new Date(T0).toISOString(), services: [], lanes: [], waits: [], unacked: 0,
    lead: { pane: "lead:p1", state: "warm", cacheTtlMin: 60, capTokens: 100_000 },
    github: { repos: [], failures: [], issueAuthors: ["owner"], issueRepos: [] },
    gateway: { state: "live", text: "" },
    events: { hours: 24, wakes: 0, measured: 0, calls: 0, kinds: [] },
  } as unknown as Status;
  expect(renderStatus(base)).not.toContain("unreported");
  const text = renderStatus({ ...base, unreported: [{ lane: "alpha", since: new Date(T0 - 12 * MIN).toISOString() }] });
  expect(text.split("\n")[0]).toContain("unreported 1");
  expect(text).toContain("! reports: finished lanes not reported to the owner (report, then dori reported <key>): alpha 12m ago");
});

const cli = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("dori reported is lead-only, needs a registered lane, and writes one receipt", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha"));
  const denied = await cli(f.state.dir, ["reported", "alpha"], { DORI_LANE_KEY: "alpha" });
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("LANE_PERMISSION_DENIED lane alpha may not run reported; it is lead-only");
  const unknown = await cli(f.state.dir, ["reported", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no registered lane "nope"');
  expect(existsSync(join(f.state.dir, REPORTED_DIR))).toBe(false);
  const ok = await cli(f.state.dir, ["reported", "alpha", "--note", "told in its thread"]);
  expect(ok.code).toBe(0);
  expect(ok.out.trim()).toBe("REPORTED_RECORDED alpha");
  expect(pendingReported(f.state.dir).map(({ lane: key, note }) => ({ key, note }))).toEqual([{ key: "alpha", note: "told in its thread" }]);
});
