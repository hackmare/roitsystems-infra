// Smoke client for anchor-weather-notifications, run inside its container by run.sh.
// A fake Resend API on 127.0.0.1:8025 (the service's RESEND_BASE_URL) records each
// request, so no email is sent. Checks what the service sends for a notification,
// that bad messages are skipped, that a Resend error doesn't stop it, and that it
// refuses to start without RESEND_API_KEY.
import { connect, StringCodec } from '/app/node_modules/nats/index.js';
import { createServer } from 'http';
import { spawnSync } from 'child_process';

const timeoutMs = Number(process.env.SMOKE_TIMEOUT || 20) * 1000;
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
    await sleep(100);
  }
  return null;
};

const requests = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    const json = JSON.parse(body || '{}');
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, json });
    const fail = json.subject === 'smoke-resend-error';
    res.writeHead(fail ? 422 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fail ? { statusCode: 422, name: 'validation_error', message: 'smoke' } : { id: `smoke-${requests.length}` }));
  });
});
await new Promise((r) => fake.listen(8025, '127.0.0.1', r));

const nc = await connect({ servers: process.env.NATS_URL });
const send = (o) => nc.publish('anchor.weather.user.comms', typeof o === 'string' ? sc.encode(o) : sc.encode(JSON.stringify(o)));
await sleep(500); // let the service's subscription settle

send('not json');
send({ type: 'smoke', to_email: 'smoke@example.invalid', subject: 'no body' });
send({ type: 'smoke', subject: 'smoke-resend-error', to_email: 'smoke@example.invalid', body_html: '<p>x</p>' });
send({ type: 'smoke', to_email: 'smoke@example.invalid', to_name: 'Smoke Test', subject: 'Smoke subject',
  body_html: '<p>Smoke body</p>', cc_email: 'cc@example.invalid' });

const ok = await until(() => requests.find((r) => r.json.subject === 'Smoke subject'));
check(!!ok, 'a notification reaches the (fake) Resend API');
check(ok?.method === 'POST' && ok?.url === '/emails', `as POST /emails (got ${ok?.method} ${ok?.url})`);
check(ok?.auth === 'Bearer re_smoke_test_only_not_a_key', 'with the configured API key');
const j = ok?.json || {};
check(j.from === 'Vector Weather <info@selkietech.ca>' && j.to === 'Smoke Test <smoke@example.invalid>'
  && j.html === '<p>Smoke body</p>' && j.cc === 'cc@example.invalid',
  `with from, to, subject, html and cc as sent (${JSON.stringify({ from: j.from, to: j.to, cc: j.cc })})`);
check(!requests.some((r) => r.json.subject === 'no body'), 'a message missing body_html is skipped, not sent');
check(requests.some((r) => r.json.subject === 'smoke-resend-error'), 'a Resend error response is received (and the next message is still sent)');
check(requests.length === 2, `exactly two requests made (${requests.length})`);

const start = (env) => spawnSync(process.execPath, ['/app/index.js'], {
  env: { PATH: process.env.PATH, NATS_URL: 'nats://127.0.0.1:1', ...env }, encoding: 'utf8', timeout: 5_000 });
const noKey = start({});
check(noKey.status === 1 && /RESEND_API_KEY is not set/.test(noKey.stderr), 'refuses to start without RESEND_API_KEY');
// In production the API key may only go to Resend's own API.
const KEY = { RESEND_API_KEY: 're_smoke_test_only_not_a_key', NODE_ENV: 'production' };
for (const base of ['http://127.0.0.1:8025', 'https://api.resend.com.evil.example', 'http://api.resend.com', 'not a url']) {
  const r = start({ ...KEY, RESEND_BASE_URL: base });
  check(r.status === 1 && /RESEND_BASE_URL must be/.test(r.stderr), `production refuses RESEND_BASE_URL=${base}`);
}
for (const base of [undefined, 'https://api.resend.com', 'https://api.resend.com/']) {
  const r = start({ ...KEY, ...(base ? { RESEND_BASE_URL: base } : {}) });
  check(!/RESEND_BASE_URL must be/.test(r.stderr), `production accepts ${base ? `RESEND_BASE_URL=${base}` : 'no RESEND_BASE_URL'}`);
}

await nc.close();
fake.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
