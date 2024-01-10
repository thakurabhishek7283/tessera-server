import { afterEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/client.js';
import { AppEvents } from '../src/lib/events.js';
import { parseQuery } from '../src/lib/query.js';
import { DocsRepo } from '../src/modules/docs/repo.js';

let db: Db;
let tick = 0;
const clock = { now: () => new Date(Date.UTC(2023, 0, 1, 0, 0, tick++)) };
const setup = () => {
  db = openDatabase(':memory:');
  return new DocsRepo(db, clock);
};
afterEach(() => db.close());

const list = (repo: DocsRepo, over: Partial<Parameters<DocsRepo['list']>[2]> = {}) =>
  repo.list('app', 'cards', { dir: 'asc', limit: 50, ...over });

describe('DocsRepo versions', () => {
  it('creates at version 1 and increments on every write', () => {
    const repo = setup();
    const first = repo.put('app', 'cards', 'c1', { title: 'a' }, 'u1');
    expect(first).toMatchObject({ id: 'c1', version: 1, updatedBy: 'u1', data: { title: 'a' } });
    const second = repo.put('app', 'cards', 'c1', { title: 'b' }, 'u2');
    expect(second.version).toBe(2);
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(repo.get('app', 'cards', 'c1')).toEqual(second);
  });

  it('accepts a matching If-Match and rejects a stale one with the current copy', () => {
    const repo = setup();
    repo.put('app', 'cards', 'c1', { n: 1 }, 'u1');
    expect(repo.put('app', 'cards', 'c1', { n: 2 }, 'u1', 1).version).toBe(2);
    expect.assertions(4);
    try {
      repo.put('app', 'cards', 'c1', { n: 3 }, 'u1', 1);
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONFLICT', current: { version: 2, data: { n: 2 } } });
    }
    expect(repo.get('app', 'cards', 'c1')?.data).toEqual({ n: 2 });
    expect(repo.put('app', 'cards', 'c1', { n: 4 }, 'u1', 2).version).toBe(3);
  });

  it('treats If-Match: 0 as create-only', () => {
    const repo = setup();
    expect(repo.put('app', 'cards', 'c1', {}, 'u', 0).version).toBe(1);
    expect(() => repo.put('app', 'cards', 'c1', {}, 'u', 0)).toThrow(/modified/);
  });

  it('answers NOT_FOUND for a versioned write to a missing document', () => {
    const repo = setup();
    expect(() => repo.put('app', 'cards', 'nope', {}, 'u', 3)).toThrow(/does not exist/);
  });

  it('soft-deletes, hides the document and never reuses a version', () => {
    const repo = setup();
    repo.put('app', 'cards', 'c1', { n: 1 }, 'u');
    expect(repo.delete('app', 'cards', 'c1', 'u')).toEqual({ version: 2 });
    expect(repo.get('app', 'cards', 'c1')).toBeNull();
    expect(list(repo).items).toEqual([]);
    expect(() => repo.delete('app', 'cards', 'c1', 'u')).toThrow(/does not exist/);
    expect(repo.put('app', 'cards', 'c1', { n: 2 }, 'u').version).toBe(3);
    expect(repo.get('app', 'cards', 'c1')?.data).toEqual({ n: 2 });
  });

  it('checks If-Match on delete', () => {
    const repo = setup();
    repo.put('app', 'cards', 'c1', {}, 'u');
    expect(() => repo.delete('app', 'cards', 'c1', 'u', 5)).toThrow(/modified/);
    expect(repo.get('app', 'cards', 'c1')).not.toBeNull();
    expect(repo.delete('app', 'cards', 'c1', 'u', 1).version).toBe(2);
  });

  it('isolates apps and collections', () => {
    const repo = setup();
    repo.put('app', 'cards', 'x', { v: 1 }, 'u');
    repo.put('other', 'cards', 'x', { v: 2 }, 'u');
    repo.put('app', 'columns', 'x', { v: 3 }, 'u');
    expect(repo.get('app', 'cards', 'x')?.data).toEqual({ v: 1 });
    expect(repo.get('other', 'cards', 'x')?.data).toEqual({ v: 2 });
    expect(repo.get('app', 'columns', 'x')?.data).toEqual({ v: 3 });
  });

  it('stores any JSON value, not just objects', () => {
    const repo = setup();
    repo.put('app', 'cards', 'arr', [1, { a: null }], 'u');
    expect(repo.get('app', 'cards', 'arr')?.data).toEqual([1, { a: null }]);
  });
});

describe('DocsRepo.list', () => {
  const seed = (repo: DocsRepo) => {
    repo.put('app', 'cards', 'a', { status: 'open', rank: 3, done: false, owner: null }, 'u');
    repo.put('app', 'cards', 'b', { status: 'open', rank: 1, done: true, owner: 'ada' }, 'u');
    repo.put('app', 'cards', 'c', { status: 'closed', rank: 2, done: true }, 'u');
  };
  const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

  it('orders by id by default, either direction', () => {
    const repo = setup();
    seed(repo);
    expect(ids(list(repo))).toEqual(['a', 'b', 'c']);
    expect(ids(list(repo, { dir: 'desc' }))).toEqual(['c', 'b', 'a']);
  });

  it('orders by a data field', () => {
    const repo = setup();
    seed(repo);
    expect(ids(list(repo, { orderBy: 'rank' }))).toEqual(['b', 'c', 'a']);
    expect(ids(list(repo, { orderBy: 'rank', dir: 'desc' }))).toEqual(['a', 'c', 'b']);
  });

  it('filters by string, number and boolean equality', () => {
    const repo = setup();
    seed(repo);
    expect(ids(list(repo, { where: { status: ['open'] } }))).toEqual(['a', 'b']);
    expect(ids(list(repo, { where: { rank: ['2', 2] } }))).toEqual(['c']);
    expect(ids(list(repo, { where: { done: ['true', true] } }))).toEqual(['b', 'c']);
    expect(ids(list(repo, { where: { status: ['open'], done: ['true', true] } }))).toEqual(['b']);
  });

  it('matches null against JSON null and absent fields', () => {
    const repo = setup();
    seed(repo);
    expect(ids(list(repo, { where: { owner: ['null', null] } }))).toEqual(['a', 'c']);
  });

  it('pages with an opaque cursor until exhausted', () => {
    const repo = setup();
    for (let i = 0; i < 5; i++) repo.put('app', 'cards', `c${i}`, {}, 'u');
    const p1 = list(repo, { limit: 2 });
    expect(ids(p1)).toEqual(['c0', 'c1']);
    const p2 = list(repo, { limit: 2, cursor: p1.nextCursor });
    expect(ids(p2)).toEqual(['c2', 'c3']);
    const p3 = list(repo, { limit: 2, cursor: p2.nextCursor });
    expect(ids(p3)).toEqual(['c4']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('rejects unsafe field names and bad cursors', () => {
    const repo = setup();
    expect(() => list(repo, { where: { "x') OR 1=1 --": ['1'] } })).toThrow(/Invalid field/);
    expect(() => list(repo, { orderBy: 'a.b' })).toThrow(/Invalid field/);
    expect(() => list(repo, { cursor: '???' })).toThrow(/Invalid cursor/);
  });
});

describe('parseQuery', () => {
  it('nests bracketed keys and keeps plain ones', () => {
    expect(parseQuery('where[status]=open&where[rank]=2&limit=10&dir=desc')).toEqual({
      where: { status: 'open', rank: '2' },
      limit: '10',
      dir: 'desc',
    });
  });

  it('decodes percent-encoding and survives a __proto__ field', () => {
    const parsed = parseQuery('where[__proto__]=x&where[a%20b]=1') as {
      where: Record<string, string>;
    };
    expect(Object.keys(parsed.where)).toContain('__proto__');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('AppEvents', () => {
  it('delivers doc changes and supports unsubscribe', () => {
    const events = new AppEvents();
    const seen: string[] = [];
    const off = events.onDocChanged((c) => seen.push(c.event.id));
    const change = { appId: 'a', event: { collection: 'c', id: '1', version: 1 } };
    events.emitDocChanged(change);
    off();
    events.emitDocChanged(change);
    expect(seen).toEqual(['1']);
  });
});
