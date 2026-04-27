import {
  connect,
  NatsConnection,
  JetStreamClient,
  StringCodec,
  RetentionPolicy,
  StorageType,
} from 'nats';
import { NatsMessageEvent } from '../types';

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
const sc = StringCodec();

export async function connectNats(): Promise<void> {
  const servers = process.env.NATS_URL || 'nats://localhost:4222';
  nc = await connect({ servers });
  js = nc.jetstream();

  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.add({
      name: 'CONTACT_MESSAGES',
      subjects: ['contact.messages.*'],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      // 30 days in nanoseconds
      max_age: 30 * 24 * 60 * 60 * 1_000_000_000,
      num_replicas: 1,
    });
  } catch (e: unknown) {
    // Stream already exists — update is idempotent
    if (!(e instanceof Error) || !e.message.includes('stream name already in use')) {
      throw e;
    }
  }
}

export async function publishContactMessage(messageId: string): Promise<void> {
  if (!js) throw new Error('NATS not connected');
  const event: NatsMessageEvent = {
    type: 'contact.new',
    message_id: messageId,
    timestamp: new Date().toISOString(),
  };
  await js.publish('contact.messages.new', sc.encode(JSON.stringify(event)));
}

export async function closeNats(): Promise<void> {
  await nc?.drain();
}
