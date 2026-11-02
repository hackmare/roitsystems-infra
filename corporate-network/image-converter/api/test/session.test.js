// Unit tests for src/session.ts (run against the build: npm run build && npm test).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSessionConfig, signSession, verifySession, isAdmin, MIN_SECRET_LENGTH } = require('../dist/session');

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);
const env = (o) => ({ SESSION_SECRET: SECRET, ADMIN_EMAILS: 'admin@example.invalid', ...o });
const future = () => Date.now() + 60_000;

test('settings: SESSION_SECRET shorter than the minimum is refused', () => {
  for (const s of [undefined, '', 'short', 'a'.repeat(MIN_SECRET_LENGTH - 1)]) {
    assert.throws(() => loadSessionConfig(env({ SESSION_SECRET: s })), /SESSION_SECRET/);
  }
});

test('settings: ADMIN_EMAILS that names no one is refused', () => {
  for (const a of [undefined, '', ' ', ',', ' , ,']) {
    assert.throws(() => loadSessionConfig(env({ ADMIN_EMAILS: a })), /ADMIN_EMAILS/);
  }
});

test('settings: admin emails are trimmed, lower-cased, and empty entries dropped', () => {
  const c = loadSessionConfig(env({ ADMIN_EMAILS: ' A@Example.invalid, ,b@example.invalid,' }));
  assert.deepEqual(c.adminEmails, ['a@example.invalid', 'b@example.invalid']);
  assert.equal(c.secret, SECRET);
});

test('a signed session verifies', () => {
  const p = { email: 'admin@example.invalid', exp: future() };
  assert.deepEqual(verifySession(signSession(p, SECRET), SECRET), p);
});

test('a session signed with another secret is refused', () => {
  const t = signSession({ email: 'admin@example.invalid', exp: future() }, 'b'.repeat(MIN_SECRET_LENGTH));
  assert.equal(verifySession(t, SECRET), null);
});

test('a session with an empty-secret signature is refused', () => {
  const t = signSession({ email: 'admin@example.invalid', exp: future() }, '');
  assert.equal(verifySession(t, SECRET), null);
});

test('a signature of a different length, or a changed payload, is refused', () => {
  const t = signSession({ email: 'admin@example.invalid', exp: future() }, SECRET);
  const [b64, sig] = t.split('.');
  for (const bad of [`${b64}.${sig.slice(0, -1)}`, `${b64}.${sig}A`, `${b64}.`, `${b64}.x`, `${b64}`,
    `${Buffer.from(JSON.stringify({ email: 'other@example.invalid', exp: future() })).toString('base64url')}.${sig}`,
    `${t}.extra`, '', '.', 'not a token']) {
    assert.equal(verifySession(bad, SECRET), null, bad);
  }
});

test('an expired session is refused', () => {
  const t = signSession({ email: 'admin@example.invalid', exp: Date.now() - 1 }, SECRET);
  assert.equal(verifySession(t, SECRET), null);
});

test('a signed payload without a string email and numeric expiry is refused', () => {
  for (const p of [{ email: 1, exp: future() }, { email: 'a@example.invalid' }, { email: 'a@example.invalid', exp: String(future()) }]) {
    const b64 = Buffer.from(JSON.stringify(p)).toString('base64url');
    const sig = require('crypto').createHmac('sha256', SECRET).update(b64).digest('base64url');
    assert.equal(verifySession(`${b64}.${sig}`, SECRET), null, JSON.stringify(p));
  }
});

test('an empty or unlisted email is never an admin', () => {
  const { adminEmails } = loadSessionConfig(env({ ADMIN_EMAILS: 'admin@example.invalid,' }));
  assert.equal(isAdmin('', adminEmails), false);
  assert.equal(isAdmin(undefined, adminEmails), false);
  assert.equal(isAdmin(' ', adminEmails), false);
  assert.equal(isAdmin('other@example.invalid', adminEmails), false);
  assert.equal(isAdmin('Admin@Example.invalid', adminEmails), true);
});
