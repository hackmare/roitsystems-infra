// Smoke client for contact-inbox/api, run inside its container by run.sh.
// Start-up gate: /health, the backing services (CouchDB databases, JetStream stream),
// an invalid and a valid contact POST end to end, admin routes refusing without a
// valid admin session, and post-login redirects staying on this site.
import { connect } from '/app/node_modules/nats/index.js';
import { createHmac } from 'crypto';

const API = 'http://localhost:3000';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT || 20) * 1000;
const couchAuth = 'Basic ' + Buffer.from(process.env.COUCH_AUTH).toString('base64');
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(250);
  }
  return null;
};
const couch = (path) => fetch(`${process.env.COUCH_URL}${path}`, { headers: { Authorization: couchAuth } });
const post = (body) => fetch(`${API}/api/contact`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://roitsystems.ca' },
  body: JSON.stringify(body),
});

const health = await until(async () => { const r = await fetch(`${API}/health`); return r.ok && r.json(); });
check(health?.status === 'ok', `GET /health → 200 {status: "ok"}`);

const dbs = await until(async () => (await couch('/contact_messages')).ok && (await couch('/bot_state')).ok);
check(!!dbs, 'CouchDB databases contact_messages and bot_state created');

const nc = await connect({ servers: process.env.NATS_URL });
const jsm = await nc.jetstreamManager();
const stream = await until(() => jsm.streams.info('CONTACT_MESSAGES'));
check(!!stream, 'JetStream stream CONTACT_MESSAGES created');

for (const [what, body] of [
  ['empty body', {}],
  ['bad email', { name: 'Smoke', email: 'not-an-email', subject: 'Smoke', message: 'Smoke test message.' }],
  ['message too short', { name: 'Smoke', email: 'smoke@example.invalid', subject: 'Smoke', message: 'short' }],
]) {
  const r = await post(body);
  check(r.status === 400, `POST /api/contact (${what}) → ${r.status}, expect 400`);
}

const subject = `smoke-${Date.now()}`;
const r = await post({ name: 'Smoke Test', email: 'smoke@example.invalid', subject, message: 'Smoke test message, please ignore.', source_page: 'smoke' });
check(r.status === 200 && (await r.json()).success === true, `POST /api/contact (valid) → ${r.status}, expect 200 {success: true}`);

const doc = await until(async () => {
  const all = await (await couch('/contact_messages/_all_docs?include_docs=true')).json();
  return all.rows.map((x) => x.doc).find((d) => d.subject === subject);
});
check(doc?.status === 'received', 'message stored in CouchDB with status "received"');

const event = await until(async () => {
  const m = await jsm.streams.getMessage('CONTACT_MESSAGES', { last_by_subj: 'contact.messages.new' });
  const e = JSON.parse(new TextDecoder().decode(m.data));
  return e.message_id === doc?._id && e;
});
check(!!event, 'contact.messages.new event published to JetStream with the message id');

const a = await fetch(`${API}/api/admin/messages`, { redirect: 'manual' });
check(a.status >= 300 && a.status < 500 && a.status !== 404, `GET /api/admin/messages without login → ${a.status}, refused`);

// Admin sessions: cookies signed like auth.ts does, with the container's dummy
// SESSION_SECRET (this process shares its environment) or with wrong values.
const cookie = (secret, email, exp = Date.now() + 600_000) => {
  const b64 = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  return `session=${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`;
};
const SECRET = process.env.SESSION_SECRET;
const ADMIN = 'smoke@example.invalid';
const admin = (c) => fetch(`${API}/api/admin/messages`, { redirect: 'manual', headers: { Cookie: c } });
const good = await admin(cookie(SECRET, ADMIN));
check(good.status === 200, `GET /api/admin/messages with a valid admin session → ${good.status}, expect 200`);
for (const [what, c] of [
  ['signed with another secret', cookie('f'.repeat(64), ADMIN)],
  ['signed with an empty secret', cookie('', ADMIN)],
  ['for a non-admin email', cookie(SECRET, 'other@example.invalid')],
  ['for an empty email', cookie(SECRET, '')],
  ['expired', cookie(SECRET, ADMIN, Date.now() - 1000)],
  ['with a truncated signature', cookie(SECRET, ADMIN).slice(0, -1)],
]) {
  const r = await admin(c);
  check(r.status === 403, `GET /api/admin/messages with a session ${what} → ${r.status}, expect 403`);
}

// Post-login redirect: /auth/login stores `next` in a cookie only if it stays on this site.
const storedNext = async (next) => {
  const r = await fetch(`${API}/auth/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
  const c = r.headers.getSetCookie().find((x) => x.startsWith('oauth_next='));
  return c && decodeURIComponent(c.split(';')[0].slice('oauth_next='.length));
};
check(await storedNext('/corporate-network/contact/admin?tab=1') === '/corporate-network/contact/admin?tab=1', 'login keeps a same-site next');
for (const next of ['//evil.example', '/..//evil.example', 'https://evil.example', '/\\evil.example']) {
  const kept = await storedNext(next);
  check(kept === '/corporate-network/contact/admin', `login replaces next=${next} with the admin page (got ${kept})`);
}

// Rate limits count per client (CF-Connecting-IP, IPv6 per /64), not per proxy.
const hit = (path, ip, init = {}) => fetch(`${API}${path}`, { redirect: 'manual', ...init,
  headers: { ...(init.headers || {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) } });
const burst = async (n, path, ip, init) => { const codes = []; for (let i = 0; i < n; i++) codes.push((await hit(path, ip, init)).status); return codes; };
const limited = async (r, what) => {
  const retry = r.headers.get('retry-after');
  check(r.status === 429 && !!retry, `${what} → ${r.status}, expect 429 with Retry-After (${retry})`);
};
{
  const codes = await burst(120, '/api/admin/messages', '203.0.113.10');
  check(!codes.includes(429), `120 admin requests from one client in a minute are allowed (${[...new Set(codes)]})`);
  await limited(await hit('/api/admin/messages', '203.0.113.10'), 'the 121st admin request');
  check((await hit('/api/admin/messages', '203.0.113.11')).status !== 429, 'another client is not affected');
}
{
  const codes = await burst(20, '/auth/login?next=/', '2001:db8:1:2::a');
  check(!codes.includes(429), `20 sign-in requests from one client in a minute are allowed (${[...new Set(codes)]})`);
  await limited(await hit('/auth/login?next=/', '2001:db8:1:2::b'), 'the 21st, from another address in the same IPv6 /64');
  check((await hit('/auth/login?next=/', '2001:db8:1:3::a')).status !== 429, 'a client in another /64 is not affected');
}
{
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await hit('/auth/login?next=/', `junk-${i}`)).status);
  check(codes.includes(429), 'junk CF-Connecting-IP values are ignored (they share one fallback bucket)');
}
{
  const bad = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://roitsystems.ca' }, body: '{}' };
  const codes = await burst(50, '/api/contact', '198.51.100.20', bad);
  check(codes.every((c) => c === 400), `50 contact submissions from one client are allowed (${[...new Set(codes)]})`);
  await limited(await hit('/api/contact', '198.51.100.20', bad), 'the 51st contact submission');
  check((await hit('/api/contact', '198.51.100.21', bad)).status === 400, 'another client can still submit');
}

await nc.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
