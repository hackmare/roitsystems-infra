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
