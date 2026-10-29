import { vi } from "vitest";

// An in-memory Matrix homeserver serving the client-server API routes the plugin uses, installed as
// the global fetch (the test harness passes ctx.http.fetch straight to it). Shapes follow the
// Matrix spec, cut down to the fields the plugin reads.

export const HOMESERVER = "https://matrix.example.com";
export const BOT_USER = "@paperclip:example.com";
const API = `${HOMESERVER}/_matrix/client/v3`;

type Content = Record<string, unknown> & { body?: string; formatted_body?: string; msgtype?: string };
export type SentEvent = { roomId: string; type: string; txnId: string; eventId: string; content: Content };
export type RoomEvent = { type: string; sender: string; event_id: string; content: Content };

export class FakeHomeserver {
  sent: SentEvent[] = [];
  joined: string[] = [];
  // Room aliases the directory knows, alias to room ID.
  aliases = new Map<string, string>();
  // Events other users send, handed to the plugin by its next /sync.
  private pending: { roomId: string; event: RoomEvent }[] = [];
  private batch = 0;
  // The batch that last handed over delivered events, and the position the latest /sync asked from.
  private deliveredInBatch = 0;
  private lastSince: string | null = null;

  install() {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => this.handle(url, init)));
    return this;
  }

  // Messages the plugin sent to one room, oldest first.
  messageEventsIn(roomId: string) {
    return this.sent.filter((event) => event.roomId === roomId && event.type === "m.room.message");
  }

  messagesIn(roomId: string) {
    return this.messageEventsIn(roomId).map((event) => event.content);
  }

  reactions() {
    return this.sent.filter((event) => event.type === "m.reaction").map((event) => event.content["m.relates_to"]);
  }

  // Another user sends a message into a room.
  deliver(roomId: string, event: RoomEvent) {
    this.pending.push({ roomId, event });
  }

  // Resolves once the plugin has handled everything delivered so far: it asks for a later batch only
  // when it has finished with the earlier ones. Also waits for the plugin's first sync.
  async read() {
    await vi.waitFor(() => {
      const handledUpTo = this.lastSince ? Number(this.lastSince.slice(1)) : -1;
      if (this.pending.length > 0 || handledUpTo < this.deliveredInBatch) throw new Error("The plugin has not read the room yet");
    });
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    if (!url.startsWith(API)) return new Response(null, { status: 404 });
    const path = new URL(url).pathname.slice(new URL(API).pathname.length);
    const method = init?.method ?? "GET";
    const segments = path.split("/").slice(1).map(decodeURIComponent);

    if (method === "GET" && path === "/account/whoami") return Response.json({ user_id: BOT_USER });
    if (method === "GET" && path === "/sync") return this.sync(new URL(url).searchParams.get("since"));

    if (method === "GET" && segments[0] === "directory" && segments[1] === "room") {
      const roomId = this.aliases.get(segments[2]);
      return roomId ? Response.json({ room_id: roomId }) : notFound("Room alias not found");
    }

    if (method === "POST" && segments[0] === "join") {
      const roomId = segments[1].startsWith("#") ? this.aliases.get(segments[1]) : segments[1];
      if (!roomId) return notFound("Room alias not found");
      this.joined.push(roomId);
      return Response.json({ room_id: roomId });
    }

    // PUT /rooms/{roomId}/send/{eventType}/{txnId}. A repeated transaction ID returns the first
    // event without sending again, as Matrix does.
    if (method === "PUT" && segments[0] === "rooms" && segments[2] === "send") {
      const [, roomId, , type, txnId] = segments;
      const existing = this.sent.find((event) => event.txnId === txnId);
      if (existing) return Response.json({ event_id: existing.eventId });
      const eventId = `$sent-${this.sent.length + 1}`;
      this.sent.push({ roomId, type, txnId, eventId, content: JSON.parse(String(init?.body)) });
      return Response.json({ event_id: eventId });
    }

    return new Response(null, { status: 404 });
  }

  // Hands over everything delivered since the last sync. With nothing new, it waits briefly before
  // answering, as a real long-poll does, so the plugin's loop does not spin.
  private async sync(since: string | null): Promise<Response> {
    this.lastSince = since;
    if (this.pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    this.batch += 1;
    const join: Record<string, { timeline: { events: RoomEvent[] } }> = {};
    // The plugin's first sync asks for no history, so it gets no messages.
    const delivered = since ? this.pending.splice(0) : [];
    for (const { roomId, event } of delivered) {
      join[roomId] ??= { timeline: { events: [] } };
      join[roomId].timeline.events.push(event);
      this.deliveredInBatch = this.batch;
    }
    return Response.json({ next_batch: `s${this.batch}`, rooms: { join } });
  }
}

function notFound(error: string) {
  return Response.json({ errcode: "M_NOT_FOUND", error }, { status: 404 });
}
