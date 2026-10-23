import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Repos, ReposError } from "../src/repos.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });
const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  return { state, repos: new Repos(state.dir), path: join(state.dir, "github-repos.json") };
};

const cli = async (dir: string, args: readonly string[]) => {
  const child = Bun.spawn([fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "repos", ...args], {
    cwd: dir,
    env: { ...process.env, DORI_CONFIG: join(dir, "missing-config.json"), DORI_STATE_DIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
};

test("a missing store lists empty without creating state", () => {
  const f = fixture();
  const repos = new Repos(join(f.state.dir, "missing"));
  expect(repos.list()).toEqual([]);
  expect(existsSync(join(f.state.dir, "missing"))).toBe(false);
});

test("store mutations normalize and deduplicate across reconstruction and live readers", () => {
  const f = fixture();
  const observer = new Repos(f.state.dir);
  f.repos.add(" Dev-Bokdong/Dori-Mode ");
  new Repos(f.state.dir).add("dev-bokdong/dori-mode");
  new Repos(f.state.dir).add("Other/Repo.Name");
  expect(observer.list()).toEqual(["dev-bokdong/dori-mode", "other/repo.name"]);
  f.repos.remove("DEV-BOKDONG/DORI-MODE");
  f.repos.remove("missing/repo");
  expect(observer.list()).toEqual(["other/repo.name"]);
  f.repos.replace(["New/Repo", " new/repo "]);
  expect(observer.list()).toEqual(["new/repo"]);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(["new/repo"]);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.state.dir)).toEqual(["github-repos.json"]);
  f.repos.replace([]);
  expect(new Repos(f.state.dir).list()).toEqual([]);
});

test.each([
  "", "owner", "owner/", "/repo", "owner/repo/extra", "../repo", "owner/..", "owner/.",
  "https://github.com/owner/repo", "owner/repo.git?x=1", "owner/has space", "owner/repo\nother/repo",
  "-owner/repo", "owner-/repo", "own--er/repo", "owner_name/repo", `${"o".repeat(40)}/repo`, `owner/${"r".repeat(101)}`,
])("malformed repo is rejected by every mutation without changing state: %j", (repo) => {
  const f = fixture();
  f.repos.add("valid/repo");
  const before = readFileSync(f.path, "utf8");
  expect(() => f.repos.add(repo)).toThrow(ReposError);
  expect(() => f.repos.remove(repo)).toThrow(ReposError);
  expect(() => f.repos.replace(["other/repo", repo])).toThrow(ReposError);
  expect(readFileSync(f.path, "utf8")).toBe(before);
});

test.each(["{", "{}", "null", '["bad"]', '["owner/repo", 1]'])("malformed persisted state is rejected, not overwritten: %j", (text) => {
  const f = fixture();
  writeFileSync(f.path, text);
  expect(() => f.repos.list()).toThrow(ReposError);
  expect(() => f.repos.add("valid/repo")).toThrow(ReposError);
  expect(readFileSync(f.path, "utf8")).toBe(text);
});

test("CLI add, list and remove roundtrip through the hot-reloaded store", async () => {
  const f = fixture();
  const added = await cli(f.state.dir, ["add", "Owner/Repo"]);
  expect(added.code).toBe(0);
  expect(added.err).toBe("");
  expect(JSON.parse(added.out)).toEqual(["owner/repo"]);
  expect(f.repos.list()).toEqual(["owner/repo"]);
  const listed = await cli(f.state.dir, ["list"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)).toEqual(["owner/repo"]);
  const removed = await cli(f.state.dir, ["remove", "OWNER/REPO"]);
  expect(removed.code).toBe(0);
  expect(removed.err).toBe("");
  expect(JSON.parse(removed.out)).toEqual([]);
  expect(f.repos.list()).toEqual([]);
});

test.each([
  [], ["add"], ["add", "bad"], ["remove", "../repo"], ["list", "owner/repo"],
  ["add", "owner/repo", "other/repo"], ["unknown"], ["list", "--write"],
].map((args) => ({ args })))("CLI rejects malformed commands without creating a store: %j", async ({ args }) => {
  const f = fixture();
  const result = await cli(f.state.dir, args);
  expect(result.code).toBe(1);
  expect(result.err.trim().length).toBeGreaterThan(0);
  expect(existsSync(f.path)).toBe(false);
});
