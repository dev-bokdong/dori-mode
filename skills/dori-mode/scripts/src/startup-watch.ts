/**
 * Worker thread for StartupProbe: it runs on its own event loop, so it can report a step that blocks the supervisor's
 * main thread. It writes with writeSync on the inherited file descriptor (the journal under systemd), never through
 * the main thread.
 */
import { writeSync } from "node:fs";

import type { WatchMessage } from "./startup-probe.ts";

declare const self: Worker;

let budgetMs = 60_000;
let fd = 2;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

self.onmessage = (event: MessageEvent<WatchMessage>) => {
  const message = event.data;
  switch (message.kind) {
    case "config":
      budgetMs = message.budgetMs;
      fd = message.fd;
      break;
    case "begin": {
      const { step, at } = message;
      clearTimeout(timers.get(step));
      timers.set(step, setTimeout(() => {
        timers.delete(step);
        const seconds = (ms: number) => `${Math.round(ms / 1_000)}s`;
        try { writeSync(fd, `STARTUP_SLOW ${step} still running after ${seconds(Date.now() - at)} (budget ${seconds(budgetMs)})\n`); }
        catch { /* the descriptor is gone: nothing left to tell */ }
      }, Math.max(0, at + budgetMs - Date.now())));
      break;
    }
    case "end":
      clearTimeout(timers.get(message.step));
      timers.delete(message.step);
      break;
  }
};
