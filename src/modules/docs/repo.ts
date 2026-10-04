import type { JsonValue } from '@tessera-kit/protocol';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { documents } from '../../db/schema.js';
import { AppError, ConflictError } from '../../lib/errors.js';
import type { Clock } from '../../lib/ids.js';
import { decodeCursor, encodeCursor, jsonPath, parseStored } from '../../lib/json.js';

/** A document as returned by the API (`DocDto`). */
export interface StoredDoc {
  id: string;
  data: JsonValue;
  version: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface ListOptions {
  /** Raw `where[field]=value` filters; each value may stand for several typed candidates. */
  where?: Record<string, WhereCandidates>;
  orderBy?: string | undefined;
  dir: 'asc' | 'desc';
  limit: number;
  cursor?: string | undefined;
}

/** Typed values a raw query-string value may mean (`"1"` → `"1"` or `1`). */
export type WhereCandidates = Array<string | number | boolean | null>;

type Row = typeof documents.$inferSelect;

function toDoc(row: Row): StoredDoc {
  return {
    id: row.id,
    data: parseStored(row.data),
    version: row.version,
    updatedAt: row.updatedAt,
    ...(row.updatedBy === null ? {} : { updatedBy: row.updatedBy }),
  };
}

/** SQLite has no booleans: `json_extract` yields 1/0 for JSON true/false. */
const bindable = (v: string | number | boolean): string | number =>
  typeof v === 'boolean' ? (v ? 1 : 0) : v;

/** `json_extract(data, '$.field') IN (…)`, with `null` meaning "missing or JSON null". */
function whereClause(field: string, candidates: WhereCandidates): SQL {
  const extracted = sql`json_extract(${documents.data}, ${jsonPath(field)})`;
  const values = candidates.filter((c): c is string | number | boolean => c !== null);
  const parts: SQL[] = [];
  if (values.length > 0) {
    parts.push(
      sql`${extracted} IN (${sql.join(
        values.map((v) => sql`${bindable(v)}`),
        sql`, `,
      )})`,
    );
  }
  if (candidates.includes(null)) parts.push(sql`${extracted} IS NULL`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** Versioned JSON document storage. All mutations are single transactions. */
export class DocsRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** The live document, or null when it never existed or was deleted. */
  get(appId: string, collection: string, id: string): StoredDoc | null {
    const row = this.row(appId, collection, id);
    return row && !row.deleted ? toDoc(row) : null;
  }

  list(
    appId: string,
    collection: string,
    opts: ListOptions,
  ): { items: StoredDoc[]; nextCursor?: string } {
    const conditions: SQL[] = [
      eq(documents.appId, appId),
      eq(documents.collection, collection),
      eq(documents.deleted, false),
    ];
    for (const [field, candidates] of Object.entries(opts.where ?? {})) {
      conditions.push(whereClause(field, candidates));
    }

    const direction = opts.dir === 'desc' ? desc : asc;
    const order = opts.orderBy
      ? [
          direction(sql`json_extract(${documents.data}, ${jsonPath(opts.orderBy)})`),
          asc(documents.id),
        ]
      : [direction(documents.id)];

    // Offset cursors are stable enough for kit UIs and keep the cursor opaque and tiny.
    const offset = decodeCursor(opts.cursor);
    const rows = this.db.orm
      .select()
      .from(documents)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(opts.limit + 1)
      .offset(offset)
      .all();

    const items = rows.slice(0, opts.limit).map(toDoc);
    return rows.length > opts.limit
      ? { items, nextCursor: encodeCursor(offset + opts.limit) }
      : { items };
  }

  /**
   * Creates or replaces a document. `ifMatch` is the version the caller last saw: `0` means
   * "only create"; any other value must equal the stored version or the write is a CONFLICT.
   */
  put(
    appId: string,
    collection: string,
    id: string,
    data: JsonValue,
    userId: string,
    ifMatch?: number,
  ): StoredDoc {
    return this.db.orm.transaction((tx) => {
      const existing = tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.appId, appId),
            eq(documents.collection, collection),
            eq(documents.id, id),
          ),
        )
        .get();
      const live = existing && !existing.deleted ? existing : undefined;

      if (ifMatch !== undefined) {
        if (!live && ifMatch !== 0) throw new AppError('NOT_FOUND', 'Document does not exist');
        if (live && live.version !== ifMatch) throw conflict(live);
      }

      // Tombstones keep their version so a re-created document never reuses an old one.
      const version = (existing?.version ?? 0) + 1;
      const row: Row = {
        appId,
        collection,
        id,
        data: JSON.stringify(data),
        version,
        updatedAt: this.clock.now().toISOString(),
        updatedBy: userId,
        deleted: false,
      };
      tx.insert(documents)
        .values(row)
        .onConflictDoUpdate({
          target: [documents.appId, documents.collection, documents.id],
          set: {
            data: row.data,
            version,
            updatedAt: row.updatedAt,
            updatedBy: userId,
            deleted: false,
          },
        })
        .run();
      return toDoc(row);
    });
  }

  /** Soft-deletes a document and returns the tombstone version. */
  delete(
    appId: string,
    collection: string,
    id: string,
    userId: string,
    ifMatch?: number,
  ): { version: number } {
    return this.db.orm.transaction((tx) => {
      const existing = tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.appId, appId),
            eq(documents.collection, collection),
            eq(documents.id, id),
          ),
        )
        .get();
      if (!existing || existing.deleted) throw new AppError('NOT_FOUND', 'Document does not exist');
      if (ifMatch !== undefined && existing.version !== ifMatch) throw conflict(existing);

      const version = existing.version + 1;
      tx.update(documents)
        .set({
          deleted: true,
          version,
          updatedAt: this.clock.now().toISOString(),
          updatedBy: userId,
        })
        .where(
          and(
            eq(documents.appId, appId),
            eq(documents.collection, collection),
            eq(documents.id, id),
          ),
        )
        .run();
      return { version };
    });
  }

  private row(appId: string, collection: string, id: string): Row | undefined {
    return this.db.orm
      .select()
      .from(documents)
      .where(
        and(eq(documents.appId, appId), eq(documents.collection, collection), eq(documents.id, id)),
      )
      .get();
  }
}

/** A 409 carrying the server's copy so the client can rebase without another round trip. */
function conflict(current: Row): ConflictError {
  return new ConflictError('Document was modified by someone else', toDoc(current));
}
