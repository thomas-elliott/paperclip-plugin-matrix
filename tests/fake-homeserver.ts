import { vi } from "vitest";

// An in-memory Matrix homeserver serving the client-server API routes the plugin uses, installed as
// the global fetch (the test harness passes ctx.http.fetch straight to it). Shapes follow the
// Matrix spec, cut down to the fields the plugin reads.

export const HOMESERVER = "https://matrix.example.com";
const API = `${HOMESERVER}/_matrix/client/v3`;

export type SentMessage = { roomId: string; txnId: string; content: { msgtype: string; body: string; formatted_body?: string } };

export class FakeHomeserver {
  sent: SentMessage[] = [];
  joined: string[] = [];
  // Room aliases the directory knows, alias to room ID.
  aliases = new Map<string, string>();

  install() {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => this.handle(url, init)));
    return this;
  }

  // Messages sent to one room, oldest first.
  messagesIn(roomId: string) {
    return this.sent.filter((message) => message.roomId === roomId).map((message) => message.content);
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    if (!url.startsWith(API)) return new Response(null, { status: 404 });
    const path = new URL(url).pathname.slice(new URL(API).pathname.length);
    const method = init?.method ?? "GET";
    const segments = path.split("/").slice(1).map(decodeURIComponent);

    if (method === "GET" && path === "/account/whoami") return Response.json({ user_id: "@paperclip:example.com" });
    // Nothing happens in these tests' rooms, so the sync loop sees an empty response.
    if (method === "GET" && path === "/sync") return Response.json({ next_batch: "s1" });

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

    // PUT /rooms/{roomId}/send/m.room.message/{txnId}. A repeated transaction ID returns the
    // first event without sending again, as Matrix does.
    if (method === "PUT" && segments[0] === "rooms" && segments[2] === "send") {
      const [, roomId, , , txnId] = segments;
      const index = this.sent.findIndex((message) => message.txnId === txnId);
      if (index === -1) this.sent.push({ roomId, txnId, content: JSON.parse(String(init?.body)) });
      return Response.json({ event_id: `$event-${index === -1 ? this.sent.length : index + 1}` });
    }

    return new Response(null, { status: 404 });
  }
}

function notFound(error: string) {
  return Response.json({ errcode: "M_NOT_FOUND", error }, { status: 404 });
}
