import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { saveLeadPane } from "../src/config.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

test("saveLeadPane rewrites only leadPane, keeps the file mode, and leaves no temp file", () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify({ custom: "keep me", leadPane: "w1:p1", hooks: { threadReply: ["notify", "{text}"] } }));
  chmodSync(path, 0o640);
  expect(saveLeadPane(path, "w9:p2")).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ custom: "keep me", leadPane: "w9:p2", hooks: { threadReply: ["notify", "{text}"] } });
  expect(statSync(path).mode & 0o777).toBe(0o640);
  expect(readdirSync(state.dir)).toEqual(["config.json"]);
});

test("saveLeadPane does not create a config file that was never loaded", () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "missing.json");
  expect(saveLeadPane(path, "w9:p2")).toBe(false);
  expect(existsSync(path)).toBe(false);
});
