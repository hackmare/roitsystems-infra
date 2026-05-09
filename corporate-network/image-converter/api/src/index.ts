import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { imageJobsRoutes } from './routes/image-jobs';
import { connectNats, closeNats } from './services/nats';
import { ensureDatabases } from './services/image-jobs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: ['req.headers.authorization'],
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
    global: false,
  });

  server.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Image converter admin page
  let imageConverterHtml = '';
  try {
    imageConverterHtml = readFileSync(resolve(__dirname, 'admin-image-convert.html'), 'utf-8');
  } catch (err) {
    server.log.warn('admin-image-convert.html not found');
  }
  server.get('/convert', async (_request, reply) => {
    if (!imageConverterHtml) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.type('text/html').send(imageConverterHtml);
  });

  // Image jobs API (rate-limited)
  await server.register(imageJobsRoutes, { prefix: '/api' });

  const port = parseInt(process.env.PORT || '3000');
  await server.listen({ port, host: '0.0.0.0' });

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
