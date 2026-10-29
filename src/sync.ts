import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleReaction } from "./decisions.js";
import { connect, errorMessage, NOT_CONFIGURED, request, whoAmI, type Bot } from "./matrix.js";
import { handleInvite, handleRoomEvent, type InviteEvent, type RoomEvent } from "./threads.js";

// How long the homeserver may hold a /sync request open when nothing happens. ctx.http.fetch gives up
// on any call after 30 seconds, so this stays well below that.
const POLL_TIMEOUT_MS = 25_000;
const MAX_RETRY_DELAY_MS = 60_000;

// Asks for no room history on the first sync: the plugin acts only on messages sent after it starts.
const FIRST_SYNC_FILTER = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 0 } } }));

type SyncResponse = {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: RoomEvent[] } }>;
    invite?: Record<string, { invite_state?: { events?: InviteEvent[] } }>;
  };
};

export type SyncStatus = { running: boolean; lastError: string | null };

// Taken when the module loads, outside any call from Paperclip. The loop runs in it so its calls carry
// no handler ID: Paperclip rejects calls tied to a handler that has already returned, but allows
// calls from a plugin's own loops that name a company whose settings are saved.
const outsideInvocation = AsyncLocalStorage.snapshot();

const loops = new Map<string, { stop: () => void; status: SyncStatus }>();

export function syncStatus(companyId: string): SyncStatus | null {
  return loops.get(companyId)?.status ?? null;
}

function stopSync(companyId: string) {
  loops.get(companyId)?.stop();
  loops.delete(companyId);
}

export function stopAllSyncs() {
  for (const companyId of [...loops.keys()]) stopSync(companyId);
}

// Starts reading the company's Matrix rooms, replacing any loop already running for it.
export function startSync(ctx: PluginContext, companyId: string) {
  stopSync(companyId);
  let stopped = false;
  const status: SyncStatus = { running: true, lastError: null };
  loops.set(companyId, { stop: () => (stopped = true), status });

  const sinceKey = { scopeKind: "company" as const, scopeId: companyId, stateKey: "syncSince" };

  async function run() {
    let failures = 0;
    // Looked up once: the token, and so the account, only changes with a settings save, which restarts the loop.
    let bot: Bot | null = null;
    while (!stopped) {
      try {
        const matrix = await connect(ctx, companyId);
        if (!matrix) {
          status.lastError = NOT_CONFIGURED;
          break;
        }
        bot ??= await whoAmI(ctx, matrix);
        const since = (await ctx.state.get(sinceKey)) as string | null;
        const path = since
          ? `/sync?timeout=${POLL_TIMEOUT_MS}&since=${encodeURIComponent(since)}`
          : `/sync?filter=${FIRST_SYNC_FILTER}`;

        const body = await request<SyncResponse>(ctx, matrix, path);
        // A loop replaced by a settings save must not move the position the new loop reads from.
        if (stopped) break;
        // One invite or message that cannot be handled must not stop the loop reading later ones.
        for (const [roomId, room] of Object.entries(body.rooms?.invite ?? {})) {
          await handleInvite(ctx, matrix, bot, companyId, roomId, room.invite_state?.events ?? []).catch((error) => {
            ctx.logger.warn("Could not accept a Matrix invite", { companyId, roomId, error: errorMessage(error) });
          });
        }
        for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            const handled = event.type === "m.reaction"
              ? handleReaction(ctx, matrix, companyId, roomId, event)
              : handleRoomEvent(ctx, matrix, bot, companyId, roomId, event);
            await handled.catch((error) => {
              ctx.logger.warn("Could not handle a Matrix message", { companyId, roomId, eventId: event.event_id, error: errorMessage(error) });
            });
          }
        }
        await ctx.state.set(sinceKey, body.next_batch);
        status.lastError = null;
        failures = 0;
      } catch (error) {
        status.lastError = errorMessage(error);
        failures += 1;
        ctx.logger.warn("Matrix sync failed", { companyId, failures, error: status.lastError });
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** failures, MAX_RETRY_DELAY_MS)));
      }
    }
    status.running = false;
  }

  void outsideInvocation(run);
}
