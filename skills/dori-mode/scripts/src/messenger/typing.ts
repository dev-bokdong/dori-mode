export type Timers = { readonly setInterval: (cb: () => void, ms: number) => unknown; readonly clearInterval: (h: unknown) => void };

export const realTimers: Timers = { setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };

export const typingWhile = async <T>(send: () => Promise<void>, timers: Timers, work: () => Promise<T>, everyMs = 4_000): Promise<T> => {
  await send().catch(() => {});
  const h = timers.setInterval(() => void send().catch(() => {}), everyMs);
  try {
    return await work();
  } finally {
    timers.clearInterval(h);
  }
};
