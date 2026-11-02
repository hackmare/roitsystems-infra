// Smoke client for contact-inbox/notification-service, run inside its container by
// run.sh. Fake CouchDB (8026), Anthropic (8027) and Resend (8025) APIs on 127.0.0.1
// record every request, so nothing leaves the container. Checks the path from a
// contact.messages.new event to an analysis request and a notification email, the
// cases that must not send anything, and the API base guards.
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

const seen = { couch: [], anthropic: [], resend: [] };
const fake = (port, kind, respond) => new Promise((resolve) => {
  createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, json: body ? JSON.parse(body) : null };
      seen[kind].push(r);
      const [status, out] = respond(r);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  }).listen(port, '127.0.0.1', resolve);
});

const docs = {
  'smoke-ok': { _id: 'smoke-ok', name: 'Smoke Sender', email: 'sender@example.invalid', subject: 'Smoke subject',
    message: 'Smoke test message, please ignore.', company_size: '11-50', source_page: 'https://roitsystems.ca/contact',
    timestamp: new Date().toISOString() },
  // Hostile input: HTML in every field, and a subject that tries to add a header.
  'smoke-hostile': { _id: 'smoke-hostile', name: 'Eve <a href="https://evil.example">x</a>', email: 'eve@example.invalid"><script>',
    subject: 'Hi\r\nBcc: victim@example.invalid <img src=https://evil.example/t.png>' + 'x'.repeat(300),
    message: 'smoke-hostile <img src=https://evil.example/t.png> "><script>alert(1)</script> <a href="https://evil.example">click</a>',
    company_size: '<b>big</b>', source_page: 'https://roitsystems.ca/contact', timestamp: new Date().toISOString() },
  // Only https pages on roitsystems.ca or a subdomain count; these look-alikes don't.
  // (Their URLs carry "url-mark" so the log scan can tell a logged URL from a logged id.)
  ...Object.fromEntries(['https://evil.example/?roitsystems.ca=url-mark', 'https://roitsystems.ca.evil.example/url-mark',
    'https://evilroitsystems.ca/url-mark', 'http://roitsystems.ca/url-mark', 'not a url url-mark'].map((page, i) => [`smoke-lookalike-${i}`,
    { _id: `smoke-lookalike-${i}`, name: 'L', email: 'l@example.invalid', subject: 'Lookalike', message: 'From a look-alike page.', source_page: page }])),
  'smoke-subdomain': { _id: 'smoke-subdomain', name: 'S', email: 's@example.invalid', subject: 'Subdomain',
    message: 'From www.', source_page: 'https://www.roitsystems.ca/contact', timestamp: new Date().toISOString() },
  'smoke-other-site': { _id: 'smoke-other-site', name: 'X', email: 'x@example.invalid', subject: 'Other',
    message: 'From another site.', source_page: 'https://example.invalid/contact' },
};
const analysis = { painPoint: 'SMOKE-PAIN-POINT', recommendedServices: ['Smoke Service'], rationale: 'r',
  immediateOpportunity: 'i', timeline: 'soon', technicalContext: ['t'] };
await fake(8026, 'couch', (r) => {
  const id = decodeURIComponent(r.url.split('/').pop());
  return docs[id] ? [200, docs[id]] : [404, { error: 'not_found' }];
});
// For the hostile message, the fake model echoes the payloads in every field, as a
// steered model could.
const EVIL = '<a href="https://evil.example">x</a> <img src=https://evil.example/t.png> "><script>';
const hostileAnalysis = { painPoint: EVIL, companyResearch: { name: EVIL, estimatedSize: EVIL, likelyIndustry: EVIL,
  organizationalMaturity: EVIL, industryContext: EVIL }, competitiveAnalysis: EVIL, recommendedServices: [EVIL, EVIL],
  rationale: EVIL, immediateOpportunity: EVIL, timeline: EVIL, technicalContext: [EVIL], marketInsight: EVIL };
await fake(8027, 'anthropic', (r) => [200, { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'smoke',
  content: [{ type: 'text', text: JSON.stringify(/smoke-hostile/.test(JSON.stringify(r.json)) ? hostileAnalysis : analysis) }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }]);
await fake(8025, 'resend', () => [200, { id: 'smoke-email' }]);

const nc = await connect({ servers: process.env.NATS_URL });
const event = (id) => nc.publish('contact.messages.new', sc.encode(JSON.stringify({ type: 'contact.new', message_id: id })));
await sleep(500); // let the service's subscription settle

nc.publish('contact.messages.new', sc.encode('not json'));
event('smoke-missing');
event('smoke-other-site');
for (let i = 0; i < 5; i++) event(`smoke-lookalike-${i}`);
event('smoke-subdomain');
event('smoke-ok');
event('smoke-ok'); // duplicate
event('smoke-hostile');
event('smoke/odd?id#1'); // must reach CouchDB as one encoded path segment

const email = await until(() => seen.resend.find((r) => r.json?.subject === 'New Contact: Smoke subject'));
const hostile = await until(() => seen.resend.find((r) => /smoke-hostile/.test(r.json?.html || '')));
await sleep(1000); // time for any further (unwanted) requests

const couchIds = seen.couch.map((r) => r.url.split('/').pop());
check(['smoke-missing', 'smoke-other-site', 'smoke-ok'].every((id) => couchIds.includes(id)), `messages fetched from CouchDB (${couchIds.join(', ')})`);
check(seen.couch.some((r) => r.url === '/contact_messages/smoke%2Fodd%3Fid%231'), 'a message id is sent to CouchDB URL-encoded');
check(seen.couch.every((r) => r.headers.authorization === 'Basic ' + Buffer.from('smoke:smoke').toString('base64')), 'CouchDB requests use the configured credentials');
check(seen.anthropic.length === 3, `exactly three analysis requests (${seen.anthropic.length}): the three roitsystems.ca messages, once each`);
check(!seen.anthropic.some((r) => /look-alike page/.test(JSON.stringify(r.json))), 'no analysis for look-alike pages (evil.example/?roitsystems.ca, roitsystems.ca.evil.example, evilroitsystems.ca, http, not a URL)');
check(seen.anthropic.some((r) => /From www\./.test(JSON.stringify(r.json))), 'a page on a roitsystems.ca subdomain is processed');
const a = seen.anthropic.find((r) => /Smoke test message/.test(JSON.stringify(r.json)));
// The SDK sends the key as x-api-key or as a bearer token, depending on its version.
const aKey = a?.headers['x-api-key'] || (a?.headers.authorization || '').replace(/^Bearer /, '');
check(a?.url === '/v1/messages' && aKey === 'sk-smoke-test-only-not-a-key' && /Smoke test message/.test(a?.json?.messages?.[0]?.content || ''),
  'the analysis request goes to /v1/messages with the configured key and the message text');
check(seen.resend.length === 3, `exactly three emails (${seen.resend.length})`);
const e = email?.json || {};
check(email?.url === '/emails' && email?.headers.authorization === 'Bearer re_smoke_test_only_not_a_key'
  && e.to === 'inbox@example.invalid' && e.from === 'from@example.invalid' && e.subject === 'New Contact: Smoke subject',
  `the email goes to the configured inbox (${JSON.stringify({ to: e.to, from: e.from, subject: e.subject })})`);
check(/SMOKE-PAIN-POINT/.test(e.html || '') && /Smoke test message/.test(e.html || ''), 'the email includes the analysis and the message');

// Hostile input arrives escaped: no live markup from the sender or the model.
const hh = hostile?.json?.html || '';
check(!!hostile, 'the hostile message is still delivered');
check(!/<a\s+href="https:\/\/evil/i.test(hh) && !/<img/i.test(hh) && !/<script/i.test(hh) && !/<b>big/.test(hh),
  'no <a href=evil>, <img>, <script> or <b> from the sender or the model in the html');
check(hh.includes('&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;') && hh.includes('&lt;img src=https://evil.example/t.png&gt;')
  && hh.includes('&quot;&gt;&lt;script&gt;'), 'the payloads appear as escaped text');
const evilCount = (hh.match(/&lt;img src=https:\/\/evil\.example\/t\.png&gt;/g) || []).length;
check(evilCount >= 14, `every analysis field is escaped too (${evilCount} escaped copies)`);
const hs = hostile?.json?.subject || '';
check(!/[\r\n\u0000-\u001f]/.test(hs) && hs.length <= 150 && hs.startsWith('New Contact: Hi Bcc:'),
  `the subject is one line of at most 150 characters (${hs.length}: ${JSON.stringify(hs.slice(0, 40))}…)`);
check(!/href="(?!https:\/\/pubapi\.roitsystems\.ca\/admin")/.test(hh), 'the only link is the fixed admin-console URL');

const start = (env) => spawnSync(process.execPath, ['/app/index.js'], {
  env: { PATH: process.env.PATH, NATS_URL: 'nats://127.0.0.1:1', RESEND_API_KEY: 're_x', CLAUDE_API_KEY: 'sk-x', ...env },
  encoding: 'utf8', timeout: 5_000 });
const refused = (r, name) => r.status === 1 && new RegExp(`${name} must be`).test(r.stderr);
for (const [name, real, flag] of [
  ['RESEND_BASE_URL', 'https://api.resend.com', 'RESEND_ALLOW_TEST_BASE_URL'],
  ['ANTHROPIC_BASE_URL', 'https://api.anthropic.com', 'ANTHROPIC_ALLOW_TEST_BASE_URL'],
]) {
  const host = new URL(real).host;
  for (const env of [{}, { NODE_ENV: 'production' }, { [flag]: 'true' }]) {
    for (const base of ['http://127.0.0.1:8025', `https://${host}.evil.example`, `http://${host}`, 'not a url']) {
      check(refused(start({ ...env, [name]: base }), name), `refuses ${name}=${base} with ${JSON.stringify(env)}`);
    }
  }
  for (const base of [real, `${real}/`]) check(!refused(start({ [name]: base }), name), `accepts ${name}=${base}`);
  check(!refused(start({ [name]: 'http://127.0.0.1:1', [flag]: '1' }), name), `accepts a test ${name} only with ${flag}=1`);
}
check(!refused(start({}), 'RESEND_BASE_URL') && !refused(start({}), 'ANTHROPIC_BASE_URL'), 'accepts neither base set');

await nc.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
