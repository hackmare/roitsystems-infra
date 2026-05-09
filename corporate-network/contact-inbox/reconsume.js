#!/usr/bin/env node
/**
 * Reconsume a contact message by resetting its status
 * Usage: node reconsume.js <contact_id>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach((line) => {
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=');
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

const contactId = process.argv[2];

if (!contactId) {
  console.error('Usage: node reconsume.js <contact_id>');
  process.exit(1);
}

const COUCHDB_URL = process.env.COUCHDB_URL || 'http://couchdb:5984';
const COUCHDB_USER = process.env.COUCHDB_USER || 'admin';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'password';

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${COUCHDB_USER}:${COUCHDB_PASSWORD}`).toString('base64');
    const url = new URL(COUCHDB_URL + path);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  try {
    console.log(`Fetching contact ${contactId}...`);

    // Get the contact
    const getRes = await httpRequest('GET', `/contact_messages/${contactId}`);

    if (getRes.status !== 200) {
      console.error(`Error: Contact not found (${getRes.status})`);
      process.exit(1);
    }

    const contact = getRes.data;
    console.log(`Found: ${contact.email} (${contact.name})`);
    console.log(`Current status: ${contact.status}`);

    // Reset status to "received" so worker picks it up
    contact.status = 'received';
    contact.updated_at = new Date().toISOString();

    const updateRes = await httpRequest('PUT', `/contact_messages/${contactId}`, contact);

    if (updateRes.status >= 200 && updateRes.status < 300) {
      console.log(`✓ Status reset to "received"`);
      console.log(`Worker will pick this up and republish to notification service`);
      console.log('Check back in 30 seconds for the email');
    } else {
      console.error(`Error updating contact: ${updateRes.status}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
