// Admin session cookies: `<base64url JSON payload>.<HMAC-SHA256 signature>`.
// contact-inbox/api issues them after Google sign-in; image-converter/api accepts
// them too, so both services keep an identical copy of this file and share
// SESSION_SECRET.
import { createHmac, timingSafeEqual } from 'crypto';

export interface SessionPayload {
  email: string;
  exp: number;
}

export interface SessionConfig {
  secret: string;
  adminEmails: string[];
}

export const MIN_SECRET_LENGTH = 32;

// Reads and checks the settings. Throws if SESSION_SECRET is shorter than
// MIN_SECRET_LENGTH or ADMIN_EMAILS names no one; the service must not start then.
export function loadSessionConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  const secret = env.SESSION_SECRET || '';
  const adminEmails = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (adminEmails.length === 0) {
    throw new Error('ADMIN_EMAILS must name at least one admin');
  }
  return { secret, adminEmails };
}

let config: SessionConfig | null = null;

// The checked settings, loaded once. Call it at start-up so bad settings stop the
// service before it listens.
export function sessionConfig(): SessionConfig {
  if (!config) config = loadSessionConfig();
  return config;
}

function sign(b64: string, secret: string): string {
  return createHmac('sha256', secret).update(b64).digest('base64url');
}

export function signSession(payload: SessionPayload, secret: string): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64, secret)}`;
}

// The payload if the signature is valid and the session hasn't expired, else null.
export function verifySession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  try {
    const [b64, sig, extra] = token.split('.');
    if (!b64 || !sig || extra !== undefined) return null;

    const expected = Buffer.from(sign(b64, secret));
    const given = Buffer.from(sig);
    // timingSafeEqual requires equal lengths; a length mismatch is a plain failure.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8')) as SessionPayload;
    if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isAdmin(email: string | undefined, adminEmails: string[]): boolean {
  return !!email && adminEmails.includes(email.trim().toLowerCase());
}
