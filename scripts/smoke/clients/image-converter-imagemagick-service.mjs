// Smoke client for imagemagick-service, run inside its container by run.sh.
// Checks each output format's magic bytes, each input format, the error replies,
// and that no temp files are left behind.
import { connect } from '/app/node_modules/nats/index.js';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';

const timeoutMs = Number(process.env.SMOKE_TIMEOUT || 20) * 1000;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// Test inputs, made with the image's own ImageMagick (40x30 solid colour).
const input = {};
for (const f of ['png', 'jpg', 'webp', 'gif']) {
  try {
    execFileSync('magick', ['-size', '40x30', 'xc:#3366cc', `/tmp/smoke-in.${f}`], { stdio: 'pipe' });
    input[f] = readFileSync(`/tmp/smoke-in.${f}`).toString('base64');
  } catch {
    check(false, `make a ${f} test input (ImageMagick has no ${f} coder)`);
  }
}

const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const pngWidth = (b) => b.readUInt32BE(16);
const magic = {
  png: (b) => isPng(b) && pngWidth(b) === 20,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  gif: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  svg: (b) => {
    const s = b.toString('utf8');
    const m = s.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
    return s.startsWith('<?xml') && s.includes('<svg width="20"') && !!m && isPng(Buffer.from(m[1], 'base64'));
  },
};

const nc = await connect({ servers: process.env.NATS_URL });
const replies = new Map();
const sub = nc.subscribe('image.ready');
(async () => {
  for await (const m of sub) {
    const r = JSON.parse(new TextDecoder().decode(m.data));
    replies.set(r.transaction_id ?? '(none)', r);
  }
})();

const cases = [
  ...['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].map((out) => ({ id: `png-to-${out}`, in: 'png', out, expect: 'ok' })),
  ...['jpg', 'webp', 'gif'].map((inp) => ({ id: `${inp}-to-png`, in: inp, out: 'png', expect: 'ok' })),
  { id: 'err-unsupported-out', in: 'png', out: 'tiff', expect: 'error' },
  { id: 'err-svg-input', in: 'svg', out: 'png', expect: 'error', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') },
  { id: 'err-path-in-format', in: 'png', out: '../x', expect: 'error' },
  { id: 'err-corrupt-input', in: 'png', out: 'jpg', expect: 'error', data: Buffer.from('not an image').toString('base64') },
  { id: 'err-missing-fields', in: 'png', out: '', expect: 'error' },
];
const sent = cases.filter((c) => c.data || input[c.in]);
for (const c of sent) {
  nc.publish('image.convert', enc({
    transaction_id: c.id, format_in: c.in, format_out: c.out,
    data: c.data ?? input[c.in], params: { width: 20, lockAspectRatio: true },
  }));
}

const deadline = Date.now() + timeoutMs;
while (replies.size < sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

for (const c of cases) {
  const r = replies.get(c.id);
  if (!sent.includes(c)) { check(false, `${c.id}: not sent, no ${c.in} test input`); continue; }
  if (!r) { check(false, `${c.id}: no reply within ${timeoutMs / 1000}s`); continue; }
  if (c.expect === 'ok') {
    const out = r.success ? Buffer.from(r.data, 'base64') : Buffer.alloc(0);
    check(r.success === true && magic[c.out](out), `${c.id}: success, ${out.length} bytes, ${c.out} signature${r.success ? '' : ` (error: ${r.error})`}`);
  } else {
    check(r.success === false && typeof r.error === 'string', `${c.id}: error reply with transaction_id (${r.error})`);
  }
}
check(!replies.has('(none)'), 'no reply without a transaction_id');

// Give the handlers' cleanup a moment, then confirm the temp files are gone.
await new Promise((r) => setTimeout(r, 500));
const left = readdirSync('/tmp').filter((f) => f.startsWith('convert-'));
check(left.length === 0, `temp files cleaned up (${left.length} left${left.length ? ': ' + left.join(', ') : ''})`);

await nc.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
