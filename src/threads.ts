import type { Agent, PluginContext, Project } from "@paperclipai/plugin-sdk";
import { completeLink, LINK_COMMAND, linkedUser } from "./links.js";
import manifest from "./manifest.js";
import { joinRoom, roomIdOf, sendNotice, sendReaction, type Bot, type Matrix } from "./matrix.js";
import { issueLabel, issueOfThread, notice, pageUrl, rememberIssueThread } from "./messages.js";

// Each issue has one Matrix thread. Its root is the first message the plugin posts about the issue,
// or, for an issue someone asked for from Matrix, the message that asked.

// Issues created from a Matrix message. originId is the message's event ID.
export const MESSAGE_ORIGIN = `plugin:${manifest.id}:message` as const;

// Long enough for a one-line request; the whole message is the issue's description.
const MAX_TITLE_LENGTH = 120;

export type RoomEvent = {
  type: string;
  sender: string;
  event_id: string;
  content: {
    msgtype?: string;
    body?: string;
    "m.mentions"?: { user_ids?: string[] };
    "m.relates_to"?: { rel_type?: string; event_id?: string; key?: string; "m.in_reply_to"?: { event_id?: string } };
  };
};

// The state events an invite carries. The bot's own membership event says who invited it.
export type InviteEvent = { type: string; sender: string; state_key?: string; content: { membership?: string; is_direct?: boolean } };

const directRoomKey = (companyId: string, roomId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "direct-rooms", stateKey: roomId }) as const;

// Handles one message someone sent in a room the bot is in: a link code, a reply in an issue thread,
// or a request for work. Only linked people's replies and requests count; everything else is ignored.
export async function handleRoomEvent(ctx: PluginContext, matrix: Matrix, bot: Bot, companyId: string, roomId: string, event: RoomEvent) {
  // Only typed text; the bot's own messages are notices, so this also skips them.
  if (event.type !== "m.room.message" || event.content.msgtype !== "m.text" || !event.content.body) return;
  const body = event.content.body.trim();

  const linkCode = LINK_COMMAND.exec(body)?.[1];
  if (linkCode) {
    if (await completeLink(ctx, companyId, event.sender, linkCode)) await sendReaction(ctx, matrix, roomId, event.event_id, "✅");
    return;
  }

  // A message in any thread is a reply there, never a new request: Matrix threads cannot hold threads.
  const relation = event.content["m.relates_to"];
  if (relation?.rel_type === "m.thread") {
    if (relation.event_id) await copyReply(ctx, matrix, companyId, roomId, event, relation.event_id, body);
    return;
  }
  if (await asksBot(ctx, bot, companyId, roomId, event)) await startWork(ctx, matrix, bot, companyId, roomId, event, body);
}

// A linked person's reply in an issue thread becomes their comment on the issue.
async function copyReply(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string, event: RoomEvent, rootEventId: string, body: string) {
  const issueId = await issueOfThread(ctx, companyId, rootEventId);
  if (!issueId) return;
  const userId = await linkedUser(ctx, companyId, event.sender);
  if (!userId) return;

  await ctx.issues.createComment(issueId, body, companyId, { actorUserId: userId });
  await sendReaction(ctx, matrix, roomId, event.event_id, "✅");
}

// Every message in a direct message room is for the bot; elsewhere a message must mention it.
// Clients count the sender of the message being replied to as mentioned, so outside direct messages a
// reply is not a request, or replying to one of the bot's notices would start work.
async function asksBot(ctx: PluginContext, bot: Bot, companyId: string, roomId: string, event: RoomEvent): Promise<boolean> {
  if (await ctx.state.get(directRoomKey(companyId, roomId))) return true;
  if (event.content["m.relates_to"]?.["m.in_reply_to"]) return false;
  return event.content["m.mentions"]?.user_ids?.includes(bot.userId) ?? false;
}

// Someone invited the bot to a room. Only linked people's invites are accepted, so strangers cannot
// pull the bot into their rooms. A direct message invite makes every message in that room a request.
export async function handleInvite(ctx: PluginContext, matrix: Matrix, bot: Bot, companyId: string, roomId: string, inviteState: InviteEvent[]) {
  const invite = inviteState.find((event) => event.type === "m.room.member" && event.state_key === bot.userId);
  if (invite?.content.membership !== "invite" || !(await linkedUser(ctx, companyId, invite.sender))) return;
  await joinRoom(ctx, matrix, roomId);
  if (invite.content.is_direct) await ctx.state.set(directRoomKey(companyId, roomId), true);
}

// Clients start a message that mentions someone with their display name, or their Matrix ID when
// typed by hand, such as "Paperclip: fix the login page". That prefix is not part of the request.
function withoutBotMention(body: string, bot: Bot): string {
  for (const name of [bot.userId, bot.displayName]) {
    if (name && body.startsWith(name)) return body.slice(name.length).replace(/^[:,]?\s*/, "");
  }
  return body;
}

function titleOf(request: string): string {
  const firstLine = request.split("\n")[0].trim();
  return firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH)}…` : firstLine;
}

// "@url-key" as a whole word, as the Forgejo plugin matches it. A Matrix ID such as
// @builder:example.com names a person, not the agent with URL key "builder".
function mentionsAgent(text: string, urlKey: string): boolean {
  const escaped = urlKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])@${escaped}(?![\\w-]|:\\S)`, "i").test(text);
}

// The project whose room this is, if the settings give the room to one. A room the bot cannot look
// up is skipped, so one wrong alias in the settings does not stop requests in every room.
async function projectOfRoom(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string): Promise<Project | null> {
  for (const entry of matrix.projectRooms) {
    if ((await roomIdOf(ctx, matrix, entry.room).catch(() => null)) !== roomId) continue;
    const wanted = entry.project.toLowerCase();
    const projects = await ctx.projects.list({ companyId });
    return projects.find((project) => project.id.toLowerCase() === wanted || project.name.toLowerCase() === wanted) ?? null;
  }
  return null;
}

// An agent the request mentions, otherwise the project's lead agent, otherwise the default agent.
async function chooseAgent(ctx: PluginContext, matrix: Matrix, companyId: string, project: Project | null, request: string): Promise<Agent | null> {
  const agents = (await ctx.agents.list({ companyId })).filter((agent) => agent.status !== "terminated");
  const mentioned = agents.find((agent) => mentionsAgent(request, agent.urlKey));
  if (mentioned) return mentioned;
  if (project?.leadAgentId) return agents.find((agent) => agent.id === project.leadAgentId) ?? null;
  const wanted = matrix.defaultAgent?.toLowerCase();
  return agents.find((agent) => agent.urlKey.toLowerCase() === wanted || agent.name.toLowerCase() === wanted) ?? null;
}

// A linked person's request becomes an issue they created, assigned to an agent and ready for it to
// start. Their message is the root of the issue's thread, so the agent's comments land under it and
// their replies there carry on the conversation.
async function startWork(ctx: PluginContext, matrix: Matrix, bot: Bot, companyId: string, roomId: string, event: RoomEvent, body: string) {
  const userId = await linkedUser(ctx, companyId, event.sender);
  const request = withoutBotMention(body, bot);
  if (!userId || !request) return;
  // The sync loop reads a message again if the plugin stops before saving its position.
  const [existing] = await ctx.issues.list({ companyId, originKind: MESSAGE_ORIGIN, originId: event.event_id });
  if (existing) return;

  const project = await projectOfRoom(ctx, matrix, companyId, roomId);
  const agent = await chooseAgent(ctx, matrix, companyId, project, request);
  if (!agent) {
    const reason = "No agent to give this to. Mention one as @url-key, or set a default agent in the plugin settings.";
    await sendNotice(ctx, matrix, roomId, `no-agent-${event.event_id}`, notice(reason, null), event.event_id);
    return;
  }

  const issue = await ctx.issues.create({
    companyId,
    projectId: project?.id,
    title: titleOf(request),
    description: request,
    status: "todo",
    assigneeAgentId: agent.id,
    originKind: MESSAGE_ORIGIN,
    originId: event.event_id,
    actor: { actorUserId: userId },
  });
  await rememberIssueThread(ctx, companyId, issue.id, { roomId, eventId: event.event_id });
  await sendReaction(ctx, matrix, roomId, event.event_id, "✅");
  // Replaces the usual "New issue" message, which is not posted for these issues.
  const link = await pageUrl(ctx, matrix, companyId, `issues/${issue.identifier ?? issue.id}`);
  await sendNotice(ctx, matrix, roomId, `created-${issue.id}`, notice(`Created ${issueLabel(issue)}, assigned to ${agent.name}`, link), event.event_id);
}
