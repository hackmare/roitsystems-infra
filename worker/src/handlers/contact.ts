import { setMessageStatus } from '../services/couchdb';

interface ContactEvent {
  type: string;
  message_id: string;
  timestamp: string;
}

export async function handleContactMessage(event: ContactEvent): Promise<void> {
  const { message_id } = event;

  await setMessageStatus(message_id, 'processing');
  console.log({ msg_id: message_id, status: 'processing' });

  // ── Notification stub ─────────────────────────────────────────────────────
  // Replace this block to add real notifications.
  // NOTIFICATION_WEBHOOK_URL can point to a Signal/Telegram/email relay.
  const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id, event: 'contact.new' }),
      });
    } catch (e) {
      // Notification failure must not block message processing
      console.warn({ msg_id: message_id, warn: 'webhook delivery failed', error: String(e) });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  await setMessageStatus(message_id, 'processed', 'Processed by worker');
  console.log({ msg_id: message_id, status: 'processed' });
}
