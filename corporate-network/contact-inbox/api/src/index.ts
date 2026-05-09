import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { contactRoutes } from './routes/contact';
import { adminRoutes, ADMIN_HTML } from './routes/admin';
import { connectNats, closeNats } from './services/nats';
import { ensureDatabases } from './services/couchdb';

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

  // Load dashboard HTML
  let dashboardHtml = '';
  try {
    dashboardHtml = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf-8');
  } catch (err) {
    server.log.warn('dashboard.html not found');
  }

  // Health check — not rate-limited, not CORS-gated
  server.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Corporate Network Dashboard
  server.get('/', async (_request, reply) => reply.type('text/html').send(dashboardHtml));

  // Admin SPA — served at /admin, auth handled client-side
  server.get('/admin', async (_request, reply) => reply.type('text/html').send(ADMIN_HTML));

  // Admin SPA and API (rate-limited per IP for POST; no limit on GET admin UI)
  await server.register(adminRoutes, { prefix: '/api/admin' });

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
