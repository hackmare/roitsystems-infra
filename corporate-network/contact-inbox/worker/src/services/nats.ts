import {
  connect,
  NatsConnection,
  JetStreamClient,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  Consumer,
} from 'nats';

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
export const sc = StringCodec();

export async function connectNats(): Promise<void> {
  const servers = process.env.NATS_URL || 'nats://localhost:4222';
  // NATS credentials are passed as separate options, NOT embedded in the servers
  // URL: nats.js throws "TypeError: Invalid URL" on `nats://user:pass@host:4222`
  // (nats-py accepts that form, which is why the Python services differ). With
  // NATS_USER unset the connection stays unauthenticated, which is what the
  // server's no_auth_user shim expects mid-rollout.
  const auth = process.env.NATS_USER
    ? { user: process.env.NATS_USER, pass: process.env.NATS_PASS }
    : {};
  nc = await connect({ servers, ...auth });
  js = nc.jetstream();
  console.log('Worker connected to NATS');
}

export async function getOrCreateConsumer(): Promise<Consumer> {
  if (!js || !nc) throw new Error('NATS not connected');
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.consumers.add('CONTACT_MESSAGES', {
      durable_name: 'worker',
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: 'contact.messages.new',
      // Retry up to 5 times before marking as failed; 30-second ack window
      max_deliver: 5,
      ack_wait: 30_000_000_000,
    });
  } catch (e: unknown) {
    // Consumer already exists — that's fine
    if (!(e instanceof Error) || !e.message.includes('consumer name already in use')) {
      throw e;
    }
  }

  return js.consumers.get('CONTACT_MESSAGES', 'worker');
}

export async function drainNats(): Promise<void> {
  await nc?.drain();
}
