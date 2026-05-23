import { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac } from 'crypto';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim());
const SESSION_SECRET = process.env.SESSION_SECRET || '';

interface SessionPayload {
  email: string;
  exp: number;
}

function verifySessionPayload(token: string): SessionPayload | null {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;

    const expectedSig = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (sig !== expectedSig) return null;

    const json = Buffer.from(b64, 'base64url').toString('utf-8');
    const payload = JSON.parse(json) as SessionPayload;

    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function requireGoogleAuth(request: FastifyRequest, reply: FastifyReply): SessionPayload | null {
  const sessionCookie = request.cookies.session;
  if (!sessionCookie) {
    reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }

  const payload = verifySessionPayload(sessionCookie);
  if (!payload || !ADMIN_EMAILS.includes(payload.email)) {
    reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }

  return payload;
}
