// Smoke client for contact-inbox/api, run inside its container by run.sh.
// Start-up gate: /health, the backing services (CouchDB databases, JetStream stream),
// an invalid and a valid contact POST end to end, and admin routes refusing without a login.
import { connect } from '/app/node_modules/nats/index.js';

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

await nc.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
