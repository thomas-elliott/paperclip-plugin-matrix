import { vi } from "vitest";

// An in-memory Matrix homeserver serving the client-server API routes the plugin uses, installed as
// the global fetch (the test harness passes ctx.http.fetch straight to it). Shapes follow the
// Matrix spec, cut down to the fields the plugin reads.

export const HOMESERVER = "https://matrix.example.com";
export const BOT_USER = "@paperclip:example.com";
export const BOT_NAME = "Paperclip";
const API = `${HOMESERVER}/_matrix/client/v3`;

type Content = Record<string, unknown> & { body?: string; formatted_body?: string; msgtype?: string };
export type SentEvent = { roomId: string; type: string; txnId: string; eventId: string; content: Content };
export type RoomEvent = { type: string; sender: string; event_id: string; content: Content };

export class FakeHomeserver {
  sent: SentEvent[] = [];
  joined: string[] = [];
  // Room aliases the directory knows, alias to room ID.
  aliases = new Map<string, string>();
  // Room names (m.room.name state), room ID to name.
  roomNames = new Map<string, string>();
  // Rooms with encryption turned on (m.room.encryption state).
  encryptedRooms = new Set<string>();
  // The account the access token belongs to.
  userId = BOT_USER;
  // How many of the next sends to refuse as over the rate limit.
  rateLimitSends = 0;
  // The position each /sync asked from, oldest first; null for a first sync.
  syncedFrom: (string | null)[] = [];
  // Everything other users have done, in order. A /sync hands over whatever came after the position
  // it asks from, so asking from an old position hands the same events over again, as Matrix does.
  private timeline: { position: number; roomId: string; event?: RoomEvent; invite?: { inviter: string; isDirect: boolean } }[] = [];
  private position = 0;
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
    this.position += 1;
    this.timeline.push({ position: this.position, roomId, event });
  }

  // Another user invites the bot to a room; `isDirect` marks a direct message invite.
  invite(roomId: string, inviter: string, isDirect: boolean) {
    this.position += 1;
    this.timeline.push({ position: this.position, roomId, invite: { inviter, isDirect } });
  }

  // Resolves once the plugin has handled everything delivered so far: it asks for a later batch only
  // when it has finished with the earlier ones. Also waits for the plugin's first sync.
  async read() {
    await vi.waitFor(() => {
      if (positionOf(this.lastSince) < this.position) throw new Error("The plugin has not read the room yet");
    });
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    if (!url.startsWith(API)) return new Response(null, { status: 404 });
    const path = new URL(url).pathname.slice(new URL(API).pathname.length);
    const method = init?.method ?? "GET";
    const segments = path.split("/").slice(1).map(decodeURIComponent);

    if (method === "GET" && path === "/account/whoami") return Response.json({ user_id: this.userId });
    if (method === "GET" && segments[0] === "profile" && segments[1] === BOT_USER) return Response.json({ displayname: BOT_NAME });
    if (method === "GET" && path === "/joined_rooms") return Response.json({ joined_rooms: [...new Set(this.joined)] });
    if (method === "GET" && segments[0] === "rooms" && segments[2] === "state" && segments[3] === "m.room.name") {
      const name = this.roomNames.get(segments[1]);
      return name ? Response.json({ name }) : notFound("Event not found");
    }
    if (method === "GET" && segments[0] === "rooms" && segments[2] === "state" && segments[3] === "m.room.encryption") {
      return this.encryptedRooms.has(segments[1]) ? Response.json({ algorithm: "m.megolm.v1.aes-sha2" }) : notFound("Event not found");
    }
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
      if (this.rateLimitSends > 0) {
        this.rateLimitSends -= 1;
        return Response.json({ errcode: "M_LIMIT_EXCEEDED", error: "Too many requests", retry_after_ms: 10 }, { status: 429 });
      }
      const existing = this.sent.find((event) => event.txnId === txnId);
      if (existing) return Response.json({ event_id: existing.eventId });
      const eventId = `$sent-${this.sent.length + 1}`;
      this.sent.push({ roomId, type, txnId, eventId, content: JSON.parse(String(init?.body)) });
      return Response.json({ event_id: eventId });
    }

    return new Response(null, { status: 404 });
  }

  // Hands over everything after the position asked from. With nothing new, it waits briefly before
  // answering, as a real long-poll does, so the plugin's loop does not spin.
  private async sync(since: string | null): Promise<Response> {
    this.lastSince = since;
    this.syncedFrom.push(since);
    const from = positionOf(since);
    if (!this.timeline.some((entry) => entry.position > from)) await new Promise((resolve) => setTimeout(resolve, 5));
    // The plugin's first sync asks for no history, so it gets nothing.
    const entries = since ? this.timeline.filter((entry) => entry.position > from) : [];
    const join: Record<string, { timeline: { events: RoomEvent[] } }> = {};
    const invite: Record<string, { invite_state: { events: unknown[] } }> = {};
    for (const { roomId, event, invite: invited } of entries) {
      if (event) {
        join[roomId] ??= { timeline: { events: [] } };
        join[roomId].timeline.events.push(event);
      }
      if (invited) {
        const membership = { type: "m.room.member", sender: invited.inviter, state_key: this.userId, content: { membership: "invite", is_direct: invited.isDirect } };
        invite[roomId] = { invite_state: { events: [membership] } };
      }
    }
    return Response.json({ next_batch: `s${this.position}`, rooms: { join, invite } });
  }
}

// Positions are handed out as "s" and a number. No position, before the first sync, is before them all.
function positionOf(since: string | null): number {
  return since ? Number(since.slice(1)) : -1;
}

function notFound(error: string) {
  return Response.json({ errcode: "M_NOT_FOUND", error }, { status: 404 });
}
