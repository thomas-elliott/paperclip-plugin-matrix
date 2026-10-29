import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { FakeHomeserver, HOMESERVER } from "./fake-homeserver.js";

const COMPANY = "co-1";
const ROOM = "!general";
const ALICE = "@alice:example.com";
const MALLORY = "@mallory:example.com";

const config = { homeserverUrl: HOMESERVER, accessToken: "token-ref", defaultRoom: ROOM };

type Seed = Parameters<TestHarness["seed"]>[0];
type Member = NonNullable<Seed["accessMembers"]>[number];
type Approval = NonNullable<Seed["approvals"]>[number];
type Interaction = NonNullable<Seed["issueInteractions"]>[number];

const member = (userId: string, membershipRole = "member") =>
  ({ id: `member-${userId}`, companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole }) as Member;

const issue = { id: "issue-1", companyId: COMPANY, projectId: null, identifier: "ACME-7", title: "Fix the login page", status: "in_progress" } as Issue;

const approval = {
  id: "approval-1",
  companyId: COMPANY,
  type: "hire_agent",
  requestedByAgentId: "agent-1",
  status: "pending",
  decidedByUserId: null,
} as Approval;

const confirmation = (fields: Partial<Interaction> = {}) =>
  ({
    id: "interaction-1",
    companyId: COMPANY,
    issueId: "issue-1",
    kind: "request_confirmation",
    status: "pending",
    createdByAgentId: "agent-1",
    payload: { version: 1, prompt: "Deploy to production?" },
    ...fields,
  }) as Interaction;

const question = {
  id: "interaction-2",
  companyId: COMPANY,
  issueId: "issue-1",
  kind: "ask_user_questions",
  status: "pending",
  createdByAgentId: "agent-1",
  payload: {
    version: 1,
    questions: [
      {
        id: "q1",
        prompt: "Which browser breaks?",
        selectionMode: "single",
        options: [
          { id: "safari", label: "Safari" },
          { id: "firefox", label: "Firefox" },
        ],
      },
    ],
  },
} as Interaction;

async function setUp(role = "member") {
  const homeserver = new FakeHomeserver().install();
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: COMPANY, name: "Acme", issuePrefix: "ACME" } as Company],
    issues: [issue],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Builder" } as Agent],
    approvals: [approval],
    accessMembers: [member("user-alice", role)],
  });
  await plugin.definition.setup(harness.ctx);
  await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });
  await homeserver.read();
  await linkAlice(harness, homeserver);
  return { harness, homeserver };
}

let nextEvent = 0;
function nextId() {
  nextEvent += 1;
  return `$incoming-${nextEvent}`;
}

async function linkAlice(harness: TestHarness, homeserver: FakeHomeserver) {
  const { code } = await harness.performAction<{ code: string }>(
    "startLink",
    { matrixUserId: ALICE },
    { companyId: COMPANY, actor: { type: "user", userId: "user-alice", companyId: COMPANY } },
  );
  homeserver.deliver(ROOM, { type: "m.room.message", sender: ALICE, event_id: nextId(), content: { msgtype: "m.text", body: `!link ${code}` } });
  await homeserver.read();
}

async function react(homeserver: FakeHomeserver, sender: string, eventId: string, key: string) {
  homeserver.deliver(ROOM, { type: "m.reaction", sender, event_id: nextId(), content: { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } } });
  await homeserver.read();
}

// The bot's own messages in the room, without the link confirmations and reactions.
const notices = (homeserver: FakeHomeserver) => homeserver.messageEventsIn(ROOM);

async function postApproval(harness: TestHarness, homeserver: FakeHomeserver) {
  await harness.emit("approval.created", {}, { companyId: COMPANY, entityType: "approval", entityId: "approval-1" });
  return notices(homeserver)[0].eventId;
}

const runFinished = (harness: TestHarness) =>
  harness.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "issue-1" }, { companyId: COMPANY, entityType: "heartbeat_run", entityId: "run-1" });

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  vi.unstubAllGlobals();
});

describe("approvals", () => {
  it("approves as the linked person who reacts with a tick", async () => {
    const { harness, homeserver } = await setUp();
    const message = await postApproval(harness, homeserver);

    await react(homeserver, ALICE, message, "✅");

    expect(await harness.ctx.approvals.get("approval-1", COMPANY)).toMatchObject({ status: "approved", decidedByUserId: "user-alice" });
  });

  it("rejects when the linked person reacts with a cross", async () => {
    const { harness, homeserver } = await setUp();
    const message = await postApproval(harness, homeserver);

    await react(homeserver, ALICE, message, "❌");

    expect(await harness.ctx.approvals.get("approval-1", COMPANY)).toMatchObject({ status: "rejected" });
  });

  it("offers both reactions on the approval message, so people only click", async () => {
    const { harness, homeserver } = await setUp();
    const message = await postApproval(harness, homeserver);

    const keys = homeserver.reactions().filter((relation) => (relation as { event_id: string }).event_id === message);
    expect(keys).toEqual([expect.objectContaining({ key: "✅" }), expect.objectContaining({ key: "❌" })]);
  });

  it("ignores reactions from unlinked people and other emoji", async () => {
    const { harness, homeserver } = await setUp();
    const message = await postApproval(harness, homeserver);

    await react(homeserver, MALLORY, message, "✅");
    await react(homeserver, ALICE, message, "👍");

    expect(await harness.ctx.approvals.get("approval-1", COMPANY)).toMatchObject({ status: "pending" });
    // Silently: the bot does not answer people it does not know.
    expect(notices(homeserver)).toHaveLength(1);
  });

  it("says in the room why Paperclip refused the decision", async () => {
    const { harness, homeserver } = await setUp("viewer");
    const message = await postApproval(harness, homeserver);

    await react(homeserver, ALICE, message, "✅");

    expect(await harness.ctx.approvals.get("approval-1", COMPANY)).toMatchObject({ status: "pending" });
    expect(notices(homeserver).at(-1)?.content.body).toMatch(/could not approve.*viewer/);
  });

  it("edits the approval message to show the decision and who made it", async () => {
    const { harness, homeserver } = await setUp();
    const message = await postApproval(harness, homeserver);
    harness.seed({ approvals: [{ ...approval, status: "approved", decidedByUserId: "user-alice" }] });

    await harness.emit("approval.decided", {}, { companyId: COMPANY, entityType: "approval", entityId: "approval-1" });

    const edit = notices(homeserver).at(-1)!.content;
    expect(edit["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: message });
    expect((edit["m.new_content"] as { body: string }).body).toMatch(new RegExp(`^Approved by ${ALICE}`));
  });
});

describe("agents' requests", () => {
  it("posts a pending confirmation in the issue's thread when the agent's run ends, and accepts it on a tick", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issueInteractions: [confirmation()] });

    await runFinished(harness);
    const posted = notices(homeserver)[0];
    expect(posted.content.body).toContain("Deploy to production?");
    await react(homeserver, ALICE, posted.eventId, "✅");

    const [interaction] = await harness.ctx.issues.listInteractions("issue-1", COMPANY);
    expect(interaction.status).toBe("accepted");
    const edit = notices(homeserver).at(-1)!.content;
    expect(edit["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: posted.eventId });
    expect((edit["m.new_content"] as { body: string }).body).toContain("Accepted");
  });

  it("posts a question with its numbered options, once, and asks for a reply", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issueInteractions: [question] });

    await runFinished(harness);
    await runFinished(harness);

    expect(notices(homeserver)).toHaveLength(1);
    const { body } = notices(homeserver)[0].content;
    expect(body).toContain("Which browser breaks?\n1. Safari\n2. Firefox");
    expect(body).toContain("Reply in this thread");
    // A reply is the only way to answer, so the bot offers no reactions on a question.
    expect(homeserver.reactions()).not.toContainEqual(expect.objectContaining({ event_id: notices(homeserver)[0].eventId }));
  });

  it("does not post requests that were resolved before the plugin saw them", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issueInteractions: [confirmation({ status: "accepted" })] });

    await runFinished(harness);

    expect(notices(homeserver)).toHaveLength(0);
  });
});
