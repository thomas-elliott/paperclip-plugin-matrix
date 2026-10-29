import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { connect, errorMessage, sendNotice, type Matrix } from "./matrix.js";
import { issueThread, rememberIssueThread } from "./threads.js";

type Notice = { text: string; html: string };

// Long run errors, such as stack traces, would bury the room; the full error is in Paperclip.
const MAX_ERROR_LENGTH = 300;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function notice(summary: string, link: string | null): Notice {
  return {
    text: link ? `${summary}\n${link}` : summary,
    html: link ? `${escapeHtml(summary)} <a href="${escapeHtml(link)}">Open in Paperclip</a>` : escapeHtml(summary),
  };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Paperclip's web pages live under the company's issue prefix, such as /ACME/issues/ACME-7.
async function pageUrl(ctx: PluginContext, matrix: Matrix, companyId: string, path: string): Promise<string | null> {
  if (!matrix.paperclipUrl) return null;
  const company = await ctx.companies.get(companyId);
  return company ? `${matrix.paperclipUrl}/${company.issuePrefix}/${path}` : null;
}

function issueLabel(issue: { identifier: string | null; title: string }): string {
  return issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
}

async function agentName(ctx: PluginContext, agentId: string | null | undefined, companyId: string): Promise<string | null> {
  if (!agentId) return null;
  return (await ctx.agents.get(agentId, companyId))?.name ?? null;
}

// A project's own room if the settings give it one, matched by project name or ID, otherwise the default room.
async function roomFor(ctx: PluginContext, matrix: Matrix, companyId: string, projectId: string | null): Promise<string | null> {
  if (projectId && matrix.projectRooms.length > 0) {
    const project = await ctx.projects.get(projectId, companyId);
    const names = [projectId.toLowerCase(), project?.name.toLowerCase()];
    const match = matrix.projectRooms.find((entry) => names.includes(entry.project.toLowerCase()));
    if (match) return match.room;
  }
  return matrix.defaultRoom;
}

// Using the event ID as the transaction ID means a redelivered event is not posted twice.
const transactionId = (event: PluginEvent) => `paperclip-${event.eventId}`;

async function post(ctx: PluginContext, matrix: Matrix, event: PluginEvent, projectId: string | null, message: Notice) {
  const room = await roomFor(ctx, matrix, event.companyId, projectId);
  if (room) await sendNotice(ctx, matrix, room, transactionId(event), message);
}

// Posts in the issue's thread. The first message about an issue starts its thread, in the room the
// issue's project uses at that time; the thread stays in that room.
async function postAboutIssue(ctx: PluginContext, matrix: Matrix, event: PluginEvent, issue: { id: string; projectId: string | null }, message: Notice) {
  const thread = await issueThread(ctx, issue.id);
  if (thread) {
    await sendNotice(ctx, matrix, thread.roomId, transactionId(event), message, thread.eventId);
    return;
  }
  const room = await roomFor(ctx, matrix, event.companyId, issue.projectId);
  if (!room) return;
  const root = await sendNotice(ctx, matrix, room, transactionId(event), message);
  await rememberIssueThread(ctx, event.companyId, issue.id, root);
}

async function issueCreated(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const issue = event.entityId ? await ctx.issues.get(event.entityId, event.companyId) : null;
  if (!issue) return;
  const agent = await agentName(ctx, issue.assigneeAgentId, event.companyId);
  const summary = `New issue: ${issueLabel(issue)}${agent ? `, assigned to ${agent}` : ""}`;
  const link = await pageUrl(ctx, matrix, event.companyId, `issues/${issue.identifier ?? issue.id}`);
  await postAboutIssue(ctx, matrix, event, issue, notice(summary, link));
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
  await postAboutIssue(ctx, matrix, event, issue, notice(`Done: ${issueLabel(issue)}`, link));
}

async function approvalCreated(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const approval = event.entityId ? await ctx.approvals.get(event.entityId, event.companyId) : null;
  if (!approval) return;
  const requester = await agentName(ctx, approval.requestedByAgentId, event.companyId);
  // Approval types are snake_case keys such as hire_agent.
  const summary = `Approval needed: ${approval.type.replaceAll("_", " ")}${requester ? `, requested by ${requester}` : ""}`;
  const link = await pageUrl(ctx, matrix, event.companyId, `approvals/${approval.id}`);
  await post(ctx, matrix, event, null, notice(summary, link));
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
  if (issue) await postAboutIssue(ctx, matrix, event, issue, notice(summary, link));
  else await post(ctx, matrix, event, null, notice(summary, link));
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
  "agent.run.failed": runFailed,
  "budget.incident.opened": budgetIncident,
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
