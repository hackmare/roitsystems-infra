import { ImageJob, ImageJobParams } from '../types';
import { randomUUID } from 'crypto';
import { getJetStreamClient, sc } from './nats';

const COUCHDB_URL = process.env.COUCHDB_URL || 'http://localhost:5984';
const COUCHDB_USER = process.env.COUCHDB_USER || '';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || '';

const AUTH = Buffer.from(`${COUCHDB_USER}:${COUCHDB_PASSWORD}`).toString('base64');
const BASE_HEADERS = {
  Authorization: `Basic ${AUTH}`,
  'Content-Type': 'application/json',
};

const FETCH_TIMEOUT_MS = 10_000;

async function couch(path: string, options: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${COUCHDB_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { ...BASE_HEADERS, ...(options.headers as Record<string, string> || {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`CouchDB error: ${options.method || 'GET'} ${path} → ${res.status}`, text);
      throw new Error(`Database error (${res.status})`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureDatabases(): Promise<void> {
  try {
    await couch('/image_jobs', { method: 'PUT' });
  } catch (e: unknown) {
    // 412 Precondition Failed = database already exists — safe to ignore
    if (!(e instanceof Error) || !e.message.includes('412')) throw e;
  }
}

export function initImageJobs(): void {
  // Initialize image jobs database if needed (ensure table exists, etc.)
  // For now, just a placeholder as CouchDB creates tables on demand
}

export async function createImageJob(
  filename: string,
  params: ImageJobParams
): Promise<ImageJob> {
  const transactionId = randomUUID();
  const now = new Date().toISOString();

  const job: ImageJob = {
    _id: transactionId,
    type: 'image_job',
    transaction_id: transactionId,
    status: 'queued',
    params,
    filename,
    created_at: now,
    updated_at: now,
  };

  await couch('/image_jobs/' + transactionId, {
    method: 'PUT',
    body: JSON.stringify(job),
  });

  return job;
}

export async function publishImageConvertJob(
  transactionId: string,
  data: string,
  format_in: string,
  format_out: string
): Promise<void> {
  const job = await getImageJob(transactionId);
  if (!job) {
    throw new Error(`Job not found: ${transactionId}`);
  }

  const event = {
    transaction_id: transactionId,
    type: 'image.convert',
    data,
    format_in,
    format_out,
    params: job.params,
  };

  const js = getJetStreamClient();
  await js.publish('image.convert', sc.encode(JSON.stringify(event)));
}

export async function getImageJob(transactionId: string): Promise<ImageJob | null> {
  try {
    const doc = (await couch(`/image_jobs/${transactionId}`)) as ImageJob;
    return doc;
  } catch (err: any) {
    if (err.message.includes('404')) {
      return null;
    }
    throw err;
  }
}

export async function updateImageJobStatus(
  transactionId: string,
  status: 'processing' | 'done' | 'error',
  data?: string,
  error?: string
): Promise<void> {
  const job = await getImageJob(transactionId);
  if (!job) {
    throw new Error(`Job not found: ${transactionId}`);
  }

  const updated: ImageJob = {
    ...job,
    status,
    data,
    error,
    updated_at: new Date().toISOString(),
  };

  await couch(`/image_jobs/${transactionId}`, {
    method: 'PUT',
    body: JSON.stringify(updated),
  });
}
