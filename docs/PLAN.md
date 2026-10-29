# Plan

Goal: give Paperclip a Matrix connector that behaves like its built-in Slack and Discord chat
channels, built as a plugin the same way as `../paperclip-plugin-forgejo`.

## Why it is a plugin and not a chat channel

Paperclip's built-in chat channels (Slack, Discord, Teams, Telegram and others) are part of its
core server, and the list of providers is fixed in code. A plugin cannot add one. So this plugin
copies how the built-in channels behave, using the plugin SDK. The npm plugins
`mvanhorn/paperclip-plugin-slack` and `-discord` are built the same way, but they call Paperclip's
REST API with an admin key for approvals and comments. This plugin uses the SDK's own capabilities
instead: `approvals.respond`, `issue.interactions.respond`,
`issue.comments.create_human_attributed` and `agent.sessions.*`.

## Decisions

- Unencrypted rooms only, at first. Encrypted rooms need Matrix's native crypto library, which
  may not bundle into an npm plugin. When the bot joins an encrypted room, it says it cannot read
  it and does nothing else there.
- One bot account, at first. Every message comes from the bot, with the agent's name in the
  message. One Matrix user per agent would need an appservice, and Paperclip's webhooks cannot
  serve one: they accept only POST on a fixed path.
- The worker reads messages with a `/sync` long-poll. It starts in `onConfigChanged`, because
  secrets only resolve with a company there, and keeps its `since` token in plugin state. This is
  the same pattern as the Discord plugin's gateway.
- The plugin calls Matrix's HTTP API directly, without `matrix-js-sdk`. About ten endpoints are
  needed.
- The first milestone is notifications plus threads and replies (steps 1 and 2 below).

## What the early tests found

Tested on 29 October 2026 against the development Paperclip (2026.1023.0) and matrix.smol.cloud.

1. Long-poll through `ctx.http.fetch` works, with limits. Every call through the host gives up
   after 30 seconds, so `/sync` asks the homeserver to answer within 25 seconds; idle polls finish
   in just over 25 seconds. The host also drops the request's abort signal, so a poll in progress
   cannot be cancelled, and it turns request bodies into strings, so media uploads in step 6 may
   need Node's own `fetch`.
2. The loop must run outside any handler call. A loop started inside `onConfigChanged` carries that
   call's ID, and Paperclip rejects its calls once the handler returns. The loop runs inside an
   `AsyncLocalStorage.snapshot()` taken at module load, as the Slack plugin does. Paperclip accepts
   such calls if they name a company whose settings are saved. After a worker restart, Paperclip
   replays each company's saved settings, which starts the loop again. Tested with disable and
   enable, not a full server restart.
3. A comment created with `actorUserId` wakes the issue's assignee, as a board user's comment does,
   unless the issue is done or cancelled. Confirmed on 29 October 2026: a Matrix reply on a backlog
   issue started the assigned agent's run with wake reason `issue_commented`.
4. Idle sleep does not apply. Only a hosting controller such as Paperclip's cloud puts an instance
   to sleep, and a worker without `onIdleDrain` keeps it awake.

Other things learned:

- Room IDs in room version 12 have no `:server` part. Never parse a server name out of one.
- The development Paperclip did not reload the worker after `pnpm dev` rebuilt `dist/`. Disabling
  and enabling the plugin did.

## Milestone 1

### Step 1: notifications

- Settings, per company:
  - homeserver address
  - bot access token, as a secret (the bot's user ID comes from `/account/whoami`)
  - default room
  - optional room per project
- A dashboard widget that shows whether the plugin can reach the homeserver, and as which user.
- Posts to the project's room, or the default room:
  - issue created (`issue.created`)
  - issue done (`issue.updated`)
  - approval waiting (`approval.created`)
  - agent run failed (`agent.run.failed`)
  - budget alert (`budget.incident.opened`)
- The bot joins the configured rooms when the settings are saved.

### Step 2: threads and replies

- The issue-created message is the root of a Matrix thread for that issue. Later notifications
  about the issue go in the thread. Plugin state maps issue to thread root, both ways.
- A reply in the thread from a linked Matrix user becomes a comment on the issue, attributed to
  their Paperclip user. Replies from unlinked users are ignored.
- The bot reacts to each reply it has copied, so people can see it arrived.
- Linking: each person links their own accounts. In the dashboard widget they enter their Matrix
  ID and get a six-digit code, then send `!link <code>` from that Matrix account within 15
  minutes. Paperclip tells the plugin which signed-in user asked, and only the named Matrix
  account can use the code. A settings table could not work: Paperclip identifies members only by
  an opaque user ID.

## Milestone 2: approvals and questions

- Approvals go to the default room. The bot adds tick and cross reactions to its message; a linked
  person clicking one calls `ctx.approvals.decide` as their Paperclip user. On `approval.decided`
  the bot edits the message to show the outcome and who decided, whether in Matrix or in
  Paperclip's web page.
- Paperclip refuses decisions from anyone who is not an active, non-viewer member. The bot posts
  the reason in the room. Reactions from unlinked people and other emoji are ignored silently.
- Paperclip gives plugins no people's names, so a decider is shown by their linked Matrix ID, or
  as "in Paperclip".
- Agents' requests ("interactions"): Paperclip sends no event when one is created, so the plugin
  calls `listInteractions` when an agent's run on an issue ends (`agent.run.finished` or
  `agent.run.failed`). Pending requests go in the issue's thread. At a later run's end, messages
  of requests answered since are edited to show the outcome.
- `respondInteraction` can only accept or reject, and Paperclip refuses both for
  `ask_user_questions`. So questions are posted with numbered options and answered by replying in
  the thread: the reply becomes a comment, which wakes the agent, and closes the question card if
  the agent set `supersedeOnUserComment`. Only `request_confirmation` gets tick and cross
  reactions; other kinds say "Answer in Paperclip". A reaction cannot give a reason, so
  confirmations that require one for rejecting are refused, with the reason posted.

## Later

4. Commands: `!clip status`, `issues`, `agents`, `approve`, `new`, or the same after mentioning
   the bot.
5. Talking to agents: a mention or direct message starts a thread that becomes an issue. Progress
   is shown by editing one message in place.
6. Daily digest, agent tools (`send_matrix_message`, `escalate_to_human`) with a skill, and
   attachments.
7. Encrypted rooms, and one Matrix user per agent.

Not planned: voice, the npm plugins' workflow engine and "intelligence" scans.
