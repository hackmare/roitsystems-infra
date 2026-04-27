const COUCHDB_URL = process.env.COUCHDB_URL || 'http://localhost:5984';
const COUCHDB_USER = process.env.COUCHDB_USER || '';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || '';

const AUTH = Buffer.from(`${COUCHDB_USER}:${COUCHDB_PASSWORD}`).toString('base64');
const BASE_HEADERS = {
  Authorization: `Basic ${AUTH}`,
  'Content-Type': 'application/json',
};

async function couch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${COUCHDB_URL}${path}`, {
    ...options,
    headers: { ...BASE_HEADERS, ...(options.headers as Record<string, string> || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CouchDB ${options.method || 'GET'} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

export async function setMessageStatus(
  id: string,
  status: 'received' | 'processing' | 'processed' | 'failed',
  note?: string,
): Promise<void> {
  const doc = (await couch(`/contact_messages/${id}`)) as Record<string, unknown>;
  const updated = {
    ...doc,
    status,
    ...(note ? { worker_note: note } : {}),
    updated_at: new Date().toISOString(),
  };
  await couch(`/contact_messages/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updated),
  });
}
