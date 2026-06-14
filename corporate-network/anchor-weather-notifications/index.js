import { connect, StringCodec } from 'nats';
import { Resend } from 'resend';

const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const SUBJECT = 'anchor.weather.user.comms';
const FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || 'anchor@roitsystems.ca';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  console.error('[anchor-weather-notifications] RESEND_API_KEY is not set — exiting');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);
const sc = StringCodec();

function log(level, message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
}

async function sendEmail(payload) {
  const { to_email, to_name, subject, body_html, cc_email } = payload;
  if (!to_email || !subject || !body_html) {
    log('warn', 'Skipping message with missing fields', { payload });
    return;
  }
  const to = to_name ? `${to_name} <${to_email}>` : to_email;
  const params = {
    from: `Anchor Weather <${FROM_EMAIL}>`,
    to,
    subject,
    html: body_html,
  };
  if (cc_email) {
    params.cc = cc_email;
  }
  const { error } = await resend.emails.send(params);
  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
  log('info', 'Email sent', { type: payload.type, to: to_email });
}

async function main() {
  log('info', 'Connecting to NATS', { url: NATS_URL });
  const nc = await connect({ servers: NATS_URL });
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

    log('info', 'Received notification', { type: payload.type, to: payload.to_email });

    try {
      await sendEmail(payload);
    } catch (e) {
      log('error', 'Failed to send email', { error: String(e), type: payload.type, to: payload.to_email });
    }
  }

  await nc.drain();
}

main().catch((e) => {
  log('error', 'Fatal error', { error: String(e) });
  process.exit(1);
});
