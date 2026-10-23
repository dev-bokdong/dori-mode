import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The file the supervisor unit loads with EnvironmentFile (written by `dori setup`). */
export const envFilePath = (home = homedir()): string => join(home, ".dori", "env");

/** Reads one `KEY=value` (optionally `export`ed, optionally quoted) from env-file text; blank counts as unset. */
export const envFileValue = (text: string, name: string): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`).exec(line);
    if (!m) continue;
    const value = (m[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  return undefined;
};

/**
 * Resolves a messenger credential the way the supervisor sees it: the process environment first, then the
 * private env file. A process that did not inherit the unit's environment (a restarted lead's tool calls)
 * still finds it there. Callers must never print the returned value.
 */
export const resolveCredential = (name: string, env: Readonly<Record<string, string | undefined>> = process.env, home = env.HOME || homedir()): string | undefined => {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  const path = envFilePath(home);
  if (!existsSync(path)) return undefined;
  try {
    return envFileValue(readFileSync(path, "utf8"), name);
  } catch {
    return undefined;
  }
};
