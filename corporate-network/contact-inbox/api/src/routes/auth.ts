import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { createHmac, randomBytes } from 'crypto';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim());
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const API_DOMAIN = process.env.API_DOMAIN || 'localhost';
const NODE_ENV = process.env.NODE_ENV || 'development';

const oauth2Client = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${NODE_ENV === 'production' ? 'https' : 'http'}://${API_DOMAIN}/auth/callback`,
);

interface SessionPayload {
  email: string;
  exp: number;
}

function signSessionPayload(payload: SessionPayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
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

function isValidRedirect(path: string): boolean {
  return path.startsWith('/');
}

export function requireGoogleAuth(request: FastifyRequest, reply: FastifyReply): SessionPayload | null {
  const sessionCookie = request.cookies.session;
  if (!sessionCookie) {
    const next = encodeURIComponent(request.url);
    reply.redirect(`/auth/login?next=${next}`);
    return null;
  }

  const payload = verifySessionPayload(sessionCookie);
  if (!payload || !ADMIN_EMAILS.includes(payload.email)) {
    reply.status(403).send({ error: 'Access denied' });
    return null;
  }

  return payload;
}

export const authRoutes: FastifyPluginAsync = async (server) => {
  server.get('/login', async (request, reply) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reply.status(503).send({ error: 'OAuth not configured' });
    }

    let next = (request.query as { next?: string }).next || '/corporate-network/contact/admin';
    if (!isValidRedirect(next)) {
      next = '/corporate-network/contact/admin';
    }

    const state = randomBytes(16).toString('hex');
    reply.setCookie('oauth_state', state, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
    });
    reply.setCookie('oauth_next', next, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
    });

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['openid', 'email', 'profile'],
      state,
    });

    return reply.redirect(authUrl);
  });

  server.get('/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    const storedState = request.cookies.oauth_state;
    const next = request.cookies.oauth_next || '/corporate-network/contact/admin';

    if (!code || !state || !storedState || state !== storedState) {
      return reply.status(400).send({ error: 'Invalid OAuth state' });
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token!,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload() as TokenPayload & { email?: string };
      const email = payload.email;

      if (!email || !ADMIN_EMAILS.includes(email)) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const sessionPayload: SessionPayload = {
        email,
        exp: Date.now() + 8 * 60 * 60 * 1000, // 8 hours
      };

      reply.setCookie('session', signSessionPayload(sessionPayload), {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 60 * 60, // 8 hours
      });

      reply.clearCookie('oauth_state');
      reply.clearCookie('oauth_next');

      return reply.redirect(next);
    } catch (err) {
      server.log.error(err, 'OAuth callback error');
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  server.get('/logout', async (request, reply) => {
    reply.clearCookie('session');
    return reply.redirect('/auth/login');
  });
};
