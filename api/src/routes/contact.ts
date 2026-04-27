import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { saveMessage } from '../services/couchdb';
import { publishContactMessage } from '../services/nats';
import { ContactMessage } from '../types';

const contactSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().max(200).trim(),
  company: z.string().max(200).trim().optional(),
  subject: z.string().min(1).max(300).trim(),
  message: z.string().min(10).max(5000).trim(),
  budget: z.string().max(100).trim().optional(),
  timeline: z.string().max(200).trim().optional(),
  source_page: z.string().max(200).trim().optional(),
  timestamp: z.string().datetime().optional(),
  consent: z.boolean().optional(),
  // honeypot — must be absent or empty; bots fill this in
  hp: z.string().max(0).optional(),
});

export const contactRoutes: FastifyPluginAsync = async (server) => {
  server.post('/contact', async (request, reply) => {
    const result = contactSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Invalid request. Please check your input.' });
    }

    const data = result.data;

    // Honeypot triggered — silently accept to avoid fingerprinting bots
    if (data.hp) {
      return reply.status(200).send({ success: true });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const message: ContactMessage = {
      _id: id,
      type: 'contact_message',
      name: data.name,
      email: data.email,
      company: data.company,
      subject: data.subject,
      message: data.message,
      budget: data.budget,
      timeline: data.timeline,
      source_page: data.source_page,
      timestamp: data.timestamp || now,
      consent: data.consent,
      status: 'received',
      created_at: now,
      updated_at: now,
    };

    await saveMessage(message);
    await publishContactMessage(id);

    // Log without PII — just ID and status
    request.log.info({ msg_id: id, status: 'received' }, 'contact message stored');

    return reply.status(200).send({ success: true });
  });
};
