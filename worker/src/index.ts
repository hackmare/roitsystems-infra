import { connectNats, getOrCreateConsumer, drainNats, sc } from './services/nats';
import { handleContactMessage } from './handlers/contact';

async function main() {
  await connectNats();
  const consumer = await getOrCreateConsumer();

  console.log('Worker ready — consuming CONTACT_MESSAGES');

  const messages = await consumer.consume();

  for await (const msg of messages) {
    let event: { type: string; message_id: string; timestamp: string } | undefined;
    try {
      event = JSON.parse(sc.decode(msg.data));
    } catch {
      console.error('Failed to parse message payload — discarding');
      msg.ack();
      continue;
    }

    try {
      await handleContactMessage(event!);
      msg.ack();
    } catch (e) {
      console.error({ msg_id: event?.message_id, error: String(e) }, 'message processing failed');
      // nak with a delay so NATS retries after backoff
      msg.nak(5000);
    }
  }
}

process.on('SIGTERM', async () => {
  console.log('Worker shutting down');
  await drainNats();
  process.exit(0);
});

main().catch((err) => {
  console.error('Worker fatal error:', err);
  process.exit(1);
});
