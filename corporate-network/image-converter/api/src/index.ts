import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { imageJobsRoutes } from './routes/image-jobs';
import { connectNats, closeNats, getImageReadyConsumer, sc } from './services/nats';
import { ensureDatabases, updateImageJobStatus } from './services/image-jobs';
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
  bodyLimit: 50 * 1024 * 1024,
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

  setTimeout(async () => {
    try {
      server.log.info('Starting image.ready listener');
      const consumer = await getImageReadyConsumer();
      server.log.info('Got image.ready consumer, starting to consume messages');
      const messages = await consumer.consume();

      for await (const msg of messages) {
        try {
          const event = JSON.parse(sc.decode(msg.data));
          server.log.debug({ event }, 'Received image.ready message');
          if (event.success && event.transaction_id) {
            await updateImageJobStatus(event.transaction_id, 'done', event.data);
            server.log.info({ transaction_id: event.transaction_id }, 'image conversion completed');
          } else if (!event.success && event.transaction_id) {
            await updateImageJobStatus(event.transaction_id, 'error', undefined, event.error);
            server.log.error({ transaction_id: event.transaction_id, error: event.error }, 'image conversion failed');
          }
          msg.ack();
        } catch (err) {
          server.log.error(err, 'Failed to handle image.ready message');
        }
      }
    } catch (err) {
      server.log.error(err, 'Failed to start image.ready listener');
    }
  }, 1000);
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
