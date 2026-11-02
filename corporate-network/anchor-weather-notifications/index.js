import { connect, StringCodec } from 'nats';
import { Resend } from 'resend';

const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const SUBJECT = 'anchor.weather.user.comms';
const FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || 'info@selkietech.ca';
const FROM_NAME = process.env.NOTIFICATION_FROM_NAME || 'Vector Weather';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  console.error('[anchor-weather-notifications] RESEND_API_KEY is not set — exiting');
  process.exit(1);
}

// The Resend SDK sends the API key to RESEND_BASE_URL when it is set. It must be
// Resend's own API unless RESEND_ALLOW_TEST_BASE_URL=1, which only the smoke test sets.
const RESEND_BASE_URL = process.env.RESEND_BASE_URL;
if (RESEND_BASE_URL && process.env.RESEND_ALLOW_TEST_BASE_URL !== '1') {
  let origin = null;
  try {
    origin = new URL(RESEND_BASE_URL).origin;
  } catch {}
  if (origin !== 'https://api.resend.com') {
    console.error('[anchor-weather-notifications] RESEND_BASE_URL must be https://api.resend.com — exiting');
    process.exit(1);
  }
}

const resend = new Resend(RESEND_API_KEY);
const sc = StringCodec();

function log(level, message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
}

// Logs carry the notification type and status only: addresses, names and the
// email itself are users' personal data.
async function sendEmail(payload) {
  const { to_email, to_name, subject, body_html, cc_email } = payload;
  if (!to_email || !subject || !body_html) {
    log('warn', 'Skipping message with missing fields', {
      type: payload.type,
      missing: ['to_email', 'subject', 'body_html'].filter((k) => !payload[k]),
    });
    return;
  }
  const to = to_name ? `${to_name} <${to_email}>` : to_email;
  const params = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject,
    html: body_html,
  };
  if (cc_email) {
    params.cc = cc_email;
  }
  const { error } = await resend.emails.send(params);
  if (error) {
    // Resend's message can quote the addresses it rejected: keep only its kind.
    const failure = new Error('Resend error');
    failure.resend = { name: error.name, statusCode: error.statusCode };
    throw failure;
  }
  log('info', 'Email sent', { type: payload.type, hasCc: !!cc_email });
}

async function main() {
  log('info', 'Connecting to NATS', { url: NATS_URL });
  // NATS credentials are passed as separate options, NOT embedded in the servers
  // URL: nats.js throws "TypeError: Invalid URL" on `nats://user:pass@host:4222`
  // (nats-py accepts that form, which is why the Python services differ). With
  // NATS_USER unset the connection stays unauthenticated, which is what the
  // server's no_auth_user shim expects mid-rollout.
  const auth = process.env.NATS_USER
    ? { user: process.env.NATS_USER, pass: process.env.NATS_PASS }
    : {};
  const nc = await connect({ servers: NATS_URL, ...auth });
  log('info', `Subscribed to ${SUBJECT}`);

  const sub = nc.subscribe(SUBJECT);
  for await (const msg of sub) {
    let payload;
    try {
      payload = JSON.parse(sc.decode(msg.data));
    } catch (e) {
      log('warn', 'Failed to parse message', { error: String(e) });
      continue;
    }

    log('info', 'Received notification', { type: payload.type });

    try {
      await sendEmail(payload);
    } catch (e) {
      log('error', 'Failed to send email', { error: e.resend ? 'Resend error' : e.name, ...(e.resend || {}), type: payload.type });
    }
  }

  await nc.drain();
}

main().catch((e) => {
  log('error', 'Fatal error', { error: String(e) });
  process.exit(1);
});
