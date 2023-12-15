import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Generic JSON documents, one row per (app, collection, id). The server never inspects `data`
 * beyond equality filters: kits own their schemas and validate on the client.
 */
export const documents = sqliteTable(
  'documents',
  {
    appId: text('app_id').notNull(),
    collection: text('collection').notNull(),
    id: text('id').notNull(),
    data: text('data').notNull(),
    version: integer('version').notNull(),
    updatedAt: text('updated_at').notNull(),
    updatedBy: text('updated_by'),
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.collection, t.id] }),
    index('documents_collection_updated_idx').on(t.appId, t.collection, t.updatedAt),
  ],
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull(),
  kind: text('kind', { enum: ['room', 'direct'] }).notNull(),
  title: text('title'),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(),
});

/** Membership is only recorded for `direct` conversations; room conversations are open to the app. */
export const conversationMembers = sqliteTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const messages = sqliteTable(
  'messages',
  {
    /** Server-generated ULID, so `ORDER BY id` is chronological and usable as a keyset cursor. */
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    authorId: text('author_id').notNull(),
    authorName: text('author_name').notNull(),
    authorAvatarUrl: text('author_avatar_url'),
    /** JSON `MessageBody`. */
    body: text('body').notNull(),
    /** JSON `Attachment[]`. */
    attachments: text('attachments').notNull().default('[]'),
    replyTo: text('reply_to'),
    createdAt: text('created_at').notNull(),
    editedAt: text('edited_at'),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    // Makes `chat.send` idempotent: a retried send with the same clientId returns the stored row.
    unique('messages_idempotency_key').on(t.conversationId, t.authorId, t.clientId),
    index('messages_conversation_idx').on(t.conversationId, t.id),
  ],
);

export const messageReactions = sqliteTable(
  'message_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export const readMarkers = sqliteTable(
  'read_markers',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    messageId: text('message_id').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull(),
  ownerId: text('owner_id').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  /** File name inside `UPLOAD_DIR` (`<ulid>.<ext>`), never a client-supplied path. */
  path: text('path').notNull(),
  createdAt: text('created_at').notNull(),
});
