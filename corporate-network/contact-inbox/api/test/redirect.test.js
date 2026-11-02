// Unit tests for src/redirect.ts: post-login redirects stay on this site.
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeRedirect } = require('../dist/redirect');

const FALLBACK = '/fallback';

test('same-site paths are kept', () => {
  for (const p of ['/', '/corporate-network/contact/admin', '/a/b?x=1#y', '/%2F%2Fevil.example']) {
    assert.equal(safeRedirect(p, FALLBACK), p, p);
  }
});

test('other sites and odd values fall back', () => {
  for (const p of ['//evil.example', '/\\evil.example', 'https://evil.example', 'http:evil.example',
    '%2F%2Fevil.example', 'evil.example', '\t/evil', '\n/evil', '/\t/evil.example', '/\n/evil.example',
    '/evil\r\n', 'javascript:alert(1)', '', undefined, null, 42, ['/a']]) {
    assert.equal(safeRedirect(p, FALLBACK), FALLBACK, JSON.stringify(p));
  }
});
