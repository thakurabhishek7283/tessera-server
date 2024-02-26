import type { AttachmentDto, MessageBodyDto } from '@tessera/protocol';
import { and, eq } from 'drizzle-orm';
import { uploads } from '../../db/schema.js';
import type { Env } from '../../env.js';
import type { HandlerContext } from '../../hub/handlers.js';
import type { Hub } from '../../hub/hub.js';
import { AppError } from '../../lib/errors.js';
import { asJson, jsonBytes } from '../../lib/json.js';
import { uploadUrl } from '../uploads/url.js';
import { ChatRepo, chatRoom, isDirectId, wireConversationId } from './repo.js';
import { ChatService } from './service.js';

/** Rich message bodies are stored opaquely, so cap their serialised size. */
const MAX_RICH_BYTES = 32 * 1024;

/** Bounds the reaction rows one message can accumulate. */
const MAX_EMOJI_PER_MESSAGE = 20;

/** Registers the `chat.*` request handlers on the hub. */
export function registerChatHandlers(hub: Hub, env: Env): ChatService {
  const repo = new ChatRepo(hub.deps.db, hub.deps.clock, hub.deps.ids);
  const service = new ChatService(repo, hub.deps.authorizer);
  const { handlers } = hub;

  const requireWrite = (ctx: HandlerContext): void => {
    if (!ctx.authorizer.canWrite(ctx.user, ctx.appId, 'chat')) {
      throw new AppError('FORBIDDEN', 'Not allowed to write chat messages');
    }
  };

  /** Finds the conversation to post in, creating a room conversation on first use. */
  const conversationForWrite = (ctx: HandlerContext, id: string) => {
    ChatRepo.assertConversationId(id);
    if (isDirectId(id)) {
      // Direct conversations only come from `chat.open-direct`.
      if (!repo.getConversation(ctx.appId, id) || !repo.isMember(ctx.appId, id, ctx.user.id)) {
        throw new AppError('NOT_FOUND', 'Conversation does not exist');
      }
    }
    return repo.ensureRoomConversation(ctx.appId, id, ctx.user.id);
  };

  const checkBody = (body: MessageBodyDto): void => {
    if (body.type === 'rich' && jsonBytes(body.doc) > MAX_RICH_BYTES) {
      throw new AppError('VALIDATION', `Rich message is larger than ${MAX_RICH_BYTES} bytes`);
    }
  };

  /**
   * Attachments must be the caller's own uploads. Everything but the display name is taken from
   * the stored upload, so a client cannot attach arbitrary URLs or lie about type and size.
   */
  const resolveAttachments = (
    ctx: HandlerContext,
    given: AttachmentDto[] | undefined,
  ): AttachmentDto[] =>
    (given ?? []).map((a) => {
      const row = ctx.db.orm
        .select()
        .from(uploads)
        .where(
          and(eq(uploads.id, a.id), eq(uploads.appId, ctx.appId), eq(uploads.ownerId, ctx.user.id)),
        )
        .get();
      if (!row) throw new AppError('VALIDATION', `Unknown attachment "${a.id}"`);
      return {
        id: row.id,
        url: uploadUrl(env.publicUrl, row.path),
        name: a.name,
        mime: row.mime,
        size: row.size,
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
      };
    });

  handlers.register('chat.open-direct', (ctx, req) => {
    requireWrite(ctx);
    if (req.userId === ctx.user.id)
      throw new AppError('VALIDATION', 'Cannot open a conversation with yourself');
    const { row, members } = repo.openDirect(ctx.appId, ctx.user.id, req.userId);
    return repo.toConversation(row, { members, unread: 0 });
  });

  handlers.register('chat.send', (ctx, req) => {
    requireWrite(ctx);
    const { chatSendBurst, chatSendPerSecond } = hub.options;
    if (!ctx.hub.limits.take(`chat.send:${ctx.user.id}`, chatSendBurst, chatSendPerSecond)) {
      throw new AppError('RATE_LIMITED', 'Sending too fast; slow down');
    }
    const conversation = conversationForWrite(ctx, req.conversationId);

    // A retry after a lost response returns the stored message and does not announce it again.
    const duplicate = repo.findByClientId(conversation.id, ctx.user.id, req.clientId);
    if (duplicate) return repo.toMessage(duplicate);

    checkBody(req.body);
    const attachments = resolveAttachments(ctx, req.attachments);
    if (req.replyTo) {
      const parent = repo.getMessage(req.replyTo);
      if (!parent || parent.conversationId !== conversation.id) {
        throw new AppError('VALIDATION', 'replyTo must be a message in the same conversation');
      }
    }

    const row = repo.insertMessage({
      conversationKey: conversation.id,
      appId: ctx.appId,
      clientId: req.clientId,
      author: { id: ctx.user.id, name: ctx.user.name, avatarUrl: ctx.user.avatarUrl },
      body: req.body,
      attachments,
      replyTo: req.replyTo,
    });
    const message = repo.toMessage(row);
    hub.broadcast(chatRoom(ctx.appId, req.conversationId), 'chat.message', asJson(message));
    return message;
  });

  /** Loads a message the caller may see: same app, and a direct conversation they belong to. */
  const accessibleMessage = (ctx: HandlerContext, messageId: string) => {
    const row = repo.getMessage(messageId);
    const id = row ? wireConversationId(row.conversationId) : '';
    if (
      !row ||
      row.appId !== ctx.appId ||
      (isDirectId(id) && !repo.isMember(ctx.appId, id, ctx.user.id))
    ) {
      throw new AppError('NOT_FOUND', 'Message does not exist');
    }
    return { row, room: chatRoom(ctx.appId, id) };
  };

  handlers.register('chat.edit', (ctx, req) => {
    requireWrite(ctx);
    const { row, room } = accessibleMessage(ctx, req.messageId);
    if (row.authorId !== ctx.user.id)
      throw new AppError('FORBIDDEN', 'Only the author can edit a message');
    if (row.deletedAt) throw new AppError('NOT_FOUND', 'Message was deleted');
    checkBody(req.body);

    const message = repo.toMessage(repo.updateBody(row.id, req.body));
    hub.broadcast(room, 'chat.message-updated', asJson(message));
    return message;
  });

  handlers.register('chat.delete', (ctx, req) => {
    requireWrite(ctx);
    const { row, room } = accessibleMessage(ctx, req.messageId);
    const moderator = ctx.user.roles?.includes('moderator') ?? false;
    if (row.authorId !== ctx.user.id && !moderator) {
      throw new AppError('FORBIDDEN', 'Only the author or a moderator can delete a message');
    }
    // Deleting twice is a no-op, so a retried request does not re-announce the tombstone.
    if (row.deletedAt) return repo.toMessage(row);

    const message = repo.toMessage(repo.softDelete(row.id));
    hub.broadcast(room, 'chat.message-updated', asJson(message));
    return message;
  });

  handlers.register('chat.react', (ctx, req) => {
    requireWrite(ctx);
    if (req.emoji.trim() === '') throw new AppError('VALIDATION', 'emoji must not be blank');
    const { row, room } = accessibleMessage(ctx, req.messageId);
    if (row.deletedAt) throw new AppError('NOT_FOUND', 'Message was deleted');

    const existing = repo.reactionsFor([row.id]).get(row.id) ?? {};
    if (
      req.on &&
      !(req.emoji in existing) &&
      Object.keys(existing).length >= MAX_EMOJI_PER_MESSAGE
    ) {
      throw new AppError(
        'VALIDATION',
        `A message can have at most ${MAX_EMOJI_PER_MESSAGE} different reactions`,
      );
    }
    if (repo.setReaction(row.id, ctx.user.id, req.emoji, req.on)) {
      hub.broadcast(
        room,
        'chat.reaction',
        asJson({
          conversationId: wireConversationId(row.conversationId),
          messageId: row.id,
          emoji: req.emoji,
          userId: ctx.user.id,
          on: req.on,
        }),
      );
    }
    return { messageId: row.id, reactions: repo.reactionsFor([row.id]).get(row.id) ?? {} };
  });

  handlers.register('chat.conversations', (ctx) => {
    if (!ctx.authorizer.canRead(ctx.user, ctx.appId, 'chat')) {
      throw new AppError('FORBIDDEN', 'Not allowed to read chat messages');
    }
    return { conversations: repo.listConversations(ctx.appId, ctx.user.id) };
  });

  handlers.register('chat.read', (ctx, req) => {
    if (!ctx.authorizer.canRead(ctx.user, ctx.appId, 'chat')) {
      throw new AppError('FORBIDDEN', 'Not allowed to read chat messages');
    }
    ChatRepo.assertConversationId(req.conversationId);
    const { row } = accessibleMessage(ctx, req.messageId);
    if (wireConversationId(row.conversationId) !== req.conversationId) {
      throw new AppError('NOT_FOUND', 'Message does not exist in this conversation');
    }
    const marker = repo.advanceMarker(row.conversationId, ctx.user.id, req.messageId);
    if (marker.advanced) {
      hub.broadcast(
        chatRoom(ctx.appId, req.conversationId),
        'chat.read',
        asJson({
          conversationId: req.conversationId,
          messageId: marker.messageId,
          userId: ctx.user.id,
        }),
      );
    }
    return { conversationId: req.conversationId, messageId: marker.messageId };
  });

  handlers.register('chat.history', (ctx, req) =>
    service.history(ctx.user, ctx.appId, req.conversationId, req),
  );

  return service;
}
