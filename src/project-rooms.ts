import type { PluginContext, Project } from "@paperclipai/plugin-sdk";
import { sayIfCannotRead } from "./encryption.js";
import { connect, NOT_CONFIGURED, request, type Matrix } from "./matrix.js";

// A project can have its own room, picked in the project's Matrix tab from the rooms the bot is in.
// It is stored against the project's ID, so renaming the project keeps its room.

export type RoomChoice = { roomId: string; name: string };
export type ProjectRoomChoices =
  | { connected: true; rooms: RoomChoice[]; selected: string | null }
  | { connected: false; reason: string };

const projectRoomKey = (projectId: string) => ({ scopeKind: "project", scopeId: projectId, stateKey: "matrixRoom" }) as const;

// The project's room ID, or null when it uses the default room.
export async function projectRoom(ctx: PluginContext, projectId: string): Promise<string | null> {
  return ((await ctx.state.get(projectRoomKey(projectId))) as string | null) ?? null;
}

export async function setProjectRoom(ctx: PluginContext, companyId: string, projectId: string, roomId: string | null) {
  if (!(await ctx.projects.get(projectId, companyId))) throw new Error("No such project.");
  if (!roomId) {
    await ctx.state.delete(projectRoomKey(projectId));
    return;
  }
  await ctx.state.set(projectRoomKey(projectId), roomId);
  const matrix = await connect(ctx, companyId);
  if (matrix) await sayIfCannotRead(ctx, matrix, companyId, roomId);
}

// The project whose room this is, or null. Two projects given the same room share it; the first wins.
export async function projectOfRoom(ctx: PluginContext, companyId: string, roomId: string): Promise<Project | null> {
  for (const project of await ctx.projects.list({ companyId })) {
    if ((await projectRoom(ctx, project.id)) === roomId) return project;
  }
  return null;
}

// A room's name, else its alias, else its ID. Clients name a room without either after its members,
// which would take more lookups than a picker is worth.
async function roomName(ctx: PluginContext, matrix: Matrix, roomId: string): Promise<string> {
  const state = (type: string) =>
    request<{ name?: string; alias?: string }>(ctx, matrix, `/rooms/${encodeURIComponent(roomId)}/state/${type}`).catch(() => ({ name: undefined, alias: undefined }));
  return (await state("m.room.name")).name || (await state("m.room.canonical_alias")).alias || roomId;
}

export async function projectRoomChoices(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectRoomChoices> {
  const matrix = await connect(ctx, companyId);
  if (!matrix) return { connected: false, reason: NOT_CONFIGURED };
  const { joined_rooms } = await request<{ joined_rooms: string[] }>(ctx, matrix, "/joined_rooms");
  const rooms = await Promise.all(joined_rooms.map(async (roomId) => ({ roomId, name: await roomName(ctx, matrix, roomId) })));
  rooms.sort((a, b) => a.name.localeCompare(b.name));
  return { connected: true, rooms, selected: await projectRoom(ctx, projectId) };
}
