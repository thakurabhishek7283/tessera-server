import { resolve } from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { UploadRes } from '@tessera/protocol';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { imageSize } from 'image-size';
import { z } from 'zod';
import { authenticate } from '../../auth/http.js';
import { uploads } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { createDiskStorage } from './storage.js';
import { uploadUrl } from './url.js';

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

/** True when `mime` matches an allowlist entry such as `image/png` or `image/*`. */
export function isAllowed(mime: string, allowed: string[]): boolean {
  return allowed.some((rule) =>
    rule.endsWith('/*') ? mime.startsWith(rule.slice(0, -1)) : mime === rule,
  );
}

/** `POST /v1/uploads/:appId` and static serving of the stored files under `/uploads/`. */
export const uploadRoutes: FastifyPluginAsync = async (app) => {
  const { env } = app;
  const storage = createDiskStorage(env.uploadDir);

  await app.register(multipart, {
    limits: { fileSize: env.uploadMaxBytes, files: 1, fields: 5, parts: 6 },
  });

  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/uploads/:appId',
    {
      schema: {
        params: z.object({ appId: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
        response: { 201: UploadRes },
        tags: ['uploads'],
        summary: 'Upload one file (multipart field "file")',
      },
    },
    async (req, reply) => {
      const user = await authenticate(app, req);
      const { appId } = req.params;
      if (!app.authorizer.canWrite(user, appId, 'uploads')) {
        throw new AppError('FORBIDDEN', 'Not allowed to upload files');
      }

      if (!req.isMultipart()) {
        throw new AppError('VALIDATION', 'Send the file as multipart/form-data');
      }
      const part = await req.file();
      if (part?.fieldname !== 'file') {
        throw new AppError('VALIDATION', 'Send the file as multipart field "file"');
      }
      const data = await part.toBuffer();
      if (part.file.truncated) {
        throw new AppError('UPLOAD_TOO_LARGE', `File is larger than ${env.uploadMaxBytes} bytes`, {
          maxBytes: env.uploadMaxBytes,
        });
      }

      const mime = part.mimetype;
      if (!isAllowed(mime, env.uploadAllowed)) {
        throw new AppError('VALIDATION', `Files of type "${mime}" are not allowed`, {
          accept: env.uploadAllowed,
        });
      }

      let dimensions: { width: number; height: number } | undefined;
      if (mime.startsWith('image/')) {
        try {
          const { width, height } = imageSize(data);
          if (width && height) dimensions = { width, height };
        } catch {
          throw new AppError('VALIDATION', 'The file is not a readable image');
        }
      }

      const id = app.ids.ulid();
      const path = `${id}.${EXTENSIONS[mime] ?? 'bin'}`;
      await storage.save(path, data);
      app.db.orm
        .insert(uploads)
        .values({
          id,
          appId,
          ownerId: user.id,
          mime,
          size: data.length,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          path,
          createdAt: app.clock.now().toISOString(),
        })
        .run();

      return reply.code(201).send({
        id,
        url: uploadUrl(env.publicUrl, path),
        mime,
        size: data.length,
        ...(dimensions ?? {}),
      });
    },
  );

  await app.register(fastifyStatic, {
    root: resolve(env.uploadDir),
    prefix: '/uploads/',
    index: false,
    dotfiles: 'deny',
    // Names are random and never change, so browsers and CDNs can keep them forever.
    cacheControl: false,
    setHeaders(res, path) {
      res.header('Cache-Control', 'public, max-age=31536000, immutable');
      res.header('X-Content-Type-Options', 'nosniff');
      // Helmet's default would stop the web app (another origin) from embedding images.
      res.header('Cross-Origin-Resource-Policy', 'cross-origin');
      // Only raster images render inline; anything else (PDF…) downloads instead of running in-page.
      if (!/\.(png|jpe?g|webp|gif)$/.test(path)) {
        res.header('Content-Disposition', 'attachment');
      }
    },
  });
};
