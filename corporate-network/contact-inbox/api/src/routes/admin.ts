import { FastifyPluginAsync } from 'fastify';
import { listMessages, getMessage } from '../services/couchdb';
import { requireGoogleAuth } from './auth';

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
    <button onclick="window.location='/auth/login?next=/corporate-network/contact/admin'" style="background: #1f2937; display: flex; align-items: center; justify-content: center; gap: 0.75rem;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path fill="white" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="white" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="white" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="white" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Sign in with Google
    </button>
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
function doLogout() {
  window.location = '/auth/logout';
}

async function api(path) {
  const res = await fetch(path);
  if (res.status === 401) {
    window.location = '/auth/login?next=/corporate-network/contact/admin';
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
    const data = await api('./api/admin/messages');
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
    const m = await api('./api/admin/messages/' + id);
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

// Load messages on page load (session cookie sent automatically by browser)
loadMessages();
</script>
</body>
</html>`;

export { ADMIN_HTML };

export const adminRoutes: FastifyPluginAsync = async (server) => {
  server.get('/messages', async (request, reply) => {
    if (!requireGoogleAuth(request, reply)) return;
    const messages = await listMessages();
    return { messages };
  });

  server.get('/messages/:id', async (request, reply) => {
    if (!requireGoogleAuth(request, reply)) return;
    const { id } = (request.params as { id: string });
    try {
      return await getMessage(id);
    } catch {
      return reply.status(404).send({ error: 'Message not found' });
    }
  });
};
