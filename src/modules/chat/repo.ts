import { createHash } from 'node:crypto';
import type {
  AttachmentDto,
  ConversationDto,
  MessageBodyDto,
  MessageDto,
} from '@tessera-kit/protocol';
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  conversationMembers,
  conversations,
  messageReactions,
  messages,
  readMarkers,
} from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import type { Clock, Ids } from '../../lib/ids.js';
import { parseStored } from '../../lib/json.js';

type MessageRow = typeof messages.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/** Conversation ids become room names (`<app>/chat:<id>`), so they share the room-id alphabet. */
const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Body shown for deleted messages; clients key off `deletedAt` and render their own wording. */
const DELETED_BODY: MessageBodyDto = { type: 'text', text: 'This message was deleted' };

/** `<appId>/<id>`: how a conversation is stored, so the same id can exist in several apps. */
export const conversationKey = (appId: string, id: string): string => `${appId}/${id}`;

/** The id clients see: the stored key without its app prefix. */
export const wireConversationId = (key: string): string => key.slice(key.indexOf('/') + 1);

export const isDirectId = (id: string): boolean => id.startsWith('dm:');

/** Hub room that carries a conversation's live events. */
export const chatRoom = (appId: string, id: string): string => `${appId}/chat:${id}`;

/** Persistence for conversations, messages, reactions and read markers. */
export class ChatRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ids: Ids,
  ) {}

  /** Validates a client-supplied conversation id. */
  static assertConversationId(id: string): void {
    if (!CONVERSATION_ID.test(id)) {
      throw new AppError('VALIDATION', 'conversationId may only contain letters, digits and _.:-');
    }
  }

  getConversation(appId: string, id: string): ConversationRow | undefined {
    return this.db.orm
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationKey(appId, id)))
      .get();
  }

  isMember(appId: string, id: string, userId: string): boolean {
    return (
      this.db.orm
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationKey(appId, id)),
            eq(conversationMembers.userId, userId),
          ),
        )
        .get() !== undefined
    );
  }

  /** Room conversations come into being the first time someone posts to them. */
  ensureRoomConversation(appId: string, id: string, userId: string): ConversationRow {
    const existing = this.getConversation(appId, id);
    if (existing) return existing;
    const row: ConversationRow = {
      id: conversationKey(appId, id),
      appId,
      kind: 'room',
      title: null,
      createdAt: this.clock.now().toISOString(),
      createdBy: userId,
    };
    this.db.orm.insert(conversations).values(row).run();
    return row;
  }

  /** Finds or creates the one direct conversation between two users of an app. */
  openDirect(
    appId: string,
    userId: string,
    otherId: string,
  ): { row: ConversationRow; members: string[] } {
    // Sorted, so both users derive the same id regardless of who opens it first.
    const members = [userId, otherId].sort();
    const hash = createHash('sha256').update(members.join('\n')).digest('hex').slice(0, 24);
    const id = `dm:${hash}`;

    const existing = this.getConversation(appId, id);
    if (existing) return { row: existing, members };

    const now = this.clock.now().toISOString();
    const row: ConversationRow = {
      id: conversationKey(appId, id),
      appId,
      kind: 'direct',
      title: null,
      createdAt: now,
      createdBy: userId,
    };
    this.db.orm.transaction((tx) => {
      tx.insert(conversations).values(row).run();
      tx.insert(conversationMembers)
        .values(members.map((m) => ({ conversationId: row.id, userId: m, joinedAt: now })))
        .run();
    });
    return { row, members };
  }

  directMembers(appId: string, id: string): string[] {
    return this.db.orm
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationKey(appId, id)))
      .orderBy(conversationMembers.userId)
      .all()
      .map((r) => r.userId);
  }

  /** Everything the user can see in an app: its room conversations plus their own direct ones. */
  listConversations(appId: string, userId: string): ConversationDto[] {
    const rooms = this.db.orm
      .select()
      .from(conversations)
      .where(and(eq(conversations.appId, appId), eq(conversations.kind, 'room')))
      .all();
    const directs = this.db.orm
      .select({ c: conversations })
      .from(conversations)
      .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.appId, appId),
          eq(conversations.kind, 'direct'),
          eq(conversationMembers.userId, userId),
        ),
      )
      .all()
      .map((r) => r.c);

    return (
      [...rooms, ...directs]
        .map((row) => {
          const last = this.lastMessage(row.id);
          const dto = this.toConversation(row, {
            ...(row.kind === 'direct'
              ? { members: this.directMembers(appId, wireConversationId(row.id)) }
              : {}),
            ...(last ? { lastMessage: this.toMessage(last) } : {}),
            unread: this.unreadCount(row.id, userId),
          });
          return { dto, lastId: last?.id, createdAt: row.createdAt };
        })
        // Most recently active first. Message ids are monotonic ULIDs, so they order activity
        // exactly even within one millisecond; conversations with no messages come last.
        .sort((a, b) => {
          if (a.lastId && b.lastId) return a.lastId < b.lastId ? 1 : -1;
          if (a.lastId || b.lastId) return a.lastId ? -1 : 1;
          return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
        })
        .map((x) => x.dto)
    );
  }

  private lastMessage(key: string): MessageRow | undefined {
    return this.db.orm
      .select()
      .from(messages)
      .where(eq(messages.conversationId, key))
      .orderBy(desc(messages.id))
      .limit(1)
      .get();
  }

  /** Messages from other people, newer than the user's read marker, that are not deleted. */
  unreadCount(key: string, userId: string): number {
    const marker = this.db.orm
      .select({ messageId: readMarkers.messageId })
      .from(readMarkers)
      .where(and(eq(readMarkers.conversationId, key), eq(readMarkers.userId, userId)))
      .get();
    const row = this.db.orm
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, key),
          ne(messages.authorId, userId),
          isNull(messages.deletedAt),
          marker ? gt(messages.id, marker.messageId) : undefined,
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  /**
   * Moves the read marker forward. Markers never go backwards, so a late or reordered request
   * cannot make already-read messages unread again. Returns the effective marker.
   */
  advanceMarker(
    key: string,
    userId: string,
    messageId: string,
  ): { messageId: string; advanced: boolean } {
    return this.db.orm.transaction((tx) => {
      const current = tx
        .select()
        .from(readMarkers)
        .where(and(eq(readMarkers.conversationId, key), eq(readMarkers.userId, userId)))
        .get();
      if (current && current.messageId >= messageId)
        return { messageId: current.messageId, advanced: false };
      tx.insert(readMarkers)
        .values({
          conversationId: key,
          userId,
          messageId,
          updatedAt: this.clock.now().toISOString(),
        })
        .onConflictDoUpdate({
          target: [readMarkers.conversationId, readMarkers.userId],
          set: { messageId, updatedAt: this.clock.now().toISOString() },
        })
        .run();
      return { messageId, advanced: true };
    });
  }

  // ---------- messages ----------

  getMessage(id: string): MessageRow | undefined {
    return this.db.orm.select().from(messages).where(eq(messages.id, id)).get();
  }

  /** The message a retried `chat.send` already stored, if any. */
  findByClientId(
    conversationKeyValue: string,
    authorId: string,
    clientId: string,
  ): MessageRow | undefined {
    return this.db.orm
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationKeyValue),
          eq(messages.authorId, authorId),
          eq(messages.clientId, clientId),
        ),
      )
      .get();
  }

  insertMessage(input: {
    conversationKey: string;
    appId: string;
    clientId: string;
    author: { id: string; name: string; avatarUrl?: string | undefined };
    body: MessageBodyDto;
    attachments: AttachmentDto[];
    replyTo?: string | undefined;
  }): MessageRow {
    const row: MessageRow = {
      id: this.ids.ulid(),
      appId: input.appId,
      conversationId: input.conversationKey,
      clientId: input.clientId,
      authorId: input.author.id,
      authorName: input.author.name,
      authorAvatarUrl: input.author.avatarUrl ?? null,
      body: JSON.stringify(input.body),
      attachments: JSON.stringify(input.attachments),
      replyTo: input.replyTo ?? null,
      createdAt: this.clock.now().toISOString(),
      editedAt: null,
      deletedAt: null,
    };
    this.db.orm.insert(messages).values(row).run();
    return row;
  }

  /**
   * One page of messages in chronological order. `before` pages towards older messages, `after`
   * towards newer ones (reconnect gap-fill); with neither, the newest page is returned.
   */
  history(
    key: string,
    opts: { before?: string | undefined; after?: string | undefined; limit: number },
  ): { messages: MessageDto[]; hasMore: boolean } {
    const inConversation = eq(messages.conversationId, key);
    const rows = opts.after
      ? this.db.orm
          .select()
          .from(messages)
          .where(and(inConversation, gt(messages.id, opts.after)))
          .orderBy(asc(messages.id))
          .limit(opts.limit + 1)
          .all()
      : this.db.orm
          .select()
          .from(messages)
          .where(opts.before ? and(inConversation, lt(messages.id, opts.before)) : inConversation)
          .orderBy(desc(messages.id))
          .limit(opts.limit + 1)
          .all();

    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    if (!opts.after) page.reverse();
    const reactions = this.reactionsFor(page.map((r) => r.id));
    return { messages: page.map((r) => this.toMessage(r, reactions.get(r.id) ?? {})), hasMore };
  }

  updateBody(id: string, body: MessageBodyDto): MessageRow {
    return this.db.orm
      .update(messages)
      .set({ body: JSON.stringify(body), editedAt: this.clock.now().toISOString() })
      .where(eq(messages.id, id))
      .returning()
      .get() as MessageRow;
  }

  /** Clears content and attachments; the row stays so history keeps its place in the thread. */
  softDelete(id: string): MessageRow {
    return this.db.orm
      .update(messages)
      .set({
        body: JSON.stringify(DELETED_BODY),
        attachments: '[]',
        deletedAt: this.clock.now().toISOString(),
      })
      .where(eq(messages.id, id))
      .returning()
      .get() as MessageRow;
  }

  /** Adds or removes a reaction; returns false when nothing changed (already in that state). */
  setReaction(messageId: string, userId: string, emoji: string, on: boolean): boolean {
    const key = and(
      eq(messageReactions.messageId, messageId),
      eq(messageReactions.userId, userId),
      eq(messageReactions.emoji, emoji),
    );
    if (!on) return this.db.orm.delete(messageReactions).where(key).run().changes > 0;
    return (
      this.db.orm
        .insert(messageReactions)
        .values({ messageId, userId, emoji, createdAt: this.clock.now().toISOString() })
        .onConflictDoNothing()
        .run().changes > 0
    );
  }

  /** `emoji → userIds` for each message id. */
  reactionsFor(messageIds: string[]): Map<string, Record<string, string[]>> {
    const out = new Map<string, Record<string, string[]>>();
    if (messageIds.length === 0) return out;
    const rows = this.db.orm
      .select()
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds))
      .orderBy(messageReactions.createdAt, messageReactions.userId)
      .all();
    for (const r of rows) {
      const byEmoji = out.get(r.messageId) ?? {};
      byEmoji[r.emoji] = [...(byEmoji[r.emoji] ?? []), r.userId];
      out.set(r.messageId, byEmoji);
    }
    return out;
  }

  /** Builds the wire `Message`; pass `reactions` when rendering many rows to avoid N queries. */
  toMessage(row: MessageRow, reactions?: Record<string, string[]>): MessageDto {
    const deleted = row.deletedAt !== null;
    return {
      id: row.id,
      clientId: row.clientId,
      conversationId: wireConversationId(row.conversationId),
      authorId: row.authorId,
      authorName: row.authorName,
      ...(row.authorAvatarUrl === null ? {} : { authorAvatarUrl: row.authorAvatarUrl }),
      body: deleted ? DELETED_BODY : parseStored<MessageBodyDto>(row.body),
      attachments: deleted ? [] : parseStored<AttachmentDto[]>(row.attachments),
      ...(row.replyTo === null ? {} : { replyTo: row.replyTo }),
      reactions: reactions ?? this.reactionsFor([row.id]).get(row.id) ?? {},
      createdAt: row.createdAt,
      ...(row.editedAt === null ? {} : { editedAt: row.editedAt }),
      ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt }),
    };
  }

  toConversation(
    row: ConversationRow,
    extra: { members?: string[]; lastMessage?: MessageDto; unread: number },
  ): ConversationDto {
    return {
      id: wireConversationId(row.id),
      kind: row.kind,
      ...(row.title === null ? {} : { title: row.title }),
      ...(extra.members ? { members: extra.members } : {}),
      ...(extra.lastMessage ? { lastMessage: extra.lastMessage } : {}),
      unread: extra.unread,
    };
  }
}
