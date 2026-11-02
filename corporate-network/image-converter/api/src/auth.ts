import { FastifyRequest, FastifyReply } from 'fastify';
import { SessionPayload, isAdmin, sessionConfig, verifySession } from './session';

// Admin sessions are issued by contact-inbox/api's Google sign-in; see session.ts.
export function requireGoogleAuth(request: FastifyRequest, reply: FastifyReply): SessionPayload | null {
  const sessionCookie = request.cookies.session;
  if (!sessionCookie) {
    const next = encodeURIComponent(request.url);
    reply.redirect(`/auth/login?next=${next}`);
    return null;
  }

  const { secret, adminEmails } = sessionConfig();
  const payload = verifySession(sessionCookie, secret);
  if (!payload || !isAdmin(payload.email, adminEmails)) {
    reply.status(403).send({ error: 'Access denied' });
    return null;
  }

  return payload;
}
