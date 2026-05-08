import { ContactMessage } from '../types';

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
      // Log full CouchDB error internally; expose only status code to callers
      // so internal paths and response bodies don't leak through error messages.
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
  for (const db of ['contact_messages', 'bot_state', 'image_jobs']) {
    try {
      await couch(`/${db}`, { method: 'PUT' });
    } catch (e: unknown) {
      // 412 Precondition Failed = database already exists — safe to ignore
      if (!(e instanceof Error) || !e.message.includes('412')) throw e;
    }
  }
}

export async function saveMessage(message: ContactMessage): Promise<void> {
  await couch(`/contact_messages/${message._id}`, {
    method: 'PUT',
    body: JSON.stringify(message),
  });
}

export async function updateMessageStatus(
  id: string,
  status: ContactMessage['status'],
  extra?: Partial<ContactMessage>,
): Promise<void> {
  const doc = (await couch(`/contact_messages/${id}`)) as ContactMessage;
  const updated: ContactMessage = {
    ...doc,
    ...extra,
    status,
    updated_at: new Date().toISOString(),
  };
  await couch(`/contact_messages/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updated),
  });
}

export async function listMessages(limit = 50): Promise<ContactMessage[]> {
  const result = (await couch(
    `/contact_messages/_all_docs?include_docs=true&limit=${limit}`,
  )) as { rows: Array<{ doc: ContactMessage }> };
  return result.rows
    .map((r) => r.doc)
    .filter((d) => d && !d._id.startsWith('_design/'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getMessage(id: string): Promise<ContactMessage> {
  return (await couch(`/contact_messages/${id}`)) as ContactMessage;
}
