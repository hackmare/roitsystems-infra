import { FastifyRequest, FastifyReply } from 'fastify';
import { SessionPayload, isAdmin, sessionConfig, verifySession } from './session';

// Admin sessions are issued by contact-inbox/api's Google sign-in; see session.ts.
// Only the admin page's fetch() calls reach these routes. Without a session they
// get 401, and the page sends the browser to sign-in with its own return path.
// (A redirect here would carry this service's path with Caddy's prefix stripped,
// and fetch() would follow it into the sign-in flow.)
export function requireGoogleAuth(request: FastifyRequest, reply: FastifyReply): SessionPayload | null {
  const sessionCookie = request.cookies.session;
  if (!sessionCookie) {
    reply.status(401).send({ error: 'Sign-in required' });
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
