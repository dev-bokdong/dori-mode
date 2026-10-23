import { join } from "node:path";
import type { FlowDeps } from "../done-flow.ts";
import { DiscordCommands, type QuotaLookup, type StatusLookup } from "./discord-commands.ts";
import {
  type DiscordInboundOptions, discordChannels, discordDispatchThreads, discordMessageChannel, discordOwnerConfigured, discordThread,
  discordThreadFloor, emitDiscordDelete, emitDiscordEdit, emitDiscordInbound, listDiscordInbound, listDiscordThreads,
  parseDiscordMessage, pollDiscordInbound,
} from "./discord-inbound.ts";
import { Discord, discordPresence, openDiscordGateway, type GatewaySocket } from "./discord.ts";
import { type Http, MessengerError } from "./http.ts";
import { realTimers, type Timers } from "./typing.ts";
import { approveEmergency } from "../emergency.ts";

export type SupervisorDiscordOptions = {
  readonly token: string;
  readonly http: Http;
  readonly emit: (id: string, line: string) => Promise<void>;
  readonly lookup: QuotaLookup;
  readonly statusLookup?: StatusLookup;
  /** The owner's /emergency command; by default it records the approval in the state dir (emergency.ts). */
  readonly emergencyLookup?: QuotaLookup;
  readonly open?: (url?: string) => GatewaySocket;
  readonly timers?: Timers;
  readonly log?: (line: string) => void;
};

/**
 * Gateway delivery never advances the REST watermark: an unseen gap cannot be skipped.
 * Watched: configured channels, open lane threads, and every thread whose parent is a configured channel.
 */
export const supervisorDiscord = (deps: FlowDeps, options: SupervisorDiscordOptions) => {
  const log = options.log ?? console.error;
  const config = deps.config.discord;
  if (!config) throw new TypeError("supervise requires config.discord; run dori setup");
  const discord = new Discord(options.http, deps.clock, options.token);
  const approve: QuotaLookup = async () => {
    if (approveEmergency(deps.config.stateDir, deps.clock.now()) === undefined) {
      return "Not approved: the lead is not out of quota now. An approval counts only for the outage it is given in; you will be asked when one starts.";
    }
    return "Approved for this outage: the lead may use the paid emergency models until it is back on its first model. The next outage asks again.";
  };
  const commands = new DiscordCommands(options.http, options.token, config, options.lookup, undefined, deps.config.discordChannels, options.statusLookup, options.emergencyLookup ?? approve);
  let lastPoll = -Infinity;
  let polling: Promise<void> | undefined;
  let catchupRequested = false;
  let stopped = false;
  let watched: readonly string[] = [];
  const statePath = join(deps.config.stateDir, "discord-inbound.json");
  const configured = () => discordChannels(deps.config.discordChannels, []);
  if (!discordOwnerConfigured(config.ownerId)) {
    log("DISCORD_INBOUND_WARNING discord.ownerId is not configured; every Discord author is treated as a VISITOR, never the owner (run dori setup)");
  }
  let botId: string | undefined;
  let contentWarned = false;
  // Owner message id -> channel, so a MESSAGE_DELETE can be reported for messages this process has seen. Bounded.
  const ownerMessages = new Map<string, string>();
  const inboundOptions: DiscordInboundOptions = {
    get botId() { return botId; },
    log,
    onMissingContent: () => {
      if (contentWarned) return;
      contentWarned = true;
      log('DISCORD_INBOUND_WARNING a message arrived with no content: enable the privileged "Message Content Intent" in the Developer Portal (Bot tab); such messages are forwarded marked as content unavailable');
    },
    onOwner: (channel, id) => {
      ownerMessages.delete(id);
      ownerMessages.set(id, channel);
      if (ownerMessages.size > 1_000) ownerMessages.delete(ownerMessages.keys().next().value ?? "");
    },
  };
  const watches = async (channel: string): Promise<boolean> =>
    discordChannels(deps.config.discordChannels, await deps.registry.open()).includes(channel) || configured().includes((await parentOf(channel)) ?? "");
  // Thread id -> parent channel; null marks a channel that is not a thread. Fed by gateway thread events and REST.
  const parents = new Map<string, string | null>();
  const lookups = new Map<string, Promise<string | null>>();
  const parentOf = (channel: string): Promise<string | null> => {
    const known = parents.get(channel);
    if (known !== undefined) return Promise.resolve(known);
    let pending = lookups.get(channel);
    if (!pending) {
      pending = discord.call("GET", `/channels/${channel}`).then(
        (value) => discordThread(value)?.parent ?? null,
        (error: unknown) => {
          // Channels the bot cannot read are cached as foreign; other failures retry on the next message.
          if (error instanceof MessengerError && (error.status === 403 || error.status === 404)) return null;
          throw error;
        },
      ).then((parent) => {
        if (!parents.has(channel)) parents.set(channel, parent);
        return parents.get(channel) ?? null;
      }).finally(() => { lookups.delete(channel); });
      lookups.set(channel, pending);
    }
    return pending;
  };
  const catchup = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    catchupRequested = true;
    if (polling) return polling;
    polling = (async () => {
      while (catchupRequested && !stopped) {
        catchupRequested = false;
        lastPoll = deps.clock.now();
        try {
          watched = discordChannels(deps.config.discordChannels, await deps.registry.open());
          let threads: string[] = [];
          let floor: string | undefined;
          try {
            const active = await listDiscordThreads(discord, config.guildId);
            for (const thread of active) parents.set(thread.id, thread.parent);
            const parentsWatched = configured();
            threads = active.filter((thread) => parentsWatched.includes(thread.parent) && !watched.includes(thread.id)).map((thread) => thread.id);
            floor = await discordThreadFloor(statePath, deps.clock.now(), log);
          } catch {
            threads = [];
            log("INBOUND_ERROR cannot list active Discord threads");
          }
          for (const channel of [...watched, ...threads]) {
            if (stopped) break;
            try {
              await pollDiscordInbound(deps.run, [channel], statePath, options.emit,
                (ch, after) => listDiscordInbound(discord, ch, after, deps.config.discordFirstSeenLimit), config.ownerId,
                watched.includes(channel) ? undefined : floor, inboundOptions);
            } catch {
              log(`INBOUND_ERROR ${channel} REST catch-up failed`);
            }
          }
        } catch {
          log("INBOUND_ERROR cannot read watched Discord channels");
        }
      }
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const registration = commands.register().catch(() => { log("DISCORD_COMMANDS_ERROR guild command registration failed"); });
  const gateway = discordPresence(options.open ?? openDiscordGateway, options.token, options.timers ?? realTimers,
    (data) => commands.handle(data), {
      messageContent: true,
      log,
      onReady: catchup,
      onDispatch: (type, data) => {
        if (type === "READY" && typeof data === "object" && data !== null && "user" in data) {
          const user: unknown = data.user;
          if (typeof user === "object" && user !== null && "id" in user && typeof user.id === "string") botId = user.id;
        }
        for (const thread of discordDispatchThreads(type, data)) parents.set(thread.id, thread.parent);
      },
      onMessage: async (value) => {
        if (stopped) return;
        const channel = discordMessageChannel(value);
        if (!channel) return;
        if (await watches(channel)) await emitDiscordInbound(channel, parseDiscordMessage(value), options.emit, config.ownerId, inboundOptions);
      },
      onMessageUpdate: async (value) => {
        if (stopped) return;
        const channel = discordMessageChannel(value);
        if (channel && await watches(channel)) await emitDiscordEdit(channel, value, options.emit, config.ownerId, inboundOptions);
      },
      onMessageDelete: async (value) => {
        if (stopped || typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return;
        const channel = ownerMessages.get(value.id);
        if (!channel || discordMessageChannel(value) !== channel) return;
        ownerMessages.delete(value.id);
        await emitDiscordDelete(channel, value.id, options.emit);
      },
    });
  return {
    /** Gateway state for the heartbeat file. */
    state: () => ({ connected: gateway.connected, messageContent: gateway.messageContent }),
    async tick(): Promise<void> {
      const channels = discordChannels(deps.config.discordChannels, await deps.registry.open());
      if (polling) { await polling; return; }
      const newChannel = channels.some((channel) => !watched.includes(channel));
      const interval = gateway.healthy ? deps.config.discordSafetyPollSeconds * 1_000 : 5_000;
      if (newChannel || deps.clock.now() - lastPoll >= interval) await catchup();
    },
    async close(): Promise<void> {
      stopped = true;
      gateway.close();
      await gateway.settled();
      await polling;
      await registration;
    },
  };
};
