import type { AttachmentDto, MessageBodyDto } from '@tessera/protocol';
import { and, eq } from 'drizzle-orm';
import { uploads } from '../../db/schema.js';
import type { Env } from '../../env.js';
import type { HandlerContext } from '../../hub/handlers.js';
import type { Hub } from '../../hub/hub.js';
import { AppError } from '../../lib/errors.js';
import { asJson, jsonBytes } from '../../lib/json.js';
import { uploadUrl } from '../uploads/url.js';
import { ChatRepo, chatRoom, isDirectId } from './repo.js';

/** Rich message bodies are stored opaquely, so cap their serialised size. */
const MAX_RICH_BYTES = 32 * 1024;

/** Registers the `chat.*` request handlers on the hub. */
export function registerChatHandlers(hub: Hub, env: Env): ChatRepo {
  const repo = new ChatRepo(hub.deps.db, hub.deps.clock, hub.deps.ids);
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

  return repo;
}
