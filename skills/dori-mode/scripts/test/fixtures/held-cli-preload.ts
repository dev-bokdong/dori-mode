import { mock } from "bun:test";
import * as host from "../../src/host-guard.ts";
import * as quota from "../../src/claude-quota.ts";

mock.module("../../src/host-guard.ts", () => ({
  ...host,
  sampleHost: async () => ({ load1: 0, memFreePct: 1, diskFreeGb: 300, swapFreeGb: 2, panes: 1 }),
}));
mock.module("../../src/claude-quota.ts", () => ({ ...quota, launchQuotaHold: async () => undefined }));
