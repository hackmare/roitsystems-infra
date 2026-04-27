export interface ContactMessage {
  _id: string;
  _rev?: string;
  type: 'contact_message';
  name: string;
  email: string;
  company?: string;
  subject: string;
  message: string;
  budget?: string;
  timeline?: string;
  source_page?: string;
  timestamp: string;
  consent?: boolean;
  status: 'received' | 'processing' | 'processed' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface NatsMessageEvent {
  type: 'contact.new';
  message_id: string;
  timestamp: string;
}
