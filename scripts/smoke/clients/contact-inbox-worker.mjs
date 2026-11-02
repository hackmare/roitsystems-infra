// Smoke client for contact-inbox/worker, run inside its container by run.sh.
// Checks that the worker attaches its consumer, discards an unparseable event, and
// marks a received contact message "processed" in CouchDB.
import { connect, StringCodec } from '/app/node_modules/nats/index.js';

const timeoutMs = Number(process.env.SMOKE_TIMEOUT || 20) * 1000;
const couchAuth = 'Basic ' + Buffer.from(process.env.COUCH_AUTH).toString('base64');
const sc = StringCodec();
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
const couch = (path, init = {}) => fetch(`${process.env.COUCH_URL}${path}`,
  { ...init, headers: { Authorization: couchAuth, 'Content-Type': 'application/json' } });

const nc = await connect({ servers: process.env.NATS_URL });
const jsm = await nc.jetstreamManager();
check(!!(await until(() => jsm.consumers.info('CONTACT_MESSAGES', 'worker'))), 'durable consumer "worker" attached to CONTACT_MESSAGES');

// The API normally creates the database and the document.
await couch('/contact_messages', { method: 'PUT' });
const id = `smoke-${Date.now()}`;
const now = new Date().toISOString();
const put = await couch(`/contact_messages/${id}`, { method: 'PUT', body: JSON.stringify({
  _id: id, type: 'contact_message', name: 'Smoke', email: 'smoke@example.invalid', subject: 'Smoke',
  message: 'Smoke test message.', status: 'received', created_at: now, updated_at: now }) });
check(put.ok, 'test message stored in CouchDB as "received"');

const js = nc.jetstream();
await js.publish('contact.messages.new', sc.encode('not json'));
await js.publish('contact.messages.new', sc.encode(JSON.stringify({ type: 'contact.new', message_id: id, timestamp: now })));

const doc = await until(async () => { const d = await (await couch(`/contact_messages/${id}`)).json(); return d.status === 'processed' && d; });
check(!!doc, 'contact.messages.new → message marked "processed" (after an unparseable event was skipped)');

const info = await until(async () => { const c = await jsm.consumers.info('CONTACT_MESSAGES', 'worker'); return c.num_ack_pending === 0 && c.num_pending === 0 && c; });
check(!!info, 'both events acknowledged, nothing pending');

await nc.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
