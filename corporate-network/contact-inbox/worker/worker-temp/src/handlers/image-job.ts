import { StringCodec } from 'nats';

const sc = StringCodec();

interface ImageJobReadyEvent {
  transaction_id: string;
  type: 'image.job.done' | 'image.job.error';
  error?: string;
}

export async function handleImageJobComplete(
  event: ImageJobReadyEvent,
  nats: any
): Promise<void> {
  // Republish to image.ready for downstream consumers
  const readyEvent = {
    transaction_id: event.transaction_id,
    type: 'image.ready',
    success: event.type === 'image.job.done',
    error: event.error,
  };

  await nats.publish('image.ready', sc.encode(JSON.stringify(readyEvent)));

  console.log(
    { transaction_id: event.transaction_id, type: event.type },
    'image job ready event published'
  );
}
