import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export class DiscordGatewayOwnedError extends Error {}

/** Token-scoped, not stateDir-scoped: separate installs must not share a bot session. */
export const acquireDiscordGateway = (token: string, directory = join(homedir(), ".dori", "gateway-locks")): (() => void) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(token).digest("hex");
  const db = new Database(join(directory, `${key}.sqlite`), { create: true, strict: true });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new DiscordGatewayOwnedError("Discord gateway is already owned by a running supervisor or presence process; stop the standalone dori-presence.service before running dori supervise");
  }
  return () => { db.close(); };
};
