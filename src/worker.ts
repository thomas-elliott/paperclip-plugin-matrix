import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { sayIfCannotRead } from "./encryption.js";
import { connect, errorMessage, joinRoom, NOT_CONFIGURED, request } from "./matrix.js";
import { linkedMatrixUser, startLink, unlinkUser } from "./links.js";
import { projectRoomChoices, setProjectRoom } from "./project-rooms.js";
import { registerNotifications } from "./notifications.js";
import { startSync, stopAllSyncs, syncStatus, type SyncStatus } from "./sync.js";

export type ConnectionStatus =
  | { connected: true; userId: string; sync: SyncStatus | null }
  | { connected: false; reason: string };

// The bot can only post in rooms it has joined, and says so there if the room is encrypted. Joining a
// room it is already in does nothing. A failure, such as a room the bot was not invited to or a token
// that cannot be read, is logged and must not stop the sync loop starting: the loop retries, and
// shows its error on the dashboard.
// Project rooms need no join: they are picked from the rooms the bot is already in.
async function joinDefaultRoom(ctx: PluginContext, companyId: string) {
  try {
    const matrix = await connect(ctx, companyId);
    if (!matrix?.defaultRoom) return;
    await joinRoom(ctx, matrix, matrix.defaultRoom);
    await sayIfCannotRead(ctx, matrix, companyId, matrix.defaultRoom);
  } catch (error) {
    ctx.logger.warn("Could not join the default Matrix room", { companyId, error: errorMessage(error) });
  }
}

async function checkConnection(ctx: PluginContext, companyId: string): Promise<ConnectionStatus> {
  const matrix = await connect(ctx, companyId);
  if (!matrix) return { connected: false, reason: NOT_CONFIGURED };
  try {
    const { user_id } = await request<{ user_id: string }>(ctx, matrix, "/account/whoami");
    return { connected: true, userId: user_id, sync: syncStatus(companyId) };
  } catch (error) {
    return { connected: false, reason: errorMessage(error) };
  }
}

// Linking and picking a project's room act for the Paperclip user who is signed in, as Paperclip
// reports them to the action. Agents and the system have no Matrix account to link.
function signedInUser(context: PluginPerformActionContext): { userId: string; companyId: string } {
  const { userId, companyId } = context.actor;
  if (context.actor.type !== "user" || !userId || !companyId) throw new Error("Only a signed-in Paperclip user can do this.");
  return { userId, companyId };
}

function registerLinkActions(ctx: PluginContext) {
  ctx.actions.register("startLink", async (params, context) => {
    const { userId, companyId } = signedInUser(context);
    return startLink(ctx, companyId, userId, String(params.matrixUserId ?? "").trim());
  });
  ctx.actions.register("linkStatus", async (_params, context) => {
    const { userId, companyId } = signedInUser(context);
    return { matrixUserId: await linkedMatrixUser(ctx, companyId, userId) };
  });
  ctx.actions.register("unlink", async (_params, context) => {
    const { userId, companyId } = signedInUser(context);
    await unlinkUser(ctx, companyId, userId);
  });
}

let pluginContext: PluginContext | null = null;

function requireContext(): PluginContext {
  if (!pluginContext) throw new Error("The Matrix plugin worker has not finished starting.");
  return pluginContext;
}

const plugin = definePlugin({
  // Config is read fresh on every call and each company has its own sync loop.
  multiCompanyConfig: true,

  async setup(ctx) {
    ctx.data.register("connection", async (params) => checkConnection(ctx, String(params.companyId ?? "")));
    ctx.data.register("projectRoom", async (params) => projectRoomChoices(ctx, String(params.companyId ?? ""), String(params.projectId ?? "")));
    ctx.actions.register("setProjectRoom", async (params, context) => {
      const { companyId } = signedInUser(context);
      await setProjectRoom(ctx, companyId, String(params.projectId ?? ""), typeof params.roomId === "string" && params.roomId ? params.roomId : null);
    });
    registerNotifications(ctx);
    registerLinkActions(ctx);
    pluginContext = ctx;
  },

  // Paperclip calls this on every settings save, and for each company's saved settings when the
  // worker starts, so it is the one place sync loops start. Implementing it also stops Paperclip
  // restarting the worker on every settings save.
  async onConfigChanged(_config, context) {
    if (!context?.companyId) return;
    await joinDefaultRoom(requireContext(), context.companyId);
    startSync(requireContext(), context.companyId);
  },

  async onShutdown() {
    stopAllSyncs();
  },

  async onHealth() {
    return { status: "ok", message: "Matrix plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
