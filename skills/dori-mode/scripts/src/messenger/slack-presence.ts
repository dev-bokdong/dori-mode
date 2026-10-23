// Slack shows a user-token account as active only while a web-client-type socket is open: rtm.connect sockets are typed
// as bot connections and never count. One such socket stays green; an idle one is auto-awayed after ~30 min, so a
// tickle frame every minute keeps it active. Never answer a manual_presence_change event with setPresence: two
// writers echo each other into a flip-flop loop.
import type { Slack } from "./slack.ts";

export type ClientLine = { isOpen(): boolean; send(frame: string): void; close(): void };
export type OpenLine = (url: string, headers: Readonly<Record<string, string>>) => ClientLine;

export const clientSocketUrl = async (slack: Slack, token: string): Promise<string> => {
  const res = await slack.call("client.getWebSocketURL", {});
  if (typeof res.primary_websocket_url !== "string" || typeof res.routing_context !== "string") throw new Error("client.getWebSocketURL returned an unexpected shape");
  const url = new URL(res.primary_websocket_url);
  const params: Record<string, string> = {
    token,
    sync_desync: "1",
    slack_client: "desktop",
    start_args: "?agent=client&org_wide_aware=true&connect_only=true&ms_latest=true",
    no_query_on_subscribe: "1",
    flannel: "3",
    lazy_channels: "1",
    gateway_server: res.routing_context,
    batch_presence_aware: "1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
};

export const slackPresence = (slack: Slack, open: OpenLine, auth: { readonly token: string; readonly cookie: string }) => {
  let line: ClientLine | null = null;
  let id = 0;
  return {
    async hold(): Promise<"opened" | "tickled"> {
      if (line?.isOpen()) {
        line.send(JSON.stringify({ type: "tickle", id: ++id }));
        return "tickled";
      }
      await slack.setPresence("auto");
      line = open(await clientSocketUrl(slack, auth.token), { Cookie: `d=${auth.cookie}`, Origin: "https://app.slack.com" });
      return "opened";
    },
    async release(): Promise<void> {
      line?.close();
      line = null;
      await slack.setPresence("away");
    },
  };
};
