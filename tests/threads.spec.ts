import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Company, Issue, IssueComment } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { BOT_USER, FakeHomeserver, HOMESERVER } from "./fake-homeserver.js";

const COMPANY = "co-1";
const ROOM = "!general";
const ALICE = "@alice:example.com";
const MALLORY = "@mallory:example.com";

const config = { homeserverUrl: HOMESERVER, accessToken: "token-ref", defaultRoom: ROOM };

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
async function setUp() {
  const homeserver = new FakeHomeserver().install();
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: COMPANY, name: "Acme", issuePrefix: "ACME" } as Company],
    issues: [issue],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Builder" } as Agent],
    accessMembers: [member("user-alice")],
  });
  await plugin.definition.setup(harness.ctx);
  await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });
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

  it("does not start a thread for an agent's comment", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issueComments: [comment({})] });

    await harness.emit("issue.comment.created", { commentId: "comment-1" }, commentEvent("agent"));

    expect(homeserver.sent).toHaveLength(0);
  });
});
