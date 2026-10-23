import type { Slack } from "./slack.ts";
import { type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type Inbound = {
  readonly source: "threads-view" | "own-thread" | "unread";
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly user?: string;
  readonly text?: string;
};

type Msg = { readonly ts?: string; readonly thread_ts?: string; readonly user?: string; readonly text?: string; readonly bot_id?: string; readonly channel?: string };
type ThreadView = { readonly root_msg?: Msg & { readonly channel?: string }; readonly unread_replies?: readonly Msg[] };
type Counted = { readonly id: string; readonly has_unreads?: boolean; readonly mention_count?: number };

export type InboundOptions = { readonly selfUserId: string; readonly threadsViewLimit?: number };

export const pollSlackInbound = async (slack: Slack, ledger: ThreadLedger, opts: InboundOptions): Promise<Inbound[]> => {
  const out: Inbound[] = [];
  const seen = new Set<string>();
  const add = (i: Inbound) => {
    const k = `${i.channel}:${i.ts}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  const fromOthers = (m: Msg) => m.user !== undefined && m.user !== opts.selfUserId && !m.bot_id;

  const view = (await slack.call("subscriptions.thread.getView", { limit: opts.threadsViewLimit ?? 20 })) as { threads?: readonly ThreadView[] };
  for (const t of view.threads ?? []) {
    const channel = t.root_msg?.channel;
    if (!channel) continue;
    for (const m of t.unread_replies ?? []) {
      if (!m.ts || !fromOthers(m)) continue;
      add({ source: "threads-view", channel, ts: m.ts, threadTs: m.thread_ts, user: m.user, text: m.text });
      if (m.thread_ts) await ledger.markSeen(channel, m.thread_ts, m.ts);
    }
  }

  for (const t of await ledger.list()) {
    const r = (await slack.call("conversations.replies", { channel: t.channel, ts: t.rootTs, oldest: t.seenTs, inclusive: false, limit: 50 })) as { messages?: readonly Msg[] };
    let newest = t.seenTs;
    for (const m of r.messages ?? []) {
      if (!m.ts || !tsAfter(m.ts, t.seenTs)) continue;
      if (tsAfter(m.ts, newest)) newest = m.ts;
      if (fromOthers(m)) add({ source: "own-thread", channel: t.channel, ts: m.ts, threadTs: t.rootTs, user: m.user, text: m.text });
    }
    if (newest !== t.seenTs) await ledger.markSeen(t.channel, t.rootTs, newest);
  }

  const counts = (await slack.call("client.counts", {})) as { channels?: readonly Counted[]; ims?: readonly Counted[]; mpims?: readonly Counted[] };
  for (const c of [...(counts.ims ?? []), ...(counts.mpims ?? []), ...(counts.channels ?? []).filter((c) => (c.mention_count ?? 0) > 0)]) {
    if (c.has_unreads || (c.mention_count ?? 0) > 0) add({ source: "unread", channel: c.id, ts: "", text: `${c.mention_count ?? 0} mention(s), unread` });
  }
  return out;
};
