import type { Authorizer, AuthUser } from '../../auth/index.js';
import { AppError } from '../../lib/errors.js';
import { ChatRepo, isDirectId } from './repo.js';

/** Access-controlled chat reads shared by the websocket handlers and the REST mirror. */
export class ChatService {
  constructor(
    readonly repo: ChatRepo,
    private readonly authorizer: Authorizer,
  ) {}

  /**
   * Message history. Unknown room conversations are simply empty (nothing is created on a read),
   * while direct conversations must exist and include the caller.
   */
  history(
    user: AuthUser,
    appId: string,
    conversationId: string,
    opts: { before?: string | undefined; after?: string | undefined; limit: number },
  ) {
    ChatRepo.assertConversationId(conversationId);
    if (!this.authorizer.canRead(user, appId, 'chat')) {
      throw new AppError('FORBIDDEN', 'Not allowed to read chat messages');
    }
    if (isDirectId(conversationId) && !this.repo.isMember(appId, conversationId, user.id)) {
      throw new AppError('NOT_FOUND', 'Conversation does not exist');
    }
    const conversation = this.repo.getConversation(appId, conversationId);
    if (!conversation) return { messages: [], hasMore: false };
    return this.repo.history(conversation.id, opts);
  }
}
