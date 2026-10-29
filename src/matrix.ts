import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";

export const NOT_CONFIGURED = "Set the homeserver address and access token in the plugin settings.";

export type ProjectRoom = { project: string; room: string };

export type Matrix = {
  homeserverUrl: string;
  token: string;
  // Paperclip's own address for links in messages, without a trailing slash. Null when not set.
  paperclipUrl: string | null;
  // A room ID (!abc) or alias (#name:server), as typed in the settings.
  defaultRoom: string | null;
  projectRooms: ProjectRoom[];
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
  const projectRooms = Array.isArray(config.projectRooms) ? (config.projectRooms as Partial<ProjectRoom>[]) : [];
  return {
    homeserverUrl,
    token,
    paperclipUrl: trimmed(config.paperclipUrl)?.replace(/\/+$/, "") ?? null,
    defaultRoom: trimmed(config.defaultRoom),
    projectRooms: projectRooms.flatMap((entry) => {
      const project = trimmed(entry.project);
      const room = trimmed(entry.room);
      return project && room ? [{ project, room }] : [];
    }),
  };
}

type RequestOptions = { method?: string; body?: unknown };

// Calls the Matrix client-server API and returns the parsed JSON body. Matrix reports errors as
// JSON with `errcode` and `error`, so those become the thrown message.
export async function request<T>(ctx: PluginContext, matrix: Matrix, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${matrix.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await ctx.http.fetch(`${matrix.homeserverUrl}/_matrix/client/v3${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => ({}))) as T & { errcode?: string; error?: string };
  if (!response.ok) {
    throw new Error(`Matrix answered HTTP ${response.status}${body.errcode ? `: ${body.errcode} ${body.error ?? ""}` : ""}`);
  }
  return body;
}

// Messages are sent to room IDs; an alias is looked up in the room directory first.
async function roomIdOf(ctx: PluginContext, matrix: Matrix, room: string): Promise<string> {
  if (!room.startsWith("#")) return room;
  const { room_id } = await request<{ room_id: string }>(ctx, matrix, `/directory/room/${encodeURIComponent(room)}`);
  return room_id;
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

export async function sendReaction(ctx: PluginContext, matrix: Matrix, roomId: string, eventId: string, key: string): Promise<void> {
  await sendEvent(ctx, matrix, roomId, "m.reaction", `reaction-${eventId}`, {
    "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
  });
}
