import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { contactRoutes } from './routes/contact';
import { adminRoutes } from './routes/admin';
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

  // Health check — not rate-limited, not CORS-gated
  server.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

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

  // Initialise storage and messaging before accepting traffic
  await ensureDatabases();
  await connectNats();

  const port = parseInt(process.env.PORT || '3000');
  await server.listen({ port, host: '0.0.0.0' });
}

process.on('SIGTERM', async () => {
  await closeNats();
  await server.close();
  process.exit(0);
});

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
