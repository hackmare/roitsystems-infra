import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { contactRoutes } from './routes/contact';
import { adminRoutes, ADMIN_HTML } from './routes/admin';
import { imageJobsRoutes } from './routes/image-jobs';
import { connectNats, closeNats } from './services/nats';
import { ensureDatabases } from './services/couchdb';
import { initImageJobs } from './services/image-jobs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Redact PII from logs
    redact: {
      paths: ['req.headers.authorization', 'req.body.email', 'req.body.name'],
      remove: false,
    },
  },
  trustProxy: true,
});

async function bootstrap() {
  const corsOrigins = (process.env.CORS_ORIGINS || 'https://roitsystems.ca').split(',').map((o) => o.trim());

  await server.register(cors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await server.register(rateLimit, {
    global: false, // only apply where explicitly added
  });

  // Health check — not rate-limited, not CORS-gated
  server.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Admin SPA — served at /admin, auth handled client-side
  server.get('/admin', async (_request, reply) => reply.type('text/html').send(ADMIN_HTML));

  // Image converter admin page
  let imageConverterHtml = '';
  try {
    imageConverterHtml = readFileSync(resolve(__dirname, 'admin-image-convert.html'), 'utf-8');
  } catch (err) {
    server.log.warn('admin-image-convert.html not found');
  }
  server.get('/admin/image-convert', async (_request, reply) => {
    if (!imageConverterHtml) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.type('text/html').send(imageConverterHtml);
  });

  // Admin SPA and API (rate-limited per IP for POST; no limit on GET admin UI)
  await server.register(adminRoutes, { prefix: '/api/admin' });

  // Image jobs API (rate-limited)
  await server.register(imageJobsRoutes, { prefix: '/api' });

  // Public contact form endpoint — rate-limited
  await server.register(
    async (instance) => {
      await instance.register(rateLimit, {
        max: parseInt(process.env.RATE_LIMIT_MAX || '10'),
        timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
        errorResponseBuilder: () => ({
          error: 'Too many requests. Please wait before submitting again.',
        }),
      });
      await instance.register(contactRoutes);
    },
    { prefix: '/api' },
  );

  // Start listening immediately so healthchecks pass while backing services init
  const port = parseInt(process.env.PORT || '3000');
  await server.listen({ port, host: '0.0.0.0' });

  // Initialise backing services after the server is up
  await ensureDatabases();
  initImageJobs();
  await connectNats();
}

async function shutdown(signal: string) {
  server.log.info(`${signal} received — shutting down`);
  await closeNats();
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
