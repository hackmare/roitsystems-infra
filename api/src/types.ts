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

export interface ImageJobParams {
  format_in: string;
  format_out: string;
  quality?: number;
  width?: number;
  height?: number;
  lockAspectRatio?: boolean;
  rotate?: number;
  trim?: boolean;
  colorspace?: string;
  background?: string;
  flatten?: boolean;
  density?: number;
  blur?: number;
  sharpen?: number;
}

export interface ImageJob {
  _id: string;
  _rev?: string;
  type: 'image_job';
  transaction_id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  params: ImageJobParams;
  filename?: string;
  data?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}
