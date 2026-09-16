import {
  connect,
  NatsConnection,
  JetStreamClient,
  StringCodec,
  RetentionPolicy,
  StorageType,
  Consumer,
  AckPolicy,
  DeliverPolicy,
} from 'nats';

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
export const sc = StringCodec();

export function getJetStreamClient(): JetStreamClient {
  if (!js) throw new Error('NATS not connected');
  return js;
}

export function getNatsConnection(): NatsConnection {
  if (!nc) throw new Error('NATS not connected');
  return nc;
}

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

  const jsm = await nc.jetstreamManager();

  // Create IMAGE_JOBS stream
  try {
    await jsm.streams.add({
      name: 'IMAGE_JOBS',
      subjects: ['image.convert', 'image.ready'],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      num_replicas: 1,
    });
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes('stream name already in use')) {
      throw e;
    }
  }
}

export async function getImageReadyConsumer(): Promise<Consumer> {
  if (!js || !nc) throw new Error('NATS not connected');
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.consumers.add('IMAGE_JOBS', {
      durable_name: 'api',
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: 'image.ready',
      max_deliver: 5,
      ack_wait: 30_000_000_000,
    });
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes('consumer name already in use')) {
      throw e;
    }
  }

  return js.consumers.get('IMAGE_JOBS', 'api');
}

export async function closeNats(): Promise<void> {
  await nc?.drain();
}
