import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  createImageJob,
  publishImageConvertJob,
  getImageJob,
} from '../services/image-jobs';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const HMAC_KEY = randomBytes(32);

function hmac(value: string): Buffer {
  return createHmac('sha256', HMAC_KEY).update(value).digest();
}

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!ADMIN_TOKEN) {
    reply.status(503).send({ error: 'Admin access not configured' });
    return false;
  }

  const match = timingSafeEqual(hmac(provided), hmac(ADMIN_TOKEN));
  if (!match) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

const submitJobSchema = z.object({
  filename: z.string().min(1).max(255),
  format_in: z.string().min(1).max(10),
  format_out: z.string().min(1).max(10),
  quality: z.number().int().min(1).max(100).optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  lockAspectRatio: z.boolean().optional(),
  rotate: z.number().int().min(0).max(359).optional(),
  trim: z.boolean().optional(),
  colorspace: z.string().max(50).optional(),
  background: z.string().regex(/^#?[0-9a-f]{6}$/i).optional(),
  flatten: z.boolean().optional(),
  density: z.number().int().min(1).max(600).optional(),
  blur: z.number().min(0).max(10).optional(),
  sharpen: z.number().min(0).max(10).optional(),
});

const adminRateLimit = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many requests. Try again later.' }),
    },
  },
};

export const imageJobsRoutes: FastifyPluginAsync = async (server) => {
  server.post('/admin/image-jobs', adminRateLimit, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const result = submitJobSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Invalid request' });
    }

    const data = result.data;

    try {
      const job = await createImageJob(data.filename, {
        format_in: data.format_in,
        format_out: data.format_out,
        quality: data.quality,
        width: data.width,
        height: data.height,
        lockAspectRatio: data.lockAspectRatio,
        rotate: data.rotate,
        trim: data.trim,
        colorspace: data.colorspace,
        background: data.background,
        flatten: data.flatten,
        density: data.density,
        blur: data.blur,
        sharpen: data.sharpen,
      });

      await publishImageConvertJob(job.transaction_id);

      request.log.info(
        { transaction_id: job.transaction_id, filename: data.filename },
        'image job submitted'
      );

      return reply.status(202).send({
        transaction_id: job.transaction_id,
        status: 'queued',
      });
    } catch (err) {
      request.log.error(err, 'failed to submit image job');
      return reply.status(500).send({ error: 'Failed to submit job' });
    }
  });

  server.get('/admin/image-jobs/:transaction_id', adminRateLimit, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const { transaction_id } = request.params as { transaction_id: string };

    try {
      const job = await getImageJob(transaction_id);

      if (!job) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      return reply.status(200).send({
        transaction_id: job.transaction_id,
        filename: job.filename,
        status: job.status,
        data: job.data,
        error: job.error,
        created_at: job.created_at,
        updated_at: job.updated_at,
      });
    } catch (err) {
      request.log.error(err, 'failed to fetch image job');
      return reply.status(500).send({ error: 'Failed to fetch job' });
    }
  });
};
