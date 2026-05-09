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
  nc = await connect({ servers });
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
