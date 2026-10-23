import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envFileValue, resolveCredential } from "../src/credentials.ts";
import { withState } from "./fakes.ts";

const SECRET = "file-secret-value";
const homeWithEnv = (dir: string, text: string): void => {
  mkdirSync(join(dir, ".dori"), { recursive: true });
  writeFileSync(join(dir, ".dori", "env"), text);
};

test("envFileValue reads plain, exported and quoted values and treats blank as unset", () => {
  expect(envFileValue("A=1\nDORI_DISCORD_TOKEN=abc\n", "DORI_DISCORD_TOKEN")).toBe("abc");
  expect(envFileValue('export DORI_DISCORD_TOKEN="q q"', "DORI_DISCORD_TOKEN")).toBe("q q");
  expect(envFileValue("DORI_DISCORD_TOKEN=", "DORI_DISCORD_TOKEN")).toBeUndefined();
});

test("resolveCredential prefers the process environment over the env file", () => {
  const state = withState();
  try {
    homeWithEnv(state.dir, `DORI_DISCORD_TOKEN=${SECRET}\n`);
    expect(resolveCredential("DORI_DISCORD_TOKEN", { HOME: state.dir, DORI_DISCORD_TOKEN: "from-env" })).toBe("from-env");
  } finally { state.done(); }
});

test("resolveCredential falls back to ~/.dori/env when the variable is missing or blank", () => {
  const state = withState();
  try {
    homeWithEnv(state.dir, `DORI_DISCORD_TOKEN=${SECRET}\n`);
    expect(resolveCredential("DORI_DISCORD_TOKEN", { HOME: state.dir })).toBe(SECRET);
    expect(resolveCredential("DORI_DISCORD_TOKEN", { HOME: state.dir, DORI_DISCORD_TOKEN: "  " })).toBe(SECRET);
  } finally { state.done(); }
});

test("resolveCredential is undefined when neither place holds it", () => {
  const state = withState();
  try {
    expect(resolveCredential("DORI_DISCORD_TOKEN", { HOME: state.dir })).toBeUndefined();
    homeWithEnv(state.dir, "OTHER=1\n");
    expect(resolveCredential("DORI_DISCORD_TOKEN", { HOME: state.dir })).toBeUndefined();
  } finally { state.done(); }
});

const send = async (home: string, env: Record<string, string>) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (_u, init) => { console.log("FAKE_AUTH " + (init.headers.Authorization ?? init.headers.authorization)); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "123", "--text", "x"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: join(home, "state"), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

test("dori send discord uses the token from ~/.dori/env when DORI_DISCORD_TOKEN is unset", async () => {
  const state = withState();
  try {
    homeWithEnv(state.dir, `DORI_DISCORD_TOKEN=${SECRET}\n`);
    const r = await send(state.dir, {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT");
    expect(r.out).toContain(`Bot ${SECRET}`);
  } finally { state.done(); }
});

test("dori send discord exits non-zero with a clear error and no secret when the token is in neither place", async () => {
  const state = withState();
  try {
    homeWithEnv(state.dir, "OTHER=1\n");
    const r = await send(state.dir, {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("DORI_DISCORD_TOKEN is not set");
    expect(r.out).not.toContain("SENT");
  } finally { state.done(); }
});
