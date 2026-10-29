import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { linkedUser } from "./links.js";
import { sendNotice, type Matrix } from "./matrix.js";
import { issueLabel, multiLineNotice, notice, pageUrl, type Notice } from "./messages.js";
import { projectOfRoom } from "./project-rooms.js";
import type { RoomEvent } from "./threads.js";

// Commands a linked person can send in any room the bot is in. Only linked people get answers,
// because the answers show the company's work.

export const COMMAND = /^!clip(?:\s+(.*))?$/;

// Work not yet finished, in the order it is listed. Backlog issues are not being worked on.
const OPEN_STATUSES = ["in_progress", "in_review", "blocked", "todo"] satisfies Issue["status"][];
const STATUS_NAMES: Record<(typeof OPEN_STATUSES)[number], string> = {
  in_progress: "in progress",
  in_review: "in review",
  blocked: "blocked",
  todo: "to do",
};

// About a screenful; the rest are in Paperclip.
const MAX_ISSUES = 20;

const HELP = [
  "!clip status: how much work is open, which agents are working, and approvals waiting",
  "!clip issues: open issues; in a project's room, only that project's",
];

async function openIssues(ctx: PluginContext, companyId: string, projectId?: string): Promise<Issue[]> {
  const lists = await Promise.all(OPEN_STATUSES.map((status) => ctx.issues.list({ companyId, projectId, status })));
  return lists.flat();
}

async function status(ctx: PluginContext, matrix: Matrix, companyId: string): Promise<Notice> {
  const issues = await openIssues(ctx, companyId);
  const agents = await ctx.agents.list({ companyId });
  const approvals = await ctx.approvals.list({ companyId, status: "pending" });

  const counts = OPEN_STATUSES.map((status) => `${issues.filter((issue) => issue.status === status).length} ${STATUS_NAMES[status]}`);
  const working = agents.filter((agent) => agent.status === "running").map((agent) => agent.name);
  const paused = agents.filter((agent) => agent.status === "paused").map((agent) => agent.name);
  const lines = [
    `Open issues: ${counts.join(", ")}`,
    working.length > 0 ? `Working now: ${working.join(", ")}` : "No agent is working now.",
    ...(paused.length > 0 ? [`Paused: ${paused.join(", ")}`] : []),
    `Approvals waiting: ${approvals.length}`,
  ];
  return multiLineNotice(lines, await pageUrl(ctx, matrix, companyId, "dashboard"));
}

async function issueList(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string): Promise<Notice> {
  const project = await projectOfRoom(ctx, companyId, roomId);
  const where = project ? ` in ${project.name}` : "";
  const issues = await openIssues(ctx, companyId, project?.id);
  if (issues.length === 0) return notice(`No open issues${where}.`, null);

  const agentNames = new Map((await ctx.agents.list({ companyId })).map((agent) => [agent.id, agent.name]));
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const agent = issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) : undefined;
    return `${issueLabel(issue)}: ${STATUS_NAMES[issue.status as keyof typeof STATUS_NAMES]}${agent ? `, ${agent}` : ""}`;
  });
  if (issues.length > MAX_ISSUES) lines.push(`…and ${issues.length - MAX_ISSUES} more.`);
  return multiLineNotice([`Open issues${where}:`, ...lines], await pageUrl(ctx, matrix, companyId, "issues"));
}

// Answers a command in the room it was sent in. Anything after !clip that is not a command gets the list of commands.
export async function handleCommand(ctx: PluginContext, matrix: Matrix, companyId: string, roomId: string, event: RoomEvent, command: string) {
  if (!(await linkedUser(ctx, companyId, event.sender))) return;
  let answer: Notice;
  if (command === "status") answer = await status(ctx, matrix, companyId);
  else if (command === "issues") answer = await issueList(ctx, matrix, companyId, roomId);
  else answer = multiLineNotice(HELP, null);
  await sendNotice(ctx, matrix, roomId, `command-${event.event_id}`, answer);
}
