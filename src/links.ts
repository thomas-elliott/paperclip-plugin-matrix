import { randomInt } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// A link ties a Matrix account to a Paperclip user, so that user's replies in Matrix become their
// comments in Paperclip. Each side proves itself: Paperclip tells the plugin which signed-in user
// started the link, and only the Matrix account they named can complete it by sending the code.

const CODE_LIFETIME_MS = 15 * 60 * 1000;
export const LINK_COMMAND = /^!link\s+(\d{6})$/;

type PendingLink = { userId: string; matrixUserId: string; expiresAt: number };

const pendingKey = (companyId: string, code: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "pending-links", stateKey: code }) as const;
const userByMatrixKey = (companyId: string, matrixUserId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "links", stateKey: matrixUserId }) as const;
const matrixByUserKey = (companyId: string, userId: string) =>
  ({ scopeKind: "company", scopeId: companyId, namespace: "links-by-user", stateKey: userId }) as const;

// The Paperclip user a Matrix account is linked to, or null.
export async function linkedUser(ctx: PluginContext, companyId: string, matrixUserId: string): Promise<string | null> {
  return ((await ctx.state.get(userByMatrixKey(companyId, matrixUserId))) as string | null) ?? null;
}

export async function linkedMatrixUser(ctx: PluginContext, companyId: string, userId: string): Promise<string | null> {
  return ((await ctx.state.get(matrixByUserKey(companyId, userId))) as string | null) ?? null;
}

export async function startLink(ctx: PluginContext, companyId: string, userId: string, matrixUserId: string) {
  if (!/^@[^:\s]+:\S+$/.test(matrixUserId)) throw new Error("Enter a Matrix ID such as @alice:example.com.");
  const code = String(randomInt(100_000, 1_000_000));
  const pending: PendingLink = { userId, matrixUserId, expiresAt: Date.now() + CODE_LIFETIME_MS };
  await ctx.state.set(pendingKey(companyId, code), pending);
  return { code };
}

// Completes a link when `sender` sends a code issued for them. Returns whether it did.
export async function completeLink(ctx: PluginContext, companyId: string, sender: string, code: string): Promise<boolean> {
  const pending = (await ctx.state.get(pendingKey(companyId, code))) as PendingLink | null;
  if (!pending || pending.matrixUserId !== sender || pending.expiresAt < Date.now()) return false;
  await ctx.state.delete(pendingKey(companyId, code));

  // Either account may have been linked to a different one before; one link each.
  await unlinkUser(ctx, companyId, pending.userId);
  const previousUser = await linkedUser(ctx, companyId, sender);
  if (previousUser) await unlinkUser(ctx, companyId, previousUser);

  await ctx.state.set(userByMatrixKey(companyId, sender), pending.userId);
  await ctx.state.set(matrixByUserKey(companyId, pending.userId), sender);
  return true;
}

export async function unlinkUser(ctx: PluginContext, companyId: string, userId: string) {
  const matrixUserId = await linkedMatrixUser(ctx, companyId, userId);
  if (!matrixUserId) return;
  await ctx.state.delete(userByMatrixKey(companyId, matrixUserId));
  await ctx.state.delete(matrixByUserKey(companyId, userId));
}
