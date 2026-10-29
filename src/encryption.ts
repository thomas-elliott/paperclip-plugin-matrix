import type { PluginContext } from "@paperclipai/plugin-sdk";
import { request, roomIdOf, sendNotice, type Matrix } from "./matrix.js";
import { notice } from "./messages.js";

// The bot cannot decrypt messages (see docs/PLAN.md), so in an encrypted room it hears nothing. Rather
// than stay silent, it says so once per room, unencrypted so everyone there can read it.

const CANNOT_READ =
  "I cannot read encrypted messages, so I will not see anything said in this room. Encryption cannot be turned off once it is on: to work with me, create a room with encryption turned off and invite me to it.";

const warnedKey = (companyId: string, roomId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "encrypted-rooms", stateKey: roomId }) as const;

export async function sayCannotRead(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string) {
  if (await ctx.state.get(warnedKey(companyId, roomId))) return;
  ctx.logger.warn("A Matrix room is encrypted, so the bot cannot read it", { companyId, roomId });
  await sendNotice(ctx, matrix, roomId, `cannot-read-${roomId}`, notice(CANNOT_READ, null));
  await ctx.state.set(warnedKey(companyId, roomId), true);
}

// A room is encrypted when it has an m.room.encryption state event. Without one the homeserver
// answers 404; any other failure, such as a room the bot is not in, is also treated as unencrypted.
export async function sayIfCannotRead(ctx: PluginContext, matrix: Matrix, companyId: string, room: string) {
  const roomId = await roomIdOf(ctx, matrix, room);
  const encrypted = await request(ctx, matrix, `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`).then(
    () => true,
    () => false,
  );
  if (encrypted) await sayCannotRead(ctx, matrix, companyId, roomId);
}
