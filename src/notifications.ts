import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { approvalCreated, approvalDecided, updateInteractionMessages } from "./decisions.js";
import { connect, errorMessage, sendNotice, type Matrix } from "./matrix.js";
import { agentName, escapeHtml, issueLabel, notice, pageUrl, postAboutIssue, roomFor, transactionId, type Notice } from "./messages.js";
import { issueThread } from "./threads.js";

// Long run errors, such as stack traces, would bury the room; the full error is in Paperclip.
const MAX_ERROR_LENGTH = 300;
// Well under Matrix's 64 KiB limit on an event, and about a screenful.
const MAX_COMMENT_LENGTH = 4000;

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function post(ctx: PluginContext, matrix: Matrix, event: PluginEvent, projectId: string | null, message: Notice) {
  const room = await roomFor(ctx, matrix, event.companyId, projectId);
  if (room) await sendNotice(ctx, matrix, room, transactionId(event), message);
}

async function issueCreated(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const issue = event.entityId ? await ctx.issues.get(event.entityId, event.companyId) : null;
  if (!issue) return;
  const agent = await agentName(ctx, issue.assigneeAgentId, event.companyId);
  const summary = `New issue: ${issueLabel(issue)}${agent ? `, assigned to ${agent}` : ""}`;
  const link = await pageUrl(ctx, matrix, event.companyId, `issues/${issue.identifier ?? issue.id}`);
  await postAboutIssue(ctx, matrix, event.companyId, issue, transactionId(event), notice(summary, link));
}

// issue.updated lists the fields that changed, with their old values under `_previous`. Only the
// change into done is news; later edits to a done issue are not.
async function issueUpdated(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const payload = event.payload as { status?: string; _previous?: { status?: string } };
  const previousStatus = payload._previous?.status;
  if (payload.status !== "done" || !previousStatus || previousStatus === "done") return;

  const issue = event.entityId ? await ctx.issues.get(event.entityId, event.companyId) : null;
  if (!issue) return;
  const link = await pageUrl(ctx, matrix, event.companyId, `issues/${issue.identifier ?? issue.id}`);
  await postAboutIssue(ctx, matrix, event.companyId, issue, transactionId(event), notice(`Done: ${issueLabel(issue)}`, link));
}

async function runFailed(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const payload = event.payload as { runId?: string; agentId?: string; issueId?: string | null; error?: string | null };
  const agent = (await agentName(ctx, payload.agentId, event.companyId)) ?? "An agent";
  const issue = payload.issueId ? await ctx.issues.get(payload.issueId, event.companyId) : null;
  const error = payload.error ? `: ${payload.error.slice(0, MAX_ERROR_LENGTH)}` : "";
  const summary = `${agent}'s run failed${issue ? ` on ${issue.identifier ?? issue.title}` : ""}${error}`;
  const link = payload.agentId && payload.runId
    ? await pageUrl(ctx, matrix, event.companyId, `agents/${payload.agentId}/runs/${payload.runId}`)
    : null;
  if (!issue) {
    await post(ctx, matrix, event, null, notice(summary, link));
    return;
  }
  await postAboutIssue(ctx, matrix, event.companyId, issue, transactionId(event), notice(summary, link));
  await updateInteractionMessages(ctx, matrix, event.companyId, issue.id);
}

// Agents ask questions and request confirmations during their runs, and Paperclip sends no event
// for that, so the plugin looks when a run on an issue ends. A person's answer in Paperclip wakes the
// agent, so the next run's end also updates the message to show the answer.
async function runFinished(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const { issueId } = event.payload as { issueId?: string | null };
  if (issueId) await updateInteractionMessages(ctx, matrix, event.companyId, issueId);
}

// Agents' comments go to the issue's thread, so a conversation started in Matrix can carry on
// there. Comments copied from Matrix are recorded as the plugin's, so they are not posted back, and
// comments people write in Paperclip stay in Paperclip. An issue without a thread gets none.
async function commentCreated(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  if (event.actorType !== "agent" || !event.entityId) return;
  const thread = await issueThread(ctx, event.entityId);
  if (!thread) return;

  // The event carries only the start of the comment.
  const { commentId, identifier } = event.payload as { commentId?: string; identifier?: string | null };
  const comments = await ctx.issues.listComments(event.entityId, event.companyId);
  const comment = comments.find((candidate) => candidate.id === commentId);
  if (!comment) return;

  const agent = (await agentName(ctx, comment.authorAgentId, event.companyId)) ?? "An agent";
  const cut = comment.body.length > MAX_COMMENT_LENGTH;
  const body = cut ? `${comment.body.slice(0, MAX_COMMENT_LENGTH)}…` : comment.body;
  const link = cut ? await pageUrl(ctx, matrix, event.companyId, `issues/${identifier ?? event.entityId}`) : null;

  const text = `${agent}:\n${body}${link ? `\n\nThe rest is in Paperclip: ${link}` : ""}`;
  const html = `<strong>${escapeHtml(agent)}:</strong><br>${escapeHtml(body).replaceAll("\n", "<br>")}${link ? `<br><br><a href="${escapeHtml(link)}">Read the rest in Paperclip</a>` : ""}`;
  await sendNotice(ctx, matrix, thread.roomId, transactionId(event), { text, html }, thread.eventId);
}

// Paperclip opens an incident when spending crosses a budget's warning level, and again when it
// reaches the limit, which pauses the work. Amounts are in cents.
async function budgetIncident(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const payload = event.payload as { scopeType?: string; scopeId?: string; amountObserved?: number; amountLimit?: number };
  if (!payload.scopeId || payload.amountObserved === undefined || payload.amountLimit === undefined) return;

  let scope: string | null = null;
  if (payload.scopeType === "agent") scope = await agentName(ctx, payload.scopeId, event.companyId);
  if (payload.scopeType === "project") scope = (await ctx.projects.get(payload.scopeId, event.companyId))?.name ?? null;
  if (payload.scopeType === "company") scope = (await ctx.companies.get(event.companyId))?.name ?? null;

  const spent = `${scope ?? "A budget"} has spent ${dollars(payload.amountObserved)} of ${dollars(payload.amountLimit)}.`;
  const summary = payload.amountObserved >= payload.amountLimit
    ? `Budget limit reached: ${spent} Its work is paused.`
    : `Budget warning: ${spent}`;
  const link = await pageUrl(ctx, matrix, event.companyId, "costs");
  await post(ctx, matrix, event, payload.scopeType === "project" ? payload.scopeId : null, notice(summary, link));
}

const handlers = {
  "issue.created": issueCreated,
  "issue.updated": issueUpdated,
  "approval.created": approvalCreated,
  "approval.decided": approvalDecided,
  "agent.run.finished": runFinished,
  "agent.run.failed": runFailed,
  "budget.incident.opened": budgetIncident,
  "issue.comment.created": commentCreated,
} as const;

export function registerNotifications(ctx: PluginContext) {
  for (const [eventType, handler] of Object.entries(handlers)) {
    ctx.events.on(eventType as keyof typeof handlers, async (event) => {
      try {
        const matrix = await connect(ctx, event.companyId);
        if (matrix) await handler(ctx, matrix, event);
      } catch (error) {
        ctx.logger.warn("Could not post a Paperclip event to Matrix", { eventType, eventId: event.eventId, error: errorMessage(error) });
      }
    });
  }
}
