import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { linkedMatrixUser, linkedUser } from "./links.js";
import { editNotice, errorMessage, sendNotice, sendReaction, type Matrix, type SentEvent } from "./matrix.js";
import { agentName, escapeHtml, issueThread, notice, pageUrl, postAboutIssue, transactionId, type Notice } from "./messages.js";
import type { RoomEvent } from "./threads.js";

// Approvals, and agents' questions and confirmation requests (Paperclip's "interactions"). A linked
// person approves or rejects by reacting to the bot's message with a tick or a cross; Paperclip
// checks they could have decided it in its web page. Questions are answered by replying in the
// issue's thread, which becomes a comment: Paperclip does not let plugins submit answers.

const APPROVE = "✅";
const REJECT = "❌";

// The detail an agent attaches to a confirmation can be long; the rest is in Paperclip.
const MAX_DETAILS_LENGTH = 2000;

const APPROVAL_OUTCOMES: Partial<Record<string, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  revision_requested: "Revision requested",
};

const INTERACTION_OUTCOMES: Partial<Record<string, string>> = {
  accepted: "Accepted",
  rejected: "Rejected",
  answered: "Answered",
  cancelled: "Cancelled",
  expired: "Closed",
  failed: "Failed",
};

// The SDK's entry point does not export these types, so they are taken from the calls that return them.
type Approval = NonNullable<Awaited<ReturnType<PluginContext["approvals"]["get"]>>>;
type IssueThreadInteraction = Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>[number];

// What a reaction to one of the bot's messages decides.
type ReactionTarget = { approvalId: string } | { issueId: string; interactionId: string };
// An interaction's message, and the status it shows, so it is edited once when that changes.
type InteractionMessage = SentEvent & { status: string };

const reactionTargetKey = (companyId: string, eventId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "reaction-targets", stateKey: eventId }) as const;
const approvalMessageKey = (companyId: string, approvalId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "approval-messages", stateKey: approvalId }) as const;
const interactionMessageKey = (issueId: string, interactionId: string) =>
  ({ scopeKind: "issue", scopeId: issueId, namespace: "interaction-messages", stateKey: interactionId }) as const;

// Paperclip gives plugins no names for people, so a person is shown by their linked Matrix account.
// Returns "" when no person is known.
async function byWhom(ctx: PluginContext, companyId: string, userId: string | null | undefined): Promise<string> {
  if (!userId) return "";
  const matrixUserId = await linkedMatrixUser(ctx, companyId, userId);
  return matrixUserId ? ` by ${matrixUserId}` : " in Paperclip";
}

function multiLineNotice(lines: string[], link: string | null): Notice {
  const text = lines.join("\n");
  return {
    text: link ? `${text}\n${link}` : text,
    html: `${escapeHtml(text).replaceAll("\n", "<br>")}${link ? `<br><a href="${escapeHtml(link)}">Open in Paperclip</a>` : ""}`,
  };
}

// The bot adds both reactions itself, so people only have to click one.
async function offerReactions(ctx: PluginContext, matrix: Matrix, companyId: string, message: SentEvent, target: ReactionTarget) {
  await ctx.state.set(reactionTargetKey(companyId, message.eventId), target);
  await sendReaction(ctx, matrix, message.roomId, message.eventId, APPROVE);
  await sendReaction(ctx, matrix, message.roomId, message.eventId, REJECT);
}

async function approvalSummary(ctx: PluginContext, approval: Approval, companyId: string): Promise<string> {
  const requester = await agentName(ctx, approval.requestedByAgentId, companyId);
  // Approval types are snake_case keys such as hire_agent.
  return `${approval.type.replaceAll("_", " ")}${requester ? `, requested by ${requester}` : ""}`;
}

// Approvals have no project, so they go to the default room.
export async function approvalCreated(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  const approval = event.entityId ? await ctx.approvals.get(event.entityId, event.companyId) : null;
  if (!approval || !matrix.defaultRoom) return;
  const summary = `Approval needed: ${await approvalSummary(ctx, approval, event.companyId)}. React ${APPROVE} to approve or ${REJECT} to reject.`;
  const link = await pageUrl(ctx, matrix, event.companyId, `approvals/${approval.id}`);
  const sent = await sendNotice(ctx, matrix, matrix.defaultRoom, transactionId(event), notice(summary, link));
  await ctx.state.set(approvalMessageKey(event.companyId, approval.id), sent);
  await offerReactions(ctx, matrix, event.companyId, sent, { approvalId: approval.id });
}

// Shows the decision on the approval's message, whether it was made in Matrix or in Paperclip.
export async function approvalDecided(ctx: PluginContext, matrix: Matrix, event: PluginEvent) {
  if (!event.entityId) return;
  const message = (await ctx.state.get(approvalMessageKey(event.companyId, event.entityId))) as SentEvent | null;
  const approval = message ? await ctx.approvals.get(event.entityId, event.companyId) : null;
  const outcome = approval ? APPROVAL_OUTCOMES[approval.status] : undefined;
  if (!message || !approval || !outcome) return;

  const decider = await byWhom(ctx, event.companyId, approval.decidedByUserId);
  const summary = `${outcome}${decider}: ${await approvalSummary(ctx, approval, event.companyId)}`;
  const link = await pageUrl(ctx, matrix, event.companyId, `approvals/${approval.id}`);
  await editNotice(ctx, matrix, message, transactionId(event), notice(summary, link));
}

function interactionTitle(interaction: IssueThreadInteraction): string {
  switch (interaction.kind) {
    case "request_confirmation":
    case "request_checkbox_confirmation":
    case "request_item_verdicts":
      return interaction.payload.prompt;
    case "ask_user_questions":
      return interaction.payload.title ?? interaction.title ?? interaction.payload.questions[0]?.prompt ?? "A question";
    default:
      return interaction.title ?? interaction.summary ?? "A request";
  }
}

// What a pending interaction asks, and how to answer it from Matrix.
function pendingLines(interaction: IssueThreadInteraction, agent: string): string[] {
  switch (interaction.kind) {
    case "request_confirmation": {
      const details = interaction.payload.detailsMarkdown;
      const cut = details && details.length > MAX_DETAILS_LENGTH ? `${details.slice(0, MAX_DETAILS_LENGTH)}…` : details;
      return [`${agent} asks you to confirm: ${interaction.payload.prompt}`, ...(cut ? ["", cut] : []), "", `React ${APPROVE} to accept or ${REJECT} to reject.`];
    }
    case "ask_user_questions": {
      const { payload } = interaction;
      const lines = [`${agent} has ${payload.questions.length === 1 ? "a question" : "questions"}${payload.title ? `: ${payload.title}` : ""}`];
      for (const question of payload.questions) {
        lines.push("", question.prompt);
        if (question.helpText) lines.push(question.helpText);
        // Options people type themselves are answered by the reply anyway.
        const choices = question.options.filter((option) => !option.freeText);
        choices.forEach((option, index) => lines.push(`${index + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`));
      }
      return [...lines, "", "Reply in this thread to answer."];
    }
    default:
      return [`${agent} needs your input: ${interactionTitle(interaction)}`, "Answer in Paperclip."];
  }
}

// Posts the issue's pending interactions in its thread, and edits the messages of those that have
// since been answered. Interactions resolved before the plugin saw them are not posted.
export async function updateInteractionMessages(ctx: PluginContext, matrix: Matrix, companyId: string, issueId: string) {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return;
  for (const interaction of await ctx.issues.listInteractions(issueId, companyId)) {
    const key = interactionMessageKey(issueId, interaction.id);
    const message = (await ctx.state.get(key)) as InteractionMessage | null;
    if (message?.status === interaction.status || (!message && interaction.status !== "pending")) continue;

    const agent = (await agentName(ctx, interaction.createdByAgentId, companyId)) ?? "An agent";
    const link = await pageUrl(ctx, matrix, companyId, `issues/${issue.identifier ?? issue.id}`);
    if (!message) {
      const sent = await postAboutIssue(ctx, matrix, companyId, issue, `interaction-${interaction.id}`, multiLineNotice(pendingLines(interaction, agent), link));
      if (!sent) return;
      await ctx.state.set(key, { ...sent, status: interaction.status } satisfies InteractionMessage);
      if (interaction.kind === "request_confirmation") await offerReactions(ctx, matrix, companyId, sent, { issueId, interactionId: interaction.id });
    } else {
      const outcome = INTERACTION_OUTCOMES[interaction.status] ?? interaction.status;
      const resolver = await byWhom(ctx, companyId, interaction.resolvedByUserId);
      const lines = [`${agent} asked: ${interactionTitle(interaction)}`, `${outcome}${resolver}.`];
      await editNotice(ctx, matrix, message, `interaction-${interaction.id}-${interaction.status}`, multiLineNotice(lines, link));
      await ctx.state.set(key, { ...message, status: interaction.status } satisfies InteractionMessage);
    }
  }
}

async function decide(ctx: PluginContext, matrix: Matrix, companyId: string, target: ReactionTarget, approve: boolean, actorUserId: string) {
  if ("approvalId" in target) {
    // Paperclip then sends approval.decided, which edits the message.
    await ctx.approvals.decide(target.approvalId, { action: approve ? "approve" : "reject", actorUserId }, companyId);
    return;
  }
  await ctx.issues.respondInteraction(target.issueId, target.interactionId, { action: approve ? "accept" : "reject", actorUserId }, companyId);
  await updateInteractionMessages(ctx, matrix, companyId, target.issueId);
}

// Handles a reaction someone added in a room the bot is in. Only a tick or a cross from a linked
// person, on one of the bot's approval or confirmation messages, decides anything.
export async function handleReaction(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string, event: RoomEvent) {
  const relation = event.content["m.relates_to"];
  if (relation?.rel_type !== "m.annotation" || !relation.event_id) return;
  if (relation.key !== APPROVE && relation.key !== REJECT) return;
  const target = (await ctx.state.get(reactionTargetKey(companyId, relation.event_id))) as ReactionTarget | null;
  if (!target) return;
  const userId = await linkedUser(ctx, companyId, event.sender);
  if (!userId) return;

  const approve = relation.key === APPROVE;
  try {
    await decide(ctx, matrix, companyId, target, approve, userId);
  } catch (error) {
    // Paperclip refuses people who could not decide this in its web page, such as viewers. Saying why
    // in the room is the only way the person learns their reaction did nothing.
    const verb = !approve ? "reject" : "approvalId" in target ? "approve" : "accept";
    const thread = "issueId" in target ? await issueThread(ctx, target.issueId) : null;
    const reason = notice(`${event.sender} could not ${verb}: ${errorMessage(error)}`, null);
    await sendNotice(ctx, matrix, roomId, `refused-${event.event_id}`, reason, thread?.eventId);
  }
}
