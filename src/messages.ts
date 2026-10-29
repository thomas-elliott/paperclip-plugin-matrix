import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { sendNotice, type Matrix, type SentEvent } from "./matrix.js";

// What the plugin's messages say and where they go, shared by plain notifications and decisions.

const threadKey = (issueId: string) => ({ scopeKind: "issue", scopeId: issueId, stateKey: "matrixThread" }) as const;
const issueKey = (companyId: string, rootEventId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "threads", stateKey: rootEventId }) as const;

// The root of the issue's Matrix thread, or null if it has none yet.
export async function issueThread(ctx: PluginContext, issueId: string): Promise<SentEvent | null> {
  return ((await ctx.state.get(threadKey(issueId))) as SentEvent | null) ?? null;
}

// The issue whose thread starts at this event, or null.
export async function issueOfThread(ctx: PluginContext, companyId: string, rootEventId: string): Promise<string | null> {
  return ((await ctx.state.get(issueKey(companyId, rootEventId))) as string | null) ?? null;
}

export async function rememberIssueThread(ctx: PluginContext, companyId: string, issueId: string, root: SentEvent) {
  await ctx.state.set(threadKey(issueId), root);
  await ctx.state.set(issueKey(companyId, root.eventId), issueId);
}

export type Notice = { text: string; html: string };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function notice(summary: string, link: string | null): Notice {
  return {
    text: link ? `${summary}\n${link}` : summary,
    html: link ? `${escapeHtml(summary)} <a href="${escapeHtml(link)}">Open in Paperclip</a>` : escapeHtml(summary),
  };
}

// Paperclip's web pages live under the company's issue prefix, such as /ACME/issues/ACME-7.
export async function pageUrl(ctx: PluginContext, matrix: Matrix, companyId: string, path: string): Promise<string | null> {
  if (!matrix.paperclipUrl) return null;
  const company = await ctx.companies.get(companyId);
  return company ? `${matrix.paperclipUrl}/${company.issuePrefix}/${path}` : null;
}

export function issueLabel(issue: { identifier: string | null; title: string }): string {
  return issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
}

export async function agentName(ctx: PluginContext, agentId: string | null | undefined, companyId: string): Promise<string | null> {
  if (!agentId) return null;
  return (await ctx.agents.get(agentId, companyId))?.name ?? null;
}

// A project's own room if the settings give it one, matched by project name or ID, otherwise the default room.
export async function roomFor(ctx: PluginContext, matrix: Matrix, companyId: string, projectId: string | null): Promise<string | null> {
  if (projectId && matrix.projectRooms.length > 0) {
    const project = await ctx.projects.get(projectId, companyId);
    const names = [projectId.toLowerCase(), project?.name.toLowerCase()];
    const match = matrix.projectRooms.find((entry) => names.includes(entry.project.toLowerCase()));
    if (match) return match.room;
  }
  return matrix.defaultRoom;
}

// Using the event ID as the transaction ID means a redelivered event is not posted twice.
export const transactionId = (event: PluginEvent) => `paperclip-${event.eventId}`;

// Posts in the issue's thread. The first message about an issue starts its thread, in the room the
// issue's project uses at that time; the thread stays in that room. Returns the message posted, or
// null when there is no room to post in.
export async function postAboutIssue(
  ctx: PluginContext,
  matrix: Matrix,
  companyId: string,
  issue: { id: string; projectId: string | null },
  txnId: string,
  message: Notice,
): Promise<SentEvent | null> {
  const thread = await issueThread(ctx, issue.id);
  if (thread) return sendNotice(ctx, matrix, thread.roomId, txnId, message, thread.eventId);
  const room = await roomFor(ctx, matrix, companyId, issue.projectId);
  if (!room) return null;
  const root = await sendNotice(ctx, matrix, room, txnId, message);
  await rememberIssueThread(ctx, companyId, issue.id, root);
  return root;
}
