// Smoke client for image-converter/api, run inside its container by run.sh.
// Start-up gate: /health, the admin page, the backing services (CouchDB database,
// JetStream stream and consumer), job routes refusing without a login, and the
// image.ready listener updating jobs in CouchDB.
import { connect, StringCodec } from '/app/node_modules/nats/index.js';

const API = 'http://localhost:3000';
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

const health = await until(async () => { const r = await fetch(`${API}/health`); return r.ok && r.json(); });
check(health?.status === 'ok', 'GET /health → 200 {status: "ok"}');

const page = await fetch(`${API}/convert`);
check(page.status === 200 && (page.headers.get('content-type') || '').startsWith('text/html'), `GET /convert → ${page.status} HTML`);

check(!!(await until(async () => (await couch('/image_jobs')).ok)), 'CouchDB database image_jobs created');

const nc = await connect({ servers: process.env.NATS_URL });
const jsm = await nc.jetstreamManager();
check(!!(await until(() => jsm.streams.info('IMAGE_JOBS'))), 'JetStream stream IMAGE_JOBS created');
check(!!(await until(() => jsm.consumers.info('IMAGE_JOBS', 'api'))), 'image.ready consumer "api" created');

const submit = await fetch(`${API}/api/image-jobs`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: 'x.png', data: 'aGk=', format_in: 'png', format_out: 'jpg' }),
});
check([302, 401, 403].includes(submit.status), `POST /api/image-jobs without login → ${submit.status}, refused`);
const status = await fetch(`${API}/api/image-jobs/smoke`, { redirect: 'manual' });
check([302, 401, 403].includes(status.status), `GET /api/image-jobs/:id without login → ${status.status}, refused`);

// The listener: queued jobs become done / error when image.ready arrives.
const js = nc.jetstream();
for (const [id, event, expect] of [
  ['smoke-done', { success: true, data: 'aGk=' }, (d) => d.status === 'done' && d.data === 'aGk='],
  ['smoke-error', { success: false, error: 'Conversion failed' }, (d) => d.status === 'error' && d.error === 'Conversion failed'],
]) {
  const now = new Date().toISOString();
  await couch(`/image_jobs/${id}`, { method: 'PUT', body: JSON.stringify({
    _id: id, type: 'image_job', transaction_id: id, status: 'queued', params: {}, filename: 'x.png', created_at: now, updated_at: now }) });
  await js.publish('image.ready', sc.encode(JSON.stringify({ transaction_id: id, ...event })));
  const doc = await until(async () => { const d = await (await couch(`/image_jobs/${id}`)).json(); return expect(d) && d; });
  check(!!doc, `image.ready (${event.success ? 'success' : 'failure'}) → job ${id} marked ${event.success ? 'done' : 'error'}`);
}

await nc.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
