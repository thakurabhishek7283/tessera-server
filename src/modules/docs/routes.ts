import {
  DocDto,
  DocListQuery,
  DocParams,
  DocPutBody,
  PageDto,
  whereCandidates,
} from '@tessera-kit/protocol';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticate } from '../../auth/http.js';
import type { AuthUser } from '../../auth/verifier.js';
import { AppError } from '../../lib/errors.js';
import { DocsRepo } from './repo.js';

const ItemParams = DocParams.extend({ id: z.string().min(1).max(200) });
const CollectionParams = DocParams.omit({ id: true });
const DeleteRes = z.object({ id: z.string(), version: z.number().int().positive() });

/** Parses `If-Match: 3` or `If-Match: "3"` (ETag style). Absent header means "no precondition". */
function ifMatch(req: FastifyRequest): number | undefined {
  const header = req.headers['if-match'];
  if (header === undefined) return undefined;
  const match = /^"?(\d+)"?$/.exec(header.trim());
  if (!match?.[1]) throw new AppError('VALIDATION', 'If-Match must be a document version');
  return Number(match[1]);
}

/** REST document store under `/v1/docs`. */
export const docsRoutes: FastifyPluginAsync = async (app) => {
  const repo = new DocsRepo(app.db, app.clock);
  const api = app.withTypeProvider<ZodTypeProvider>();

  async function authorize(
    req: FastifyRequest,
    appId: string,
    collection: string,
    mode: 'read' | 'write',
  ): Promise<AuthUser> {
    const user = await authenticate(app, req);
    const allowed =
      mode === 'read'
        ? app.authorizer.canRead(user, appId, collection)
        : app.authorizer.canWrite(user, appId, collection);
    if (!allowed) throw new AppError('FORBIDDEN', `Not allowed to ${mode} "${collection}"`);
    return user;
  }

  const etag = (reply: FastifyReply, version: number): void => {
    void reply.header('etag', `"${version}"`);
  };

  api.get(
    '/v1/docs/:appId/:collection',
    {
      schema: {
        params: CollectionParams,
        querystring: DocListQuery,
        response: { 200: PageDto },
        tags: ['docs'],
        summary: 'List documents in a collection',
      },
    },
    async (req) => {
      const { appId, collection } = req.params;
      await authorize(req, appId, collection, 'read');
      const { where, ...rest } = req.query;
      return repo.list(appId, collection, {
        ...rest,
        where: Object.fromEntries(
          Object.entries(where ?? {}).map(([field, raw]) => [field, whereCandidates(raw)]),
        ),
      });
    },
  );

  api.get(
    '/v1/docs/:appId/:collection/:id',
    {
      schema: {
        params: ItemParams,
        response: { 200: DocDto },
        tags: ['docs'],
        summary: 'Get one document',
      },
    },
    async (req, reply) => {
      const { appId, collection, id } = req.params;
      await authorize(req, appId, collection, 'read');
      const doc = repo.get(appId, collection, id);
      if (!doc) throw new AppError('NOT_FOUND', 'Document does not exist');
      etag(reply, doc.version);
      return doc;
    },
  );

  api.put(
    '/v1/docs/:appId/:collection/:id',
    {
      schema: {
        params: ItemParams,
        body: DocPutBody,
        response: { 200: DocDto },
        tags: ['docs'],
        summary: 'Create or replace a document (optionally guarded by If-Match)',
      },
    },
    async (req, reply) => {
      const { appId, collection, id } = req.params;
      const user = await authorize(req, appId, collection, 'write');
      const doc = repo.put(appId, collection, id, req.body.data, user.id, ifMatch(req));
      app.events.emitDocChanged({
        appId,
        event: { collection, id, version: doc.version, by: user.id },
      });
      etag(reply, doc.version);
      return doc;
    },
  );

  api.delete(
    '/v1/docs/:appId/:collection/:id',
    {
      schema: {
        params: ItemParams,
        response: { 200: DeleteRes },
        tags: ['docs'],
        summary: 'Soft-delete a document (optionally guarded by If-Match)',
      },
    },
    async (req) => {
      const { appId, collection, id } = req.params;
      const user = await authorize(req, appId, collection, 'write');
      const { version } = repo.delete(appId, collection, id, user.id, ifMatch(req));
      app.events.emitDocChanged({
        appId,
        event: { collection, id, version, deleted: true, by: user.id },
      });
      return { id, version };
    },
  );
};
