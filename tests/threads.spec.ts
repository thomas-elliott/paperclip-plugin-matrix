import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Company, Issue, IssueComment, Project } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { BOT_NAME, BOT_USER, FakeHomeserver, HOMESERVER } from "./fake-homeserver.js";

const COMPANY = "co-1";
const ROOM = "!general";
const ALICE = "@alice:example.com";
const MALLORY = "@mallory:example.com";

const WEBSITE_ROOM = "!website";

const config = {
  homeserverUrl: HOMESERVER,
  accessToken: "token-ref",
  defaultRoom: ROOM,
  defaultAgent: "builder",
};

type Member = NonNullable<Parameters<TestHarness["seed"]>[0]["accessMembers"]>[number];
const member = (userId: string) =>
  ({ id: `member-${userId}`, companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" }) as Member;

const issue = {
  id: "issue-1",
  companyId: COMPANY,
  projectId: null,
  identifier: "ACME-7",
  title: "Fix the login page",
  status: "todo",
  assigneeAgentId: null,
} as Issue;

const issueEvent = { companyId: COMPANY, entityType: "issue", entityId: "issue-1" };

// Starts the plugin as Paperclip does after the settings are saved, and waits for its sync loop's first sync.
async function setUp(settings: Record<string, unknown> = config, beforeStart?: (harness: TestHarness) => void) {
  const homeserver = new FakeHomeserver().install();
  const harness = createTestHarness({ manifest, config: settings });
  harness.seed({
    companies: [{ id: COMPANY, name: "Acme", issuePrefix: "ACME" } as Company],
    issues: [issue],
    agents: [
      { id: "agent-1", companyId: COMPANY, name: "Builder", urlKey: "builder", status: "idle" } as Agent,
      { id: "agent-2", companyId: COMPANY, name: "Designer", urlKey: "designer", status: "idle" } as Agent,
      { id: "agent-3", companyId: COMPANY, name: "Reviewer", urlKey: "reviewer", status: "idle" } as Agent,
    ],
    projects: [{ id: "project-1", companyId: COMPANY, name: "Website", leadAgentId: "agent-2" } as Project],
    accessMembers: [member("user-alice")],
  });
  await plugin.definition.setup(harness.ctx);
  await harness.performAction(
    "setProjectRoom",
    { projectId: "project-1", roomId: WEBSITE_ROOM },
    { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } },
  );
  beforeStart?.(harness);
  await plugin.definition.onConfigChanged?.(settings, { companyId: COMPANY });
  await homeserver.read();
  return { harness, homeserver };
}

let nextEvent = 0;
function message(sender: string, body: string, threadRoot?: string) {
  nextEvent += 1;
  return {
    type: "m.room.message",
    sender,
    event_id: `$incoming-${nextEvent}`,
    content: { msgtype: "m.text", body, ...(threadRoot ? { "m.relates_to": { rel_type: "m.thread", event_id: threadRoot } } : {}) },
  };
}

// An edit, as Element sends it: a new message whose text is starred and which replaces the original.
function edit(original: { sender: string; event_id: string }, body: string) {
  const event = message(original.sender, `* ${body}`);
  return { ...event, content: { ...event.content, "m.new_content": { msgtype: "m.text", body }, "m.relates_to": { rel_type: "m.replace", event_id: original.event_id } } };
}

// A message that mentions the bot, as Element sends it: the display name starts the text.
function mention(sender: string, body: string) {
  const event = message(sender, `${BOT_NAME}: ${body}`);
  return { ...event, content: { ...event.content, "m.mentions": { user_ids: [BOT_USER] } } };
}

// Issues the plugin created from Matrix messages; the seeded issue is not one.
async function requestedIssues(harness: TestHarness) {
  return (await harness.ctx.issues.list({ companyId: COMPANY })).filter((candidate) => candidate.id !== "issue-1");
}

// Alice links her Matrix account as Paperclip user user-alice, the way the dashboard widget does.
async function linkAlice(harness: TestHarness, homeserver: FakeHomeserver) {
  const { code } = await harness.performAction<{ code: string }>(
    "startLink",
    { matrixUserId: ALICE },
    { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } },
  );
  homeserver.deliver(ROOM, message(ALICE, `!link ${code}`));
  await homeserver.read();
}

function linkStatus(harness: TestHarness, userId = "user-alice") {
  return harness.performAction<{ matrixUserId: string | null }>("linkStatus", {}, { companyId: COMPANY, actor: { type: "user", userId, companyId: COMPANY } });
}

async function createIssueThread(harness: TestHarness, homeserver: FakeHomeserver) {
  await harness.emit("issue.created", {}, issueEvent);
  return homeserver.messageEventsIn(ROOM)[0].eventId;
}

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("issue threads", () => {
  it("posts later news about an issue in the thread its first message started", async () => {
    const { harness, homeserver } = await setUp();
    const root = await createIssueThread(harness, homeserver);

    await harness.emit("issue.updated", { status: "done", _previous: { status: "in_review" } }, issueEvent);
    await harness.emit("agent.run.failed", { runId: "run-1", agentId: "agent-1", issueId: "issue-1", error: "boom" }, { companyId: COMPANY, entityType: "heartbeat_run", entityId: "run-1" });

    const [, done, failed] = homeserver.messagesIn(ROOM);
    expect(done["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: root });
    expect(failed["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: root });
  });

  it("starts a thread from the first message about an issue it has not posted before", async () => {
    const { harness, homeserver } = await setUp();

    await harness.emit("issue.updated", { status: "done", _previous: { status: "in_review" } }, issueEvent);
    await harness.emit("agent.run.failed", { runId: "run-1", agentId: "agent-1", issueId: "issue-1", error: "boom" }, { companyId: COMPANY, entityType: "heartbeat_run", entityId: "run-1" });

    const [done, failed] = homeserver.messageEventsIn(ROOM);
    expect(done.content["m.relates_to"]).toBeUndefined();
    expect(failed.content["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: done.eventId });
  });

  it("starts one thread when two messages about a new issue are posted at once", async () => {
    const { harness, homeserver } = await setUp();

    await Promise.all([
      harness.emit("issue.created", {}, issueEvent),
      harness.emit("agent.run.failed", { runId: "run-1", agentId: "agent-1", issueId: "issue-1", error: "boom" }, { companyId: COMPANY, entityType: "heartbeat_run", entityId: "run-1" }),
    ]);

    const [first, second] = homeserver.messageEventsIn(ROOM);
    expect(second.content["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: first.eventId });
  });

  it("retries a message the homeserver refused as over its rate limit", async () => {
    const { harness, homeserver } = await setUp();
    homeserver.rateLimitSends = 1;

    await harness.emit("issue.created", {}, issueEvent);

    expect(homeserver.messagesIn(ROOM)).toHaveLength(1);
  });
});

describe("replies", () => {
  it("copies a linked user's reply in an issue thread to the issue as their comment", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);
    const reply = message(ALICE, "The login page also breaks on Safari", root);

    homeserver.deliver(ROOM, reply);
    await homeserver.read();

    const comments = await harness.ctx.issues.listComments("issue-1", COMPANY);
    expect(comments).toEqual([expect.objectContaining({ body: "The login page also breaks on Safari", authorUserId: "user-alice" })]);
    // The bot reacts so people in the room can see the reply reached Paperclip.
    expect(homeserver.reactions()).toContainEqual(expect.objectContaining({ rel_type: "m.annotation", event_id: reply.event_id }));
  });

  it("copies a reply once when it reads it twice", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);
    const reply = message(ALICE, "The login page also breaks on Safari", root);

    homeserver.deliver(ROOM, reply);
    homeserver.deliver(ROOM, reply);
    await homeserver.read();

    expect(await harness.ctx.issues.listComments("issue-1", COMPANY)).toHaveLength(1);
  });

  it("does not copy an edit to a reply as another comment", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);
    const reply = message(ALICE, "The login page also breaks on Safar", root);

    homeserver.deliver(ROOM, reply);
    homeserver.deliver(ROOM, edit(reply, "The login page also breaks on Safari"));
    await homeserver.read();

    expect(await harness.ctx.issues.listComments("issue-1", COMPANY)).toHaveLength(1);
    expect(await requestedIssues(harness)).toHaveLength(0);
  });

  it("ignores replies from Matrix users who have not linked an account", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);

    homeserver.deliver(ROOM, message(MALLORY, "Not from a linked user", root));
    await homeserver.read();

    expect(await harness.ctx.issues.listComments("issue-1", COMPANY)).toHaveLength(0);
  });

  it("ignores messages outside issue threads and the bot's own messages", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);

    homeserver.deliver(ROOM, message(ALICE, "Not in a thread"));
    homeserver.deliver(ROOM, message(ALICE, "In some other thread", "$not-an-issue"));
    homeserver.deliver(ROOM, message(BOT_USER, "The bot's own message", root));
    await homeserver.read();

    expect(await harness.ctx.issues.listComments("issue-1", COMPANY)).toHaveLength(0);
  });
});

describe("linking accounts", () => {
  it("does not link when someone else sends the code", async () => {
    const { harness, homeserver } = await setUp();
    const { code } = await harness.performAction<{ code: string }>(
      "startLink",
      { matrixUserId: ALICE },
      { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } },
    );

    homeserver.deliver(ROOM, message(MALLORY, `!link ${code}`));
    await homeserver.read();

    expect(await linkStatus(harness)).toMatchObject({ matrixUserId: null });
  });

  it("does not link with an expired code", async () => {
    const { harness, homeserver } = await setUp();
    const { code } = await harness.performAction<{ code: string }>(
      "startLink",
      { matrixUserId: ALICE },
      { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } },
    );
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60 * 1000 });

    homeserver.deliver(ROOM, message(ALICE, `!link ${code}`));
    await homeserver.read();

    expect(await linkStatus(harness)).toMatchObject({ matrixUserId: null });
  });

  it("only lets a signed-in Paperclip user start linking", async () => {
    const { harness } = await setUp();

    await expect(
      harness.performAction("startLink", { matrixUserId: ALICE }, { companyId: COMPANY, actor: { type: "agent", agentId: "agent-1", companyId: COMPANY } }),
    ).rejects.toThrow();
  });

  it("unlinks, after which replies are no longer copied", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);

    await harness.performAction("unlink", {}, { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } });
    homeserver.deliver(ROOM, message(ALICE, "After unlinking", root));
    await homeserver.read();

    expect(await linkStatus(harness)).toMatchObject({ matrixUserId: null });
    expect(await harness.ctx.issues.listComments("issue-1", COMPANY)).toHaveLength(0);
  });
});

describe("agent comments", () => {
  // Paperclip's comment event carries only the first 120 characters, so the plugin reads the comment.
  const longBody = `I found the cause.\n\n${"The session cookie expires too early. ".repeat(6)}`;
  const comment = (fields: Partial<IssueComment>) =>
    ({ id: "comment-1", companyId: COMPANY, issueId: "issue-1", body: longBody, authorAgentId: "agent-1", authorUserId: null, ...fields }) as IssueComment;
  const commentEvent = (actorType: "agent" | "user" | "plugin") => ({ ...issueEvent, actorType, actorId: "someone" });

  it("posts an agent's comment in full in the issue's thread", async () => {
    const { harness, homeserver } = await setUp();
    const root = await createIssueThread(harness, homeserver);
    harness.seed({ issueComments: [comment({})] });

    await harness.emit("issue.comment.created", { commentId: "comment-1", bodySnippet: longBody.slice(0, 120) }, commentEvent("agent"));

    const [, posted] = homeserver.messagesIn(ROOM);
    expect(posted["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: root });
    expect(posted.body).toContain("Builder");
    expect(posted.body).toContain(longBody);
  });

  it("does not post comments by people or by plugins, so replies copied from Matrix are not echoed", async () => {
    const { harness, homeserver } = await setUp();
    await createIssueThread(harness, homeserver);
    harness.seed({ issueComments: [comment({ authorAgentId: null, authorUserId: "user-alice" })] });

    await harness.emit("issue.comment.created", { commentId: "comment-1" }, commentEvent("plugin"));
    await harness.emit("issue.comment.created", { commentId: "comment-1" }, commentEvent("user"));

    expect(homeserver.messagesIn(ROOM)).toHaveLength(1);
  });

  it("renders the agent's Markdown, showing any HTML in it as text", async () => {
    const { harness, homeserver } = await setUp();
    await createIssueThread(harness, homeserver);
    harness.seed({ issueComments: [comment({ body: "**Fixed.** See `login.ts`.\n\n<img src=x>" })] });

    await harness.emit("issue.comment.created", { commentId: "comment-1" }, commentEvent("agent"));

    const [, posted] = homeserver.messagesIn(ROOM);
    expect(posted.formatted_body).toContain("<strong>Fixed.</strong>");
    expect(posted.formatted_body).toContain("<code>login.ts</code>");
    expect(posted.formatted_body).toContain("&lt;img src=x&gt;");
  });

  it("does not start a thread for an agent's comment", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issueComments: [comment({})] });

    await harness.emit("issue.comment.created", { commentId: "comment-1" }, commentEvent("agent"));

    expect(homeserver.sent).toHaveLength(0);
  });
});

describe("starting work", () => {
  it("turns a linked person's mention into an issue for the default agent, with their message as the thread's root", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const request = mention(ALICE, "Fix the signup form\nIt rejects addresses with a plus sign.");

    homeserver.deliver(ROOM, request);
    await homeserver.read();

    const [created] = await requestedIssues(harness);
    expect(created).toMatchObject({
      title: "Fix the signup form",
      description: "Fix the signup form\nIt rejects addresses with a plus sign.",
      status: "todo",
      assigneeAgentId: "agent-1",
      projectId: null,
    });
    expect(homeserver.reactions()).toContainEqual(expect.objectContaining({ event_id: request.event_id }));
    const [confirmation] = homeserver.messagesIn(ROOM);
    expect(confirmation["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: request.event_id });
    expect(confirmation.body).toContain("assigned to Builder");

    // Replies in the thread carry the conversation on.
    homeserver.deliver(ROOM, message(ALICE, "Also on the mobile site", request.event_id));
    await homeserver.read();
    expect(await harness.ctx.issues.listComments(created.id, COMPANY)).toEqual([expect.objectContaining({ body: "Also on the mobile site" })]);
  });

  it("does not post the usual new-issue message for an issue asked for from Matrix", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    homeserver.deliver(ROOM, mention(ALICE, "Fix the signup form"));
    await homeserver.read();
    const [created] = await requestedIssues(harness);

    await harness.emit("issue.created", {}, { companyId: COMPANY, entityType: "issue", entityId: created.id });

    expect(homeserver.messagesIn(ROOM)).toHaveLength(1);
  });

  it("gives work asked for in a project's room to the project's lead agent", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);

    homeserver.deliver(WEBSITE_ROOM, mention(ALICE, "Make the header smaller"));
    await homeserver.read();

    expect(await requestedIssues(harness)).toEqual([expect.objectContaining({ projectId: "project-1", assigneeAgentId: "agent-2" })]);
  });

  it("gives the work to an agent the message mentions as @url-key, but not to a Matrix user of the same name", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);

    homeserver.deliver(WEBSITE_ROOM, mention(ALICE, "@designer:example.com thinks @reviewer should check the header"));
    await homeserver.read();

    expect(await requestedIssues(harness)).toEqual([expect.objectContaining({ assigneeAgentId: "agent-3" })]);
  });

  it("gives the work to the default agent when the project's lead agent has been terminated", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ agents: [{ id: "agent-2", companyId: COMPANY, name: "Designer", urlKey: "designer", status: "terminated" } as Agent] });
    await linkAlice(harness, homeserver);

    homeserver.deliver(WEBSITE_ROOM, mention(ALICE, "Make the header smaller"));
    await homeserver.read();

    expect(await requestedIssues(harness)).toEqual([expect.objectContaining({ assigneeAgentId: "agent-1" })]);
  });

  it("does not give work to an agent waiting for approval, which Paperclip would refuse", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ agents: [{ id: "agent-1", companyId: COMPANY, name: "Builder", urlKey: "builder", status: "pending_approval" } as Agent] });
    await linkAlice(harness, homeserver);

    homeserver.deliver(ROOM, mention(ALICE, "Fix the signup form"));
    await homeserver.read();

    expect(await requestedIssues(harness)).toHaveLength(0);
    expect(homeserver.messagesIn(ROOM)[0].body).toContain("No agent");
  });

  it("says so in the thread when Paperclip will not create the issue", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    vi.spyOn(harness.ctx.issues, "create").mockRejectedValueOnce(new Error("Cannot assign work to agents with an invalid org chain"));
    const request = mention(ALICE, "Fix the signup form");

    homeserver.deliver(ROOM, request);
    await homeserver.read();

    const [reason] = homeserver.messagesIn(ROOM);
    expect(reason.body).toContain("invalid org chain");
    expect(reason["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: request.event_id });
  });

  it("explains, and creates nothing, when no agent can be chosen", async () => {
    const { harness, homeserver } = await setUp({ ...config, defaultAgent: undefined });
    await linkAlice(harness, homeserver);
    const request = mention(ALICE, "Fix the signup form");

    homeserver.deliver(ROOM, request);
    await homeserver.read();

    expect(await requestedIssues(harness)).toHaveLength(0);
    const [reason] = homeserver.messagesIn(ROOM);
    expect(reason.body).toContain("No agent");
    expect(reason["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: request.event_id });
  });

  it("ignores mentions from unlinked people, replies to the bot, and messages that do not mention it", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    // Clients list the author of the message replied to as mentioned.
    const thanks = mention(ALICE, "Thanks");
    const reply = { ...thanks, content: { ...thanks.content, "m.relates_to": { "m.in_reply_to": { event_id: "$a-bot-notice" } } } };

    homeserver.deliver(ROOM, mention(MALLORY, "Delete everything"));
    homeserver.deliver(ROOM, reply);
    homeserver.deliver(ROOM, message(ALICE, "Just chatting"));
    await homeserver.read();

    expect(await requestedIssues(harness)).toHaveLength(0);
  });

  it("creates one issue when it reads the same message twice", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const request = mention(ALICE, "Fix the signup form");

    homeserver.deliver(ROOM, request);
    homeserver.deliver(ROOM, request);
    await homeserver.read();

    expect(await requestedIssues(harness)).toHaveLength(1);
  });
});

describe("direct messages", () => {
  it("joins a linked person's direct message room, where every message asks for work", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);

    homeserver.invite("!alice-dm", ALICE, true);
    await homeserver.read();
    homeserver.deliver("!alice-dm", message(ALICE, "Fix the signup form"));
    await homeserver.read();

    expect(homeserver.joined).toContain("!alice-dm");
    expect(await requestedIssues(harness)).toEqual([expect.objectContaining({ title: "Fix the signup form", assigneeAgentId: "agent-1" })]);
  });

  it("does not treat an edit to a request as another request", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    homeserver.invite("!alice-dm", ALICE, true);
    await homeserver.read();
    const request = message(ALICE, "Fix the sigup form");

    homeserver.deliver("!alice-dm", request);
    homeserver.deliver("!alice-dm", edit(request, "Fix the signup form"));
    await homeserver.read();

    expect(await requestedIssues(harness)).toHaveLength(1);
  });

  it("ignores invites from people who have not linked an account", async () => {
    const { homeserver } = await setUp();

    homeserver.invite("!mallory-dm", MALLORY, true);
    await homeserver.read();

    expect(homeserver.joined).not.toContain("!mallory-dm");
  });

  it("joins a linked person's group room without treating every message there as a request", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);

    homeserver.invite("!team", ALICE, false);
    await homeserver.read();
    homeserver.deliver("!team", message(ALICE, "Morning all"));
    await homeserver.read();

    expect(homeserver.joined).toContain("!team");
    expect(await requestedIssues(harness)).toHaveLength(0);
  });
});

describe("commands", () => {
  const otherIssue = { ...issue, id: "issue-2", identifier: "ACME-8", title: "Redesign the header", projectId: "project-1", status: "in_progress", assigneeAgentId: "agent-2" } as Issue;

  it("answers !clip status with open work, working agents and waiting approvals", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue, otherIssue], agents: [{ id: "agent-2", companyId: COMPANY, name: "Designer", urlKey: "designer", status: "running" } as Agent] });
    await linkAlice(harness, homeserver);

    homeserver.deliver(ROOM, message(ALICE, "!clip status"));
    await homeserver.read();

    const [answer] = homeserver.messagesIn(ROOM);
    expect(answer.body).toContain("Open issues: 1 in progress, 0 in review, 0 blocked, 1 to do");
    expect(answer.body).toContain("Working now: Designer");
    expect(answer.body).toContain("Approvals waiting: 0");
  });

  it("lists open issues, only the project's in a project's room", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue, otherIssue] });
    await linkAlice(harness, homeserver);

    homeserver.deliver(ROOM, message(ALICE, "!clip issues"));
    homeserver.deliver(WEBSITE_ROOM, message(ALICE, "!clip issues"));
    await homeserver.read();

    const [everywhere] = homeserver.messagesIn(ROOM);
    expect(everywhere.body).toContain("ACME-7 Fix the login page: to do");
    expect(everywhere.body).toContain("ACME-8 Redesign the header: in progress, Designer");
    const [website] = homeserver.messagesIn(WEBSITE_ROOM);
    expect(website.body).toContain("Open issues in Website:");
    expect(website.body).toContain("ACME-8");
    expect(website.body).not.toContain("ACME-7");
  });

  it("lists the commands for anything else after !clip", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);

    homeserver.deliver(ROOM, message(ALICE, "!clip"));
    await homeserver.read();

    expect(homeserver.messagesIn(ROOM)[0].body).toContain("!clip issues");
  });

  it("does not answer people who have not linked an account", async () => {
    const { homeserver } = await setUp();

    homeserver.deliver(ROOM, message(MALLORY, "!clip issues"));
    await homeserver.read();

    expect(homeserver.messagesIn(ROOM)).toHaveLength(0);
  });
});

describe("reading rooms", () => {
  it("handles a batch once when the settings are saved while the plugin is part-way through it", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    const root = await createIssueThread(harness, homeserver);
    const createComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    // The first comment is written by the loop the save replaces, after the new loop has had time
    // to read the same batch if it does not wait for this one.
    let replacedLoopDone: Promise<unknown> | null = null;
    vi.spyOn(harness.ctx.issues, "createComment").mockImplementation(async (...args) => {
      if (replacedLoopDone) return createComment(...args);
      replacedLoopDone = (async () => {
        await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return createComment(...args);
      })();
      return replacedLoopDone as ReturnType<typeof createComment>;
    });

    homeserver.deliver(ROOM, message(ALICE, "The login page also breaks on Safari", root));
    await vi.waitFor(() => expect(replacedLoopDone).not.toBeNull());
    await replacedLoopDone;
    await homeserver.read();

    expect(await harness.ctx.issues.listComments("issue-1", COMPANY)).toHaveLength(1);
  });

  it("starts from now rather than an old position when the bot's account changes", async () => {
    const { homeserver } = await setUp();
    homeserver.userId = "@other-bot:example.com";
    homeserver.syncedFrom = [];

    await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });

    // A first sync asks from no position.
    await vi.waitFor(() => expect(homeserver.syncedFrom).toContain(null));
  });

  it("still reads rooms when the access token cannot be resolved while joining the default room", async () => {
    const { homeserver } = await setUp(config, (harness) => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockRejectedValueOnce(new Error("Secret not found"));
    });

    expect(homeserver.syncedFrom.length).toBeGreaterThan(0);
  });
});

describe("encrypted rooms", () => {
  // A message Element sends in an encrypted room. The bot has no keys to read it.
  function encrypted(sender: string) {
    nextEvent += 1;
    return { type: "m.room.encrypted", sender, event_id: `$incoming-${nextEvent}`, content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "…" } };
  }
  const cannotRead = expect.objectContaining({ msgtype: "m.notice", body: expect.stringContaining("cannot read encrypted messages") });

  it("says once that it cannot read an encrypted direct message room it joins", async () => {
    const { harness, homeserver } = await setUp();
    await linkAlice(harness, homeserver);
    homeserver.encryptedRooms.add("!alice-dm");

    homeserver.invite("!alice-dm", ALICE, true);
    homeserver.deliver("!alice-dm", encrypted(ALICE));
    await homeserver.read();

    expect(homeserver.messagesIn("!alice-dm")).toEqual([cannotRead]);
  });

  it("says once that it cannot read a room where encrypted messages arrive", async () => {
    const { homeserver } = await setUp();

    homeserver.deliver(ROOM, encrypted(ALICE));
    homeserver.deliver(ROOM, encrypted(MALLORY));
    await homeserver.read();

    expect(homeserver.messagesIn(ROOM)).toEqual([cannotRead]);
  });

  it("says it cannot read the default room when that room is encrypted", async () => {
    const { homeserver } = await setUp();
    homeserver.encryptedRooms.add(ROOM);

    await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });

    expect(homeserver.messagesIn(ROOM)).toEqual([cannotRead]);
  });

  it("says it cannot read a project's room when that room is encrypted", async () => {
    const { harness, homeserver } = await setUp();
    homeserver.encryptedRooms.add("!secret");

    await harness.performAction(
      "setProjectRoom",
      { projectId: "project-1", roomId: "!secret" },
      { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } },
    );

    expect(homeserver.messagesIn("!secret")).toEqual([cannotRead]);
    expect(homeserver.messagesIn(WEBSITE_ROOM)).toHaveLength(0);
  });
});

describe("private network", () => {
  // Paperclip's fetch refuses private addresses, so a homeserver on a private network is reached directly.
  it("reaches the homeserver without Paperclip's fetch when it is on a private network", async () => {
    const { harness, homeserver } = await setUp({ ...config, privateNetwork: true }, (harness) => {
      vi.spyOn(harness.ctx.http, "fetch").mockRejectedValue(new Error("All resolved IPs for matrix.example.com are in private/reserved ranges"));
    });

    await harness.emit("issue.created", {}, issueEvent);

    expect(homeserver.messagesIn(ROOM)).toHaveLength(1);
  });
});
