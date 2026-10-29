# Matrix for Paperclip

This plugin connects [Paperclip](https://paperclip.ing) to a [Matrix](https://matrix.org) homeserver.
A bot account posts Paperclip's news in your rooms, and people can reply, decide approvals and ask
agents for work from Matrix.

## What it does

- Each issue gets one thread in its project's room, or in the default room. The bot posts there when
  the issue is created, when an agent comments on it, when an agent's run on it fails, and when it is
  done.
- A linked person's reply in an issue's thread becomes their comment on the issue.
- Approvals appear in the default room. The bot adds a tick and a cross reaction to each one: a
  linked person selects the tick to approve or the cross to reject. The message then shows the
  decision and who made it, including decisions made in Paperclip.
- When an agent asks for confirmation, the bot posts in the issue's thread with the same tick and
  cross, to accept or reject. Answer an agent's question by replying in the thread.
- Mention the bot, or send it a direct message, and it creates an issue from your message. The
  issue goes to an agent mentioned as `@url-key` in the message, otherwise the project's lead agent
  in a project's room, otherwise the default agent. The conversation carries on in your message's
  thread.
- `!clip status` shows open work, working agents and waiting approvals. `!clip issues` lists open
  issues, or only the project's issues in a project's room.
- Budget warnings appear in the default room.
- A dashboard widget shows whether the bot is connected and reading rooms, and lets you link your
  Matrix account.
- A Matrix tab on each project picks the project's room from the rooms the bot is in.

Only linked people can reply, decide, ask for work or use commands. The bot ignores everyone else.

## Limitations

- The bot cannot read encrypted rooms. It says so once in any encrypted room it is in. Matrix cannot
  turn encryption off in a room, so create rooms for the bot with encryption turned off. Element
  encrypts direct messages, so for a direct conversation create a private room with encryption off
  and mention the bot there.
- Everything is posted by one bot account, with the agent's name in the message. Agents do not have
  their own Matrix accounts.
- Editing or deleting a message in Matrix does not change the comment or issue made from it.

## Install

You need a Matrix homeserver where you can create an account, a Paperclip instance, and the right to
install plugins in Paperclip.

### 1. Create the bot account

On [Tuwunel](https://github.com/matrix-construct/tuwunel), send this in the admin room, choosing a
username and a long random password:

```
!admin users create-user paperclip <password>
```

On another homeserver, register the account as you would any user.

Sign in once to get the bot's access token:

```bash
curl -X POST https://matrix.example.com/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type": "m.login.password", "identifier": {"type": "m.id.user", "user": "paperclip"}, "password": "<password>", "initial_device_display_name": "Paperclip"}'
```

Copy `access_token` from the answer. The token stops working if this session is signed out, for
example from the bot's session list in Element.

Optionally, give the bot a display name, such as Paperclip, so people can mention it by name. Sign in
as the bot in Element and set it in the profile settings.

### 2. Install the plugin

```bash
npx paperclipai plugin install @thomas-elliott/paperclip-plugin-matrix --api-base https://your-paperclip.example.com
```

### 3. Fill in the settings

Open the Matrix plugin's settings in Paperclip:

| Setting | What to enter |
| --- | --- |
| Homeserver address | The homeserver's address, such as `https://matrix.example.com` |
| Bot access token | The access token from step 1, added as a Paperclip secret |
| Room | The default room, as a room ID (`!abc…`) or alias (`#name:example.com`). Approvals, budget warnings and issues outside a project's room go here |
| Default agent | Optional. The URL key or name of the agent that gets work asked for outside a project's room |
| Homeserver is on a private network | Turn on if Paperclip reaches the homeserver at a private address, such as `192.168.x.x` or `10.x.x.x`. Paperclip blocks plugins from private addresses unless this is on |
| Paperclip address | Optional. Paperclip's web address, such as `https://paperclip.example.com`, so messages link to it |

Invite the bot to the default room, then save. The bot joins the room when the settings are saved.
The dashboard widget should show "Connected" and the bot's Matrix ID.

### 4. Give projects their own rooms

Optional. Invite the bot to the project's room, open the project in Paperclip, go to its Matrix tab,
and pick the room. A project without a room uses the default room.

The bot accepts invites only from linked people, so link your account first.

### 5. Link your account

Each person links their own Matrix account:

1. In the Matrix widget on the Paperclip dashboard, enter your Matrix ID, such as
   `@alice:example.com`, and select Link.
2. Within 15 minutes, send the `!link` message the widget shows, from that Matrix account, in a room
   the bot is in.
3. The bot reacts with a tick when you are linked.

Your replies, decisions and requests in Matrix then count as yours in Paperclip.

## Upgrade

If a new version of the plugin needs more permissions, Paperclip refuses the upgrade. Uninstall the
plugin and install it again; your settings are kept. Do not add `--force`, which deletes them.

```bash
npx paperclipai plugin uninstall paperclip-plugin-matrix --api-base https://your-paperclip.example.com
npx paperclipai plugin install @thomas-elliott/paperclip-plugin-matrix --api-base https://your-paperclip.example.com
```

## Development

Needs Node.js 24.11 or later and pnpm.

```bash
pnpm install
pnpm dev        # rebuilds dist/ on every save
pnpm test
pnpm typecheck
```

Install into a running Paperclip from this folder. Paperclip reloads the worker when `dist/`
changes, so keep `pnpm dev` running:

```bash
npx paperclipai plugin install "$PWD"
npx paperclipai plugin inspect paperclip-plugin-matrix   # the plugin ID, not the npm name
```

Paperclip only rereads the manifest on an upgrade, so run
`npx paperclipai plugin upgrade paperclip-plugin-matrix` after changing it.

To publish, set the version in `package.json` and create a GitHub release tagged `v` and that
version, such as `v0.1.0`. A workflow then publishes the package to npm.

## References

- [Plugin authoring guide](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md)
- [Plugin specification](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md)
- [Matrix client-server API](https://spec.matrix.org/latest/client-server-api/)
