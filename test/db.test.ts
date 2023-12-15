import { afterEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/client.js';
import { conversations, documents, messages } from '../src/db/schema.js';

describe('database', () => {
  let db: Db;
  afterEach(() => db.close());

  it('applies migrations and creates every table', () => {
    db = openDatabase(':memory:');
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%drizzle%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      'conversation_members',
      'conversations',
      'documents',
      'message_reactions',
      'messages',
      'read_markers',
      'uploads',
    ]);
  });

  it('enforces foreign keys', () => {
    db = openDatabase(':memory:');
    expect(() =>
      db.orm
        .insert(messages)
        .values({
          id: 'm1',
          appId: 'a',
          conversationId: 'missing',
          clientId: 'c',
          authorId: 'u',
          authorName: 'U',
          body: '{}',
          createdAt: 'now',
        })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects a duplicate (conversation, author, clientId)', () => {
    db = openDatabase(':memory:');
    db.orm
      .insert(conversations)
      .values({ id: 'c1', appId: 'a', kind: 'room', createdAt: 't', createdBy: 'u' })
      .run();
    const row = {
      appId: 'a',
      conversationId: 'c1',
      clientId: 'cid',
      authorId: 'u',
      authorName: 'U',
      body: '{}',
      createdAt: 't',
    };
    db.orm
      .insert(messages)
      .values({ ...row, id: 'm1' })
      .run();
    expect(() =>
      db.orm
        .insert(messages)
        .values({ ...row, id: 'm2' })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('keys documents by (app, collection, id)', () => {
    db = openDatabase(':memory:');
    const doc = { data: '{}', version: 1, updatedAt: 't' };
    db.orm
      .insert(documents)
      .values({ appId: 'a', collection: 'c', id: '1', ...doc })
      .run();
    db.orm
      .insert(documents)
      .values({ appId: 'b', collection: 'c', id: '1', ...doc })
      .run();
    expect(() =>
      db.orm
        .insert(documents)
        .values({ appId: 'a', collection: 'c', id: '1', ...doc })
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it('is idempotent when opened twice on the same file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'tessera-db-'));
    try {
      openDatabase(join(dir, 'nested', 't.db')).close();
      db = openDatabase(join(dir, 'nested', 't.db'));
      expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
