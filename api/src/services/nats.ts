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
  nc = await connect({ servers });
  js = nc.jetstream();

  const jsm = await nc.jetstreamManager();

  // Create CONTACT_MESSAGES stream
  try {
    await jsm.streams.add({
      name: 'CONTACT_MESSAGES',
      subjects: ['contact.messages.*'],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      max_age: 30 * 24 * 60 * 60 * 1_000_000_000,
      num_replicas: 1,
    });
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes('stream name already in use')) {
      throw e;
    }
  }

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
