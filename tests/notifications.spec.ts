import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Company, Issue, Project } from "@paperclipai/plugin-sdk";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { FakeHomeserver, HOMESERVER } from "./fake-homeserver.js";

const COMPANY = "co-1";
const DEFAULT_ROOM = "!default";
const PROJECT_ROOM = "!backend";

const config = {
  homeserverUrl: HOMESERVER,
  accessToken: "token-ref",
  paperclipUrl: "https://paperclip.example.com/",
  defaultRoom: DEFAULT_ROOM,
  projectRooms: [{ project: "Backend", room: PROJECT_ROOM }],
};

// The harness's entity types are the full server shapes; tests fill in only the fields the plugin reads.
const company = { id: COMPANY, name: "Acme", issuePrefix: "ACME" } as Company;
const projects = [
  { id: "proj-backend", companyId: COMPANY, name: "Backend" },
  { id: "proj-docs", companyId: COMPANY, name: "Docs" },
] as Project[];
const agents = [{ id: "agent-1", companyId: COMPANY, name: "Builder" }] as Agent[];
// The SDK does not export the Approval type, so take it from the harness.
type Approval = NonNullable<Parameters<TestHarness["seed"]>[0]["approvals"]>[number];

function issue(fields: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    companyId: COMPANY,
    projectId: null,
    identifier: "ACME-7",
    title: "Fix the login page",
    status: "todo",
    assigneeAgentId: null,
    ...fields,
  } as Issue;
}

async function setUp(pluginConfig: Record<string, unknown> = config) {
  const homeserver = new FakeHomeserver().install();
  const harness = createTestHarness({ manifest, config: pluginConfig });
  harness.seed({ companies: [company], projects, agents });
  await plugin.definition.setup(harness.ctx);
  return { harness, homeserver };
}

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  vi.unstubAllGlobals();
});

describe("issue notifications", () => {
  it("posts a new issue to the default room, linked to Paperclip", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({ assigneeAgentId: "agent-1" })] });

    await harness.emit("issue.created", {}, { companyId: COMPANY, entityType: "issue", entityId: "issue-1" });

    const [message] = homeserver.messagesIn(DEFAULT_ROOM);
    expect(message.msgtype).toBe("m.notice");
    expect(message.body).toContain("ACME-7");
    expect(message.body).toContain("Fix the login page");
    expect(message.body).toContain("Builder");
    expect(message.formatted_body).toContain('href="https://paperclip.example.com/ACME/issues/ACME-7"');
  });

  it("posts to the project's own room when it has one", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({ projectId: "proj-backend" })] });

    await harness.emit("issue.created", {}, { companyId: COMPANY, entityType: "issue", entityId: "issue-1" });

    expect(homeserver.messagesIn(PROJECT_ROOM)).toHaveLength(1);
    expect(homeserver.messagesIn(DEFAULT_ROOM)).toHaveLength(0);
  });

  it("uses the default room for a project without its own room", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({ projectId: "proj-docs" })] });

    await harness.emit("issue.created", {}, { companyId: COMPANY, entityType: "issue", entityId: "issue-1" });

    expect(homeserver.messagesIn(DEFAULT_ROOM)).toHaveLength(1);
  });

  it("posts once when an issue becomes done", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({ status: "done" })] });
    const base = { companyId: COMPANY, entityType: "issue", entityId: "issue-1" };

    await harness.emit("issue.updated", { status: "done", _previous: { status: "in_review" } }, base);
    // Later edits to a done issue, such as a new title, are not news.
    await harness.emit("issue.updated", { title: "Fix the login form", _previous: { title: "Fix the login page" } }, base);

    const messages = homeserver.messagesIn(DEFAULT_ROOM);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toMatch(/done/i);
    expect(messages[0].body).toContain("ACME-7");
  });

  it("ignores status changes other than becoming done", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({ status: "in_progress" })] });

    await harness.emit("issue.updated", { status: "in_progress", _previous: { status: "todo" } }, { companyId: COMPANY, entityType: "issue", entityId: "issue-1" });

    expect(homeserver.sent).toHaveLength(0);
  });

  it("does not post the same event twice when Paperclip delivers it again", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({})] });
    const base = { eventId: "event-1", companyId: COMPANY, entityType: "issue", entityId: "issue-1" };

    await harness.emit("issue.created", {}, base);
    await harness.emit("issue.created", {}, base);

    expect(homeserver.sent).toHaveLength(1);
  });
});

describe("other notifications", () => {
  it("asks for an approval, naming who requested it", async () => {
    const { harness, homeserver } = await setUp();
    const approval = { id: "appr-1", companyId: COMPANY, type: "hire_agent", requestedByAgentId: "agent-1", status: "pending" } as Approval;
    harness.seed({ approvals: [approval] });

    await harness.emit("approval.created", {}, { companyId: COMPANY, entityType: "approval", entityId: "appr-1" });

    const [message] = homeserver.messagesIn(DEFAULT_ROOM);
    expect(message.body).toMatch(/approval/i);
    expect(message.body).toContain("hire agent");
    expect(message.body).toContain("Builder");
    expect(message.formatted_body).toContain('href="https://paperclip.example.com/ACME/approvals/appr-1"');
  });

  it("reports a failed run with its agent, issue and error", async () => {
    const { harness, homeserver } = await setUp();
    harness.seed({ issues: [issue({ projectId: "proj-backend" })] });

    await harness.emit(
      "agent.run.failed",
      { runId: "run-1", agentId: "agent-1", issueId: "issue-1", error: "Process exited with code 1" },
      { companyId: COMPANY, entityType: "heartbeat_run", entityId: "run-1" },
    );

    // The run worked on a Backend issue, so the Backend room hears about it.
    const [message] = homeserver.messagesIn(PROJECT_ROOM);
    expect(message.body).toContain("Builder");
    expect(message.body).toContain("ACME-7");
    expect(message.body).toContain("Process exited with code 1");
  });

  it("tells a budget warning apart from a reached limit", async () => {
    const { harness, homeserver } = await setUp();
    const base = { companyId: COMPANY, entityType: "budget_incident" };

    await harness.emit("budget.incident.opened", { scopeType: "agent", scopeId: "agent-1", amountObserved: 8_000, amountLimit: 10_000 }, { ...base, entityId: "inc-1" });
    await harness.emit("budget.incident.opened", { scopeType: "company", scopeId: COMPANY, amountObserved: 10_250, amountLimit: 10_000 }, { ...base, entityId: "inc-2" });

    const [warning, limit] = homeserver.messagesIn(DEFAULT_ROOM);
    expect(warning.body).toContain("Builder");
    expect(warning.body).toContain("$80.00 of $100.00");
    expect(warning.body).not.toMatch(/paused/i);
    expect(limit.body).toContain("Acme");
    expect(limit.body).toMatch(/paused/i);
  });
});

describe("rooms", () => {
  it("posts to a room given as an alias", async () => {
    const { harness, homeserver } = await setUp({ ...config, defaultRoom: "#general:example.com" });
    homeserver.aliases.set("#general:example.com", "!general");
    harness.seed({ issues: [issue({})] });

    await harness.emit("issue.created", {}, { companyId: COMPANY, entityType: "issue", entityId: "issue-1" });

    expect(homeserver.messagesIn("!general")).toHaveLength(1);
  });

  it("sends nothing when no room is set", async () => {
    const { harness, homeserver } = await setUp({ homeserverUrl: HOMESERVER, accessToken: "token-ref" });
    harness.seed({ issues: [issue({})] });

    await harness.emit("issue.created", {}, { companyId: COMPANY, entityType: "issue", entityId: "issue-1" });

    expect(homeserver.sent).toHaveLength(0);
  });

  it("joins every configured room when the settings are saved", async () => {
    const { homeserver } = await setUp();

    await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });

    expect(homeserver.joined.sort()).toEqual([PROJECT_ROOM, DEFAULT_ROOM].sort());
  });
});
