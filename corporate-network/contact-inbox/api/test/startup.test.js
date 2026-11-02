// The service must refuse to start, before listening, without usable session settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
  env: { PATH: process.env.PATH, PORT: '0', LOG_LEVEL: 'silent', ...env },
  encoding: 'utf8',
  timeout: 15_000,
});

for (const [what, env, message] of [
  ['no SESSION_SECRET', { ADMIN_EMAILS: 'admin@example.invalid' }, /SESSION_SECRET/],
  ['a short SESSION_SECRET', { SESSION_SECRET: 'x'.repeat(31), ADMIN_EMAILS: 'admin@example.invalid' }, /SESSION_SECRET/],
  ['no ADMIN_EMAILS', { SESSION_SECRET: 'x'.repeat(32) }, /ADMIN_EMAILS/],
  ['ADMIN_EMAILS with only separators', { SESSION_SECRET: 'x'.repeat(32), ADMIN_EMAILS: ' , ' }, /ADMIN_EMAILS/],
]) {
  test(`refuses to start with ${what}`, () => {
    const r = run(env);
    assert.equal(r.signal, null, 'exited by itself, not killed by the timeout');
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
  });
}
