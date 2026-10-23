import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { configPath } from "./config.ts";
import { doctorMain } from "./doctor.ts";
import { fetchHttp } from "./messenger/http.ts";
import { run } from "./run.ts";
import { ReposError } from "./repos.ts";
import { type Prompter, runSetup, SetupError, type SetupInput } from "./setup.ts";

export const SETUP_USAGE = `dori setup [options]

  Interactive by default: every question shows the current value, Enter keeps it.
  GitHub repos are optional; setup reads and saves this machine's watched list.
  --yes, -y               non-interactive: take flags, then stored values, then defaults
  --token-file FILE       read the Discord bot token from FILE ("-" for stdin); never pass it as an argument
  --channel ID            main Discord channel id (repeatable)
  --model M  --cwd DIR  --state-dir DIR
  --issue-author LOGIN    GitHub account whose new issues start work automatically (repeatable)
  --no-herdr              skip the herdr lead pane and lanes workspace
  --autostart             install and enable the systemd user units (with --yes: runs every step)`;

class LineReader {
  private buffered = "";
  private ended = false;
  private waiting: (() => void) | undefined;

  constructor(private readonly input: NodeJS.ReadStream) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffered += chunk;
      this.waiting?.();
    });
    input.on("end", () => {
      this.ended = true;
      this.waiting?.();
    });
  }

  async line(prompt: string, hidden: boolean): Promise<string> {
    const raw = hidden && this.input.isTTY;
    if (raw) this.input.setRawMode(true);
    process.stdout.write(prompt);
    this.input.resume();
    try {
      for (;;) {
        const at = this.buffered.search(raw ? /[\r\n\u0003]/ : /\n/);
        if (at >= 0) {
          if (this.buffered[at] === "\u0003") throw new SetupError("cancelled");
          const text = this.buffered.slice(0, at);
          this.buffered = this.buffered.slice(at + 1).replace(/^\n/, "");
          return raw ? [...text].reduce((s, ch) => (ch === "\u007f" || ch === "\b" ? s.slice(0, -1) : s + ch), "") : text.replace(/\r$/, "");
        }
        if (this.ended) {
          if (!this.buffered) throw new SetupError("input ended before setup finished");
          const text = this.buffered;
          this.buffered = "";
          return text;
        }
        await new Promise<void>((resolve) => {
          this.waiting = resolve;
        });
        this.waiting = undefined;
      }
    } finally {
      if (raw) {
        this.input.setRawMode(false);
        process.stdout.write("\n");
      }
      this.input.pause();
    }
  }
}

const ttyPrompter = (): Prompter => {
  const reader = new LineReader(process.stdin);
  return {
    ask: async (q, current) => (await reader.line(`${q}${current ? ` [${current}]` : ""}: `, false)).trim() || current,
    secret: async (q, isSet) => reader.line(`${q}${isSet ? " [stored, Enter keeps it]" : ""} (input hidden): `, true),
    confirm: async (q, fallback) => {
      const a = (await reader.line(`${q} [${fallback ? "Y/n" : "y/N"}]: `, false)).trim().toLowerCase();
      return a ? a.startsWith("y") : fallback;
    },
  };
};

const defaultsPrompter: Prompter = { ask: async (_, current) => current, secret: async () => "", confirm: async (_, fallback) => fallback };

export const setupMain = async (args: readonly string[]): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      yes: { type: "boolean", short: "y" }, "token-file": { type: "string" }, channel: { type: "string", multiple: true },
      model: { type: "string" }, cwd: { type: "string" }, "state-dir": { type: "string" }, "issue-author": { type: "string", multiple: true },
      "no-herdr": { type: "boolean" }, autostart: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(SETUP_USAGE);
    return 0;
  }
  const interactive = !values.yes && Boolean(process.stdin.isTTY);
  const home = homedir();
  const cfg = configPath();
  const tokenFile = values["token-file"];
  const input: SetupInput = {
    token: tokenFile ? readFileSync(tokenFile === "-" ? 0 : tokenFile, "utf8").trim() || undefined : undefined,
    channels: values.channel?.flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean),
    model: values.model,
    cwd: values.cwd,
    stateDir: values["state-dir"],
    issueAuthors: values["issue-author"]?.flatMap((a) => a.split(",")).map((a) => a.trim()).filter(Boolean),
    herdr: values["no-herdr"] ? false : undefined,
    autostart: values.autostart,
  };
  if (!interactive) console.log("SETUP non-interactive (flags, then stored values, then defaults)");
  try {
    const code = await runSetup(
      {
        run,
        http: fetchHttp,
        prompt: interactive ? ttyPrompter() : defaultsPrompter,
        log: (line) => console.log(line),
        interactive,
        home,
        user: userInfo().username,
        configPath: cfg,
        envPath: join(home, ".dori", "env"),
        unitDir: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user"),
        templatesDir: join(import.meta.dir, "..", "templates"),
        bins: { dori: Bun.which("dori") ?? join(home, ".bun", "bin", "dori"), herdr: Bun.which("herdr") ?? undefined, shell: process.env.SHELL || "/bin/bash" },
      },
      input,
    );
    console.log("\nDOCTOR (dori doctor)");
    await doctorMain();
    return code;
  } catch (e) {
    if (e instanceof SetupError || e instanceof ReposError) {
      console.error(`SETUP_FAILED ${e.message}`);
      return 1;
    }
    throw e;
  }
};
