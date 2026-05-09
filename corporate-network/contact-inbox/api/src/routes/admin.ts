import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { listMessages, getMessage } from '../services/couchdb';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// HMAC key generated once per process lifetime.
// Wrapping tokens in HMAC before timingSafeEqual ensures both buffers are
// always equal-length (SHA-256 output), preventing length-based timing leaks.
const HMAC_KEY = randomBytes(32);

function hmac(value: string): Buffer {
  return createHmac('sha256', HMAC_KEY).update(value).digest();
}

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!ADMIN_TOKEN) {
    reply.status(503).send({ error: 'Admin access not configured' });
    return false;
  }

  const match = timingSafeEqual(hmac(provided), hmac(ADMIN_TOKEN));
  if (!match) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Per-route rate-limit config: applied because the global plugin is registered
// with global:false in index.ts. 30 requests / 15 min per IP slows brute force
// attempts against the admin token without blocking normal admin use.
const adminRateLimit = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many requests. Try again later.' }),
    },
  },
};

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>RO IT Systems — Messages</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; }
  .header { background: #0f172a; color: white; padding: 1rem 1.5rem; display: flex; align-items: center; gap: 1rem; }
  .header h1 { font-size: 1rem; font-weight: 600; }
  .header .logout { margin-left: auto; background: transparent; border: 1px solid rgba(255,255,255,0.3); color: white; padding: 0.375rem 0.75rem; border-radius: 999px; cursor: pointer; font-size: 0.8rem; }
  .container { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
  #login { max-width: 360px; margin: 4rem auto; background: white; padding: 2rem; border-radius: 1rem; border: 1px solid #e2e8f0; box-shadow: 0 4px 24px rgba(15,23,42,0.07); }
  #login h2 { font-size: 1.25rem; margin-bottom: 1.25rem; }
  #login input { width: 100%; padding: 0.75rem 1rem; border: 1px solid #e2e8f0; border-radius: 0.75rem; font-size: 0.95rem; margin-bottom: 0.75rem; }
  #login button { width: 100%; background: #1d4ed8; color: white; border: none; padding: 0.75rem; border-radius: 999px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  #login button:hover { background: #1e40af; }
  .error { color: #dc2626; font-size: 0.85rem; margin-top: 0.5rem; }
  .card { background: white; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.25rem; margin-bottom: 0.75rem; cursor: pointer; transition: box-shadow 0.15s; }
  .card:hover { box-shadow: 0 4px 16px rgba(15,23,42,0.08); }
  .card-header { display: flex; gap: 0.75rem; align-items: flex-start; flex-wrap: wrap; }
  .card-name { font-weight: 600; font-size: 0.95rem; }
  .card-email { color: #64748b; font-size: 0.85rem; }
  .card-subject { font-size: 0.85rem; color: #334155; margin-top: 0.25rem; }
  .card-preview { font-size: 0.82rem; color: #64748b; margin-top: 0.5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 0.72rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 999px; margin-left: auto; }
  .badge.received { background: #dbeafe; color: #1d4ed8; }
  .badge.processed { background: #dcfce7; color: #16a34a; }
  .badge.processing { background: #fef9c3; color: #ca8a04; }
  .badge.failed { background: #fee2e2; color: #dc2626; }
  .date { font-size: 0.75rem; color: #94a3b8; margin-top: 0.25rem; }
  .empty { text-align: center; padding: 3rem; color: #94a3b8; }
  .loading { text-align: center; padding: 3rem; color: #64748b; }
  .refresh { background: transparent; border: 1px solid #e2e8f0; padding: 0.5rem 1rem; border-radius: 999px; font-size: 0.85rem; cursor: pointer; margin-bottom: 1rem; }
  .refresh:hover { background: #f1f5f9; }
  /* Detail modal */
  .overlay { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.5); z-index: 100; }
  .overlay.open { display: flex; align-items: flex-start; justify-content: center; padding: 2rem 1rem; overflow-y: auto; }
  .modal { background: white; border-radius: 1rem; padding: 1.5rem; max-width: 640px; width: 100%; position: relative; }
  .modal-close { position: absolute; top: 1rem; right: 1rem; background: transparent; border: none; font-size: 1.2rem; cursor: pointer; color: #64748b; }
  .modal h2 { font-size: 1.1rem; margin-bottom: 1rem; padding-right: 2rem; }
  .field { margin-bottom: 0.75rem; }
  .field-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 0.2rem; }
  .field-value { font-size: 0.9rem; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>

<div id="loginView">
  <div id="login">
    <h2>RO IT Systems — Admin</h2>
    <input type="password" id="tokenInput" placeholder="Admin token" autocomplete="current-password" />
    <button onclick="doLogin()">Sign in</button>
    <div class="error" id="loginError"></div>
  </div>
</div>

<div id="appView" style="display:none">
  <div class="header">
    <h1>RO IT Systems — Contact Messages</h1>
    <button class="logout" onclick="doLogout()">Sign out</button>
  </div>
  <div class="container">
    <button class="refresh" onclick="loadMessages()">↻ Refresh</button>
    <div id="messageList"><div class="loading">Loading…</div></div>
  </div>
</div>

<div class="overlay" id="detailOverlay" onclick="closeDetail(event)">
  <div class="modal" id="detailModal">
    <button class="modal-close" onclick="closeDetail()">✕</button>
    <div id="detailContent"></div>
  </div>
</div>

<script>
let token = sessionStorage.getItem('admin_token') || '';

function doLogin() {
  const t = document.getElementById('tokenInput').value.trim();
  if (!t) return;
  token = t;
  sessionStorage.setItem('admin_token', token);
  document.getElementById('loginError').textContent = '';
  loadMessages();
}

function doLogout() {
  token = '';
  sessionStorage.removeItem('admin_token');
  document.getElementById('appView').style.display = 'none';
  document.getElementById('loginView').style.display = '';
}

document.getElementById('tokenInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    doLogout();
    document.getElementById('loginError').textContent = 'Invalid token.';
    throw new Error('401');
  }
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

async function loadMessages() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('appView').style.display = '';
  document.getElementById('messageList').innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await api('/api/admin/messages');
    const msgs = data.messages;
    if (!msgs.length) {
      document.getElementById('messageList').innerHTML = '<div class="empty">No messages yet.</div>';
      return;
    }
    document.getElementById('messageList').innerHTML = msgs.map(m => \`
      <div class="card" onclick="showDetail('\${m._id}')">
        <div class="card-header">
          <div>
            <div class="card-name">\${esc(m.name)}</div>
            <div class="card-email">\${esc(m.email)}\${m.company ? ' \xb7 ' + esc(m.company) : ''}</div>
          </div>
          <span class="badge \${m.status}">\${m.status}</span>
        </div>
        <div class="card-subject">\${esc(m.subject)}</div>
        <div class="card-preview">\${esc(m.message)}</div>
        <div class="date">\${formatDate(m.created_at)}</div>
      </div>
    \`).join('');
  } catch (e) {
    if (e.message !== '401') {
      document.getElementById('messageList').innerHTML = '<div class="empty">Failed to load messages.</div>';
    }
  }
}

async function showDetail(id) {
  document.getElementById('detailContent').innerHTML = '<div class="loading">Loading…</div>';
  document.getElementById('detailOverlay').classList.add('open');
  try {
    const m = await api('/api/admin/messages/' + id);
    const fields = [
      ['Name', m.name], ['Email', m.email], ['Organisation', m.company],
      ['Subject', m.subject], ['Budget', m.budget], ['Timeline', m.timeline],
      ['Message', m.message], ['Source page', m.source_page],
      ['Status', m.status], ['Received', formatDate(m.created_at)],
    ];
    document.getElementById('detailContent').innerHTML =
      '<h2>' + esc(m.subject) + '</h2>' +
      fields.filter(([,v]) => v).map(([l,v]) =>
        '<div class="field"><div class="field-label">' + l + '</div><div class="field-value">' + esc(v) + '</div></div>'
      ).join('');
  } catch (e) {
    if (e.message !== '401') {
      document.getElementById('detailContent').innerHTML = '<div class="empty">Failed to load message.</div>';
    }
  }
}

function closeDetail(e) {
  if (e && e.target !== document.getElementById('detailOverlay')) return;
  document.getElementById('detailOverlay').classList.remove('open');
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Auto-login if token already in session
if (token) loadMessages();
</script>
</body>
</html>`;

export { ADMIN_HTML };

export const adminRoutes: FastifyPluginAsync = async (server) => {
  server.get('/messages', adminRateLimit, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const messages = await listMessages();
    return { messages };
  });

  server.get('/messages/:id', adminRateLimit, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { id } = (request.params as { id: string });
    try {
      return await getMessage(id);
    } catch {
      return reply.status(404).send({ error: 'Message not found' });
    }
  });
};
