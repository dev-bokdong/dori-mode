export type Platform = "slack" | "telegram" | "discord";
export type Target = { readonly to: string; readonly thread?: string };

/**
 * `dori send --to` takes a plain id or a lane thread ref (`platform:parent/thread`, as stored in `lane.thread`).
 * A ref is split into the destination and thread of that platform; an explicit `--thread` wins over the ref's.
 * Discord: a thread is a channel, so the thread id is the destination. Slack: channel + thread ts. Telegram: chat + topic.
 */
export const resolveTarget = (platform: Platform, to: string, thread?: string): Target => {
  const prefix = `${platform}:`;
  // A Discord thread is its own channel: an explicit --thread is the destination, as before the ref syntax existed.
  if (!to.startsWith(prefix)) return platform === "discord" ? { to: thread ?? to } : { to, ...(thread ? { thread } : {}) };
  const [parent = "", child = ""] = to.slice(prefix.length).split("/");
  if (!parent) throw new Error(`bad thread ref "${to}"`);
  if (platform === "discord") return { to: thread ?? (child || parent) };
  const t = thread ?? (child || undefined);
  return { to: parent, ...(t ? { thread: t } : {}) };
};
