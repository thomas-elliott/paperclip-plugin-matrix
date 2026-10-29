import { setTimeout as sleep } from "node:timers/promises";
import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";

export const NOT_CONFIGURED = "Set the homeserver address and access token in the plugin settings.";

export type Matrix = {
  homeserverUrl: string;
  token: string;
  // Paperclip's own address for links in messages, without a trailing slash. Null when not set.
  paperclipUrl: string | null;
  // A room ID (!abc) or alias (#name:server), as typed in the settings.
  defaultRoom: string | null;
  // The agent that gets work asked for outside a project's room, by URL key or name. Null when not set.
  defaultAgent: string | null;
  // Paperclip's fetch refuses private addresses, so a homeserver on a private network is called directly.
  privateNetwork: boolean;
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function connect(ctx: PluginContext, companyId: string): Promise<Matrix | null> {
  const config = await ctx.config.get(companyId);
  const homeserverUrl = trimmed(config.homeserverUrl)?.replace(/\/+$/, "");
  if (!homeserverUrl || !config.accessToken) return null;

  // Resolve the token on every call: Paperclip forbids caching secret values.
  const token = await ctx.secrets.resolve(config.accessToken as EnvSecretRefBinding, { companyId, configPath: "accessToken" });
  return {
    homeserverUrl,
    token,
    paperclipUrl: trimmed(config.paperclipUrl)?.replace(/\/+$/, "") ?? null,
    defaultRoom: trimmed(config.defaultRoom),
    defaultAgent: trimmed(config.defaultAgent),
    privateNetwork: config.privateNetwork === true,
  };
}

type RequestOptions = { method?: string; body?: unknown };

// Homeservers limit how fast an account may send, and say how long to wait before trying again.
// A longer wait than this fails the request instead of holding up everything behind it.
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;

// Calls the Matrix client-server API and returns the parsed JSON body. Matrix reports errors as
// JSON with `errcode` and `error`, so those become the thrown message.
export async function request<T>(ctx: PluginContext, matrix: Matrix, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${matrix.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${matrix.homeserverUrl}/_matrix/client/v3${path}`;
  const init = { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) };
  for (let attempt = 1; ; attempt += 1) {
    // Bypassing ctx.http.fetch is safe because only an instance admin can set the homeserver address.
    // The timeout matches ctx.http.fetch's.
    const response = matrix.privateNetwork
      ? await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
      : await ctx.http.fetch(url, init);
    const body = (await response.json().catch(() => ({}))) as T & { errcode?: string; error?: string; retry_after_ms?: number };
    const wait = body.retry_after_ms ?? 1000;
    if (response.status === 429 && attempt < MAX_ATTEMPTS && wait <= MAX_RATE_LIMIT_WAIT_MS) {
      await sleep(wait);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Matrix answered HTTP ${response.status}${body.errcode ? `: ${body.errcode} ${body.error ?? ""}` : ""}`);
    }
    return body;
  }
}

// Messages are sent to room IDs; an alias is looked up in the room directory first.
export async function roomIdOf(ctx: PluginContext, matrix: Matrix, room: string): Promise<string> {
  if (!room.startsWith("#")) return room;
  const { room_id } = await request<{ room_id: string }>(ctx, matrix, `/directory/room/${encodeURIComponent(room)}`);
  return room_id;
}

// The bot's own account. People's clients put its display name in a message's text when they mention it.
export type Bot = { userId: string; displayName: string | null };

export async function whoAmI(ctx: PluginContext, matrix: Matrix): Promise<Bot> {
  const { user_id } = await request<{ user_id: string }>(ctx, matrix, "/account/whoami");
  // An account without a display name gets a 404.
  const profile = await request<{ displayname?: string }>(ctx, matrix, `/profile/${encodeURIComponent(user_id)}`).catch(() => ({ displayname: undefined }));
  return { userId: user_id, displayName: profile.displayname ?? null };
}

export async function joinRoom(ctx: PluginContext, matrix: Matrix, room: string): Promise<void> {
  await request(ctx, matrix, `/join/${encodeURIComponent(room)}`, { method: "POST", body: {} });
}

export type SentEvent = { roomId: string; eventId: string };

async function sendEvent(ctx: PluginContext, matrix: Matrix, roomId: string, type: string, txnId: string, content: unknown): Promise<SentEvent> {
  const path = `/rooms/${encodeURIComponent(roomId)}/send/${type}/${encodeURIComponent(txnId)}`;
  const { event_id } = await request<{ event_id: string }>(ctx, matrix, path, { method: "PUT", body: content });
  return { roomId, eventId: event_id };
}

// Posts a notice: the message type Matrix gives bots, so other bots do not answer it. With
// `threadRoot`, the notice goes in that event's thread; clients without threads show it as a reply.
// The homeserver ignores a repeated transaction ID, so giving the same `txnId` twice posts once.
export async function sendNotice(
  ctx: PluginContext,
  matrix: Matrix,
  room: string,
  txnId: string,
  message: { text: string; html: string },
  threadRoot?: string,
): Promise<SentEvent> {
  const roomId = await roomIdOf(ctx, matrix, room);
  return sendEvent(ctx, matrix, roomId, "m.room.message", txnId, {
    msgtype: "m.notice",
    body: message.text,
    format: "org.matrix.custom.html",
    formatted_body: message.html,
    ...(threadRoot
      ? { "m.relates_to": { rel_type: "m.thread", event_id: threadRoot, is_falling_back: true, "m.in_reply_to": { event_id: threadRoot } } }
      : {}),
  });
}

// Replaces a notice's text. Clients show the new text in place of the old, marked as edited; the body
// outside `m.new_content` is what clients without edits show, starred by convention.
export async function editNotice(ctx: PluginContext, matrix: Matrix, original: SentEvent, txnId: string, message: { text: string; html: string }) {
  const content = { msgtype: "m.notice", body: message.text, format: "org.matrix.custom.html", formatted_body: message.html };
  await sendEvent(ctx, matrix, original.roomId, "m.room.message", txnId, {
    ...content,
    body: `* ${message.text}`,
    formatted_body: `* ${message.html}`,
    "m.new_content": content,
    "m.relates_to": { rel_type: "m.replace", event_id: original.eventId },
  });
}

export async function sendReaction(ctx: PluginContext, matrix: Matrix, roomId: string, eventId: string, key: string): Promise<void> {
  await sendEvent(ctx, matrix, roomId, "m.reaction", `reaction-${eventId}-${key}`, {
    "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
  });
}
