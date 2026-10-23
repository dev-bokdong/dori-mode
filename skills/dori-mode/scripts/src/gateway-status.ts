import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The supervisor's heartbeat file: doctor and status read it, so they never touch the lock or the socket. */
export type GatewayStatus = {
  readonly pid: number;
  readonly at: number;
  readonly connected: boolean;
  readonly messageContent: boolean;
};

export const GATEWAY_STALE_MS = 60_000;

export const gatewayStatusPath = (stateDir: string): string => join(stateDir, "gateway-status.json");

export const writeGatewayStatus = (stateDir: string, status: GatewayStatus): void => {
  mkdirSync(stateDir, { recursive: true });
  const path = gatewayStatusPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  renameSync(tmp, path);
};

export const readGatewayStatus = (stateDir: string): GatewayStatus | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(gatewayStatusPath(stateDir), "utf8"));
    if (typeof raw !== "object" || raw === null) return;
    const s = raw as Record<string, unknown>;
    if (typeof s.pid !== "number" || typeof s.at !== "number" || typeof s.connected !== "boolean" || typeof s.messageContent !== "boolean") return;
    return { pid: s.pid, at: s.at, connected: s.connected, messageContent: s.messageContent };
  } catch {
    return;
  }
};

export type GatewayView = { readonly state: "live" | "no-content" | "disconnected" | "stale" | "missing"; readonly text: string };

export const gatewayView = (status: GatewayStatus | undefined, now: number): GatewayView => {
  if (!status) return { state: "missing", text: "no gateway status file (supervisor not running, or an older build)" };
  const age = Math.max(0, Math.round((now - status.at) / 1000));
  if (now - status.at > GATEWAY_STALE_MS) return { state: "stale", text: `stale: last heartbeat ${age}s ago` };
  if (!status.connected) return { state: "disconnected", text: `not connected (heartbeat ${age}s ago)` };
  if (!status.messageContent) return { state: "no-content", text: `connected without Message Content; REST fallback (heartbeat ${age}s ago)` };
  return { state: "live", text: `live, Message Content on (heartbeat ${age}s ago)` };
};
