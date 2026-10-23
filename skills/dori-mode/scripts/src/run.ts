export type Ran = { readonly code: number; readonly out: string; readonly err: string; readonly timedOut?: boolean };
/** `timeoutMs` overrides the default for one call; 0 means no limit. */
export type RunOptions = { readonly cwd?: string; readonly timeoutMs?: number };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

/** Exit code a timed-out call reports (as coreutils `timeout` does). */
export const RUN_TIMEOUT_CODE = 124;
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;
/** After the command exits (or is killed on timeout), how long the output pipes may take to close before they are abandoned. */
export const RUN_KILL_GRACE_MS = 1_500;
let defaultTimeoutMs = DEFAULT_RUN_TIMEOUT_MS;

/** Sets the limit every call without its own `timeoutMs` gets (config `runTimeoutMs`); 0 turns it off. */
export const setDefaultRunTimeout = (ms: number): void => {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`run timeout must be a non-negative number of ms, got ${ms}`);
  defaultTimeoutMs = ms;
};
export const defaultRunTimeout = (): number => defaultTimeoutMs;

/**
 * Runs argv and collects its output. A descendant (a daemon, or one that left the group with setsid) can hold the
 * output pipes open indefinitely, so once the command itself exits its pipes get at most RUN_KILL_GRACE_MS to close;
 * then their readers are cancelled and the command's own exit code comes back with the output read so far. A call
 * that outlives its timeout has its process group killed with SIGKILL, gets the same grace, and comes back as code
 * 124 with `timedOut`.
 */
export const run: Runner = async (argv, opts = {}) => {
  const limit = opts.timeoutMs ?? defaultTimeoutMs;
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([...argv], { detached: true, stdout: "pipe", stderr: "pipe", ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const cancels: (() => Promise<void>)[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    cancels.push(() => reader.cancel());
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString();
      chunks.push(value);
    }
  };
  const outputs = Promise.all([collect(p.stdout as ReadableStream<Uint8Array>), collect(p.stderr as ReadableStream<Uint8Array>)]);
  /** Waits for the pipes to close for at most the grace, then cancels their readers so `outputs` settles. */
  const drain = async (): Promise<void> => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([outputs.then(() => true), new Promise<false>((resolve) => { grace = setTimeout(() => resolve(false), RUN_KILL_GRACE_MS); })]);
    clearTimeout(grace);
    if (!drained) await Promise.all(cancels.map((cancel) => cancel().catch(() => undefined)));
  };
  let exited = false;
  const finished = p.exited.then(async (code) => {
    exited = true;
    await drain();
    const [out, err] = await outputs;
    return { code, out: out.trim(), err: err.trim() };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    if (limit > 0) timer = setTimeout(() => resolve("timeout"), limit);
  });
  try {
    const result = await Promise.race([finished, expired]);
    if (result !== "timeout") return result;
    // The command exited in time and only its pipes were still draining: its own result stands.
    if (exited) return await finished;
    try { process.kill(-p.pid, "SIGKILL"); }
    catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e; }
    await drain();
    return { code: RUN_TIMEOUT_CODE, out: "", err: `timed out after ${limit} ms: ${argv.join(" ")}`, timedOut: true };
  } finally {
    clearTimeout(timer);
  }
};

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();
