import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { connect, errorMessage, joinRoom, NOT_CONFIGURED, request } from "./matrix.js";
import { linkedMatrixUser, startLink, unlinkUser } from "./links.js";
import { registerNotifications } from "./notifications.js";
import { startSync, stopAllSyncs, syncStatus, type SyncStatus } from "./sync.js";

export type ConnectionStatus =
  | { connected: true; userId: string; sync: SyncStatus | null }
  | { connected: false; reason: string };

// The bot can only post in rooms it has joined. Joining a room it is already in does nothing, and a
// room the bot was not invited to fails, which the log reports without failing the settings save.
async function joinConfiguredRooms(ctx: PluginContext, companyId: string) {
  const matrix = await connect(ctx, companyId);
  if (!matrix) return;
  const rooms = new Set([matrix.defaultRoom, ...matrix.projectRooms.map((entry) => entry.room)]);
  for (const room of rooms) {
    if (!room) continue;
    await joinRoom(ctx, matrix, room).catch((error) => {
      ctx.logger.warn("Could not join a Matrix room", { companyId, room, error: errorMessage(error) });
    });
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

// Linking acts for the Paperclip user who is signed in, as Paperclip reports them to the action.
// Agents and the system have no Matrix account to link.
function signedInUser(context: PluginPerformActionContext): { userId: string; companyId: string } {
  const { userId, companyId } = context.actor;
  if (context.actor.type !== "user" || !userId || !companyId) throw new Error("Only a signed-in Paperclip user can link a Matrix account.");
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
    registerNotifications(ctx);
    registerLinkActions(ctx);
    pluginContext = ctx;
  },

  // Paperclip calls this on every settings save, and for each company's saved settings when the
  // worker starts, so it is the one place sync loops start. Implementing it also stops Paperclip
  // restarting the worker on every settings save.
  async onConfigChanged(_config, context) {
    if (!context?.companyId) return;
    await joinConfiguredRooms(requireContext(), context.companyId);
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
