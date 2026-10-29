import type { PluginContext } from "@paperclipai/plugin-sdk";
import { completeLink, LINK_COMMAND, linkedUser } from "./links.js";
import { sendReaction, type Matrix, type SentEvent } from "./matrix.js";

// Each issue has one Matrix thread: the first message the plugin posts about it is the thread's root.

export type RoomEvent = {
  type: string;
  sender: string;
  event_id: string;
  content: { msgtype?: string; body?: string; "m.relates_to"?: { rel_type?: string; event_id?: string; key?: string } };
};

const threadKey = (issueId: string) => ({ scopeKind: "issue", scopeId: issueId, stateKey: "matrixThread" }) as const;
const issueKey = (companyId: string, rootEventId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "threads", stateKey: rootEventId }) as const;

export async function issueThread(ctx: PluginContext, issueId: string): Promise<SentEvent | null> {
  return ((await ctx.state.get(threadKey(issueId))) as SentEvent | null) ?? null;
}

export async function rememberIssueThread(ctx: PluginContext, companyId: string, issueId: string, root: SentEvent) {
  await ctx.state.set(threadKey(issueId), root);
  await ctx.state.set(issueKey(companyId, root.eventId), issueId);
}

// Handles one message someone sent in a room the bot is in: a link code, or a reply in an issue
// thread from a linked user, which becomes their comment on the issue. Everything else is ignored.
export async function handleRoomEvent(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string, event: RoomEvent) {
  // Only typed text; the bot's own messages are notices, so this also skips them.
  if (event.type !== "m.room.message" || event.content.msgtype !== "m.text" || !event.content.body) return;
  const body = event.content.body.trim();

  const linkCode = LINK_COMMAND.exec(body)?.[1];
  if (linkCode) {
    if (await completeLink(ctx, companyId, event.sender, linkCode)) await sendReaction(ctx, matrix, roomId, event.event_id, "✅");
    return;
  }

  const relation = event.content["m.relates_to"];
  if (relation?.rel_type !== "m.thread" || !relation.event_id) return;
  const issueId = (await ctx.state.get(issueKey(companyId, relation.event_id))) as string | null;
  if (!issueId) return;
  const userId = await linkedUser(ctx, companyId, event.sender);
  if (!userId) return;

  await ctx.issues.createComment(issueId, body, companyId, { actorUserId: userId });
  await sendReaction(ctx, matrix, roomId, event.event_id, "✅");
}
