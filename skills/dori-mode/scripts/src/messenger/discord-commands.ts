import type { DiscordConfig } from "../config.ts";
import type { Http } from "./http.ts";
import { MessengerError } from "./http.ts";

export const guildCommands = [
  { name: "quota", description: "Show subscription quota", type: 1 },
  {
    name: "status", description: "Show Dori services, lead, lanes and waits", type: 1,
    options: [{ type: 4, name: "page", description: "Page 2 and on list the lanes page 1 has no room for", required: false, min_value: 1 }],
  },
  { name: "emergency", description: "Approve the lead's paid emergency models until its first model has quota again", type: 1 },
] as const;
export type QuotaLookup = (signal: AbortSignal) => Promise<string>;
/** The /status text source: `page` is the command's page option, 1 without it. */
export type StatusLookup = (signal: AbortSignal, page: number) => Promise<string>;

type Interaction = {
  readonly id: string;
  readonly token: string;
  readonly application_id: string;
  readonly guild_id: string;
  readonly userId: string;
  readonly command: "quota" | "status" | "emergency";
  readonly channelIds: readonly string[];
  /** /status page:N; 1 when absent or not a positive integer. */
  readonly page: number;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const commandInteraction = (value: unknown): Interaction | undefined => {
  if (!record(value) || value.type !== 2 || !record(value.data) || value.data.type !== 1) return;
  const command = value.data.name;
  if (command !== "quota" && command !== "status" && command !== "emergency") return;
  if (typeof value.id !== "string" || typeof value.token !== "string" || typeof value.application_id !== "string" || typeof value.guild_id !== "string") return;
  if (!record(value.member) || !record(value.member.user) || typeof value.member.user.id !== "string") return;
  const channelIds = [value.channel_id, record(value.channel) ? value.channel.parent_id : undefined].filter((id): id is string => typeof id === "string");
  const option = Array.isArray(value.data.options) ? value.data.options.find((o: unknown) => record(o) && o.name === "page") : undefined;
  const page = record(option) && Number.isSafeInteger(option.value) && (option.value as number) >= 1 ? option.value as number : 1;
  return { id: value.id, token: value.token, application_id: value.application_id, guild_id: value.guild_id, userId: value.member.user.id, command, channelIds, page };
};

/** Neutralize code fences/control characters from account labels, and keep one complete code block. */
export const quotaMessage = (text: string, empty = "No subscription quota is configured."): string => {
  const clean = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/`/g, "'");
  const body = clean || empty;
  const bounded = body.length <= 1992 ? body : `${body.slice(0, 1976).replace(/[\uD800-\uDBFF]$/, "")}\n[truncated]`;
  return `\`\`\`\n${bounded}\n\`\`\``;
};

/** Uses the existing presence socket; REST interactions never start a model turn. */
export class DiscordCommands {
  constructor(
    private readonly http: Http,
    private readonly botToken: string,
    private readonly config: DiscordConfig,
    private readonly lookup: QuotaLookup,
    private readonly deadline: () => AbortSignal = () => AbortSignal.timeout(20_000),
    /** Channels this Dori owns; empty answers everywhere. */
    private readonly channels: readonly string[] = [],
    /** The /status text source; without it /status is ignored. */
    private readonly statusLookup?: StatusLookup,
    /** Records the owner's /emergency approval and returns the reply; without it /emergency is ignored. */
    private readonly emergencyLookup?: QuotaLookup,
  ) {}

  private async request(method: "PUT" | "POST" | "PATCH", path: string, body: unknown, authenticated = false): Promise<void> {
    const response = await this.http({
      method, url: `https://discord.com/api/v10${path}`,
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bot ${this.botToken}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === "POST" ? 2_500 : 10_000),
    });
    // Never include paths, interaction tokens or Discord's response body in errors.
    if (response.status >= 300) throw new MessengerError("Discord command request failed", response.status);
  }

  async register(): Promise<void> {
    const { applicationId, guildId, ownerId } = this.config;
    if (![applicationId, guildId, ownerId].every((id) => /^\d+$/.test(id))) throw new MessengerError("Discord slash command IDs must be configured", 0);
    await this.request("PUT", `/applications/${applicationId}/guilds/${guildId}/commands`, guildCommands, true);
  }

  async handle(value: unknown): Promise<void> {
    const interaction = commandInteraction(value);
    if (!interaction || interaction.application_id !== this.config.applicationId || interaction.guild_id !== this.config.guildId) return;
    if (interaction.command === "status" && !this.statusLookup) return;
    if (interaction.command === "emergency" && !this.emergencyLookup) return;
    const label = interaction.command === "status" ? "Status" : interaction.command === "emergency" ? "Emergency approval" : "Quota";
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;
    try {
      if (this.channels.length > 0 && !interaction.channelIds.some((id) => this.channels.includes(id))) {
        await this.request("POST", callback, { type: 4, data: { flags: 64, content: `이 채널은 다른 Dori의 채널입니다. 해당 Dori 봇의 /${interaction.command}를 사용해 주세요.` } });
        return;
      }
      if (interaction.userId !== this.config.ownerId) {
        await this.request("POST", callback, { type: 4, data: { flags: 64, content: "This command is only available to the owner." } });
        return;
      }
      await this.request("POST", callback, { type: 5, data: { flags: 64 } });
    } catch {
      console.error(`Discord ${interaction.command} acknowledgement failed`);
      return;
    }
    let content: string;
    const signal = this.deadline();
    let abort: () => void = () => {};
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const lookup = interaction.command === "status" ? this.statusLookup : interaction.command === "emergency" ? this.emergencyLookup : this.lookup;
      const text = await Promise.race([lookup?.(signal, interaction.page) ?? Promise.reject(new Error("no lookup")), cancelled]);
      content = interaction.command === "status" ? quotaMessage(text, "No status available.") : interaction.command === "emergency" ? text : quotaMessage(text);
    } catch {
      content = signal.aborted ? `${label} lookup timed out. Try again.` : `${label} lookup failed. Try again.`;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    try {
      await this.request("PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { content, allowed_mentions: { parse: [] } });
    } catch {
      console.error(`Discord ${interaction.command} response failed`);
    }
  }
}
