import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversationMembers } from '../db/schema.js';
import type { Env } from '../env.js';
import type { AuthUser } from './verifier.js';

/**
 * Decides what an authenticated user may touch. This is the one place to customise access rules:
 * pass your own implementation to `buildApp({ authorizer })`.
 */
export interface Authorizer {
  /** May the user use this app id at all (`JWT_CLAIM_APPS` allowlist)? */
  canAccessApp(user: AuthUser, appId: string): boolean;
  /** May the user join a hub room (`<appId>/<kind>:<id>`)? */
  canJoin(user: AuthUser, room: string): boolean;
  canRead(user: AuthUser, appId: string, collection: string): boolean;
  canWrite(user: AuthUser, appId: string, collection: string): boolean;
}

/** Splits `app/kind:id`; returns null for names that are not well-formed. */
export function parseRoom(room: string): { appId: string; kind: string; id: string } | null {
  const slash = room.indexOf('/');
  const colon = room.indexOf(':', slash + 1);
  if (slash < 1 || colon < 0) return null;
  return {
    appId: room.slice(0, slash),
    kind: room.slice(slash + 1, colon),
    id: room.slice(colon + 1),
  };
}

/** Default rules: app allowlist, member-only direct messages, anonymous users are read/join only. */
export function createAuthorizer(env: Env, db: Db): Authorizer {
  const canAccessApp: Authorizer['canAccessApp'] = (user, appId) =>
    user.apps === null || user.apps.includes(appId);

  const canRead: Authorizer['canRead'] = (user, appId) => canAccessApp(user, appId);

  const isDirectMember = (userId: string, conversationId: string): boolean =>
    db.orm
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .get() !== undefined;

  return {
    canAccessApp,
    canJoin(user, room) {
      const parsed = parseRoom(room);
      if (!parsed || !canAccessApp(user, parsed.appId)) return false;
      // Direct-message rooms are private to their two members.
      if (parsed.kind === 'chat' && parsed.id.startsWith('dm:')) {
        // Conversations are stored under an app-scoped key so ids never collide across apps.
        return isDirectMember(user.id, `${parsed.appId}/${parsed.id}`);
      }
      // Live document changes leak content, so they follow the collection's read rule.
      if (parsed.kind === 'docs') return canRead(user, parsed.appId, parsed.id);
      return true;
    },
    canRead,
    // Outside dev mode a token is mandatory, so "anonymous" can only happen in dev, where it's allowed.
    canWrite: (user, appId) =>
      canAccessApp(user, appId) && (env.authMode === 'dev' || !user.anonymous),
  };
}
