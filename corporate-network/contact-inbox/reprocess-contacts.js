#!/usr/bin/env node
/**
 * Reprocess contact messages since a specific UTC timestamp
 * Usage: node reprocess-contacts.js "2026-05-08T08:01:00Z"
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Require nats from api/node_modules
const { connect } = require(path.join(__dirname, 'api', 'node_modules', 'nats'));

// Load .env from contact-inbox directory
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

const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const COUCHDB_URL = process.env.COUCHDB_URL || 'http://couchdb:5984';
const COUCHDB_USER = process.env.COUCHDB_USER || 'admin';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'password';

const since = process.argv[2];

if (!since) {
  console.error('Usage: node reprocess-contacts.js "2026-05-08T00:01:00-08:00"');
  console.error('       node reprocess-contacts.js "2026-05-08T08:01:00Z"');
  console.error('Argument must be a datetime string (ISO 8601 format with timezone)');
  process.exit(1);
}

// Validate ISO 8601 format (with Z or timezone offset)
const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
if (!iso8601Regex.test(since)) {
  console.error('Error: Invalid datetime format.');
  console.error('Use ISO 8601 format with timezone:');
  console.error('  UTC: YYYY-MM-DDTHH:MM:SSZ (e.g., 2026-05-08T08:01:00Z)');
  console.error('  PST: YYYY-MM-DDTHH:MM:SS-08:00 (e.g., 2026-05-08T00:01:00-08:00)');
  process.exit(1);
}

function fetchJson(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    client.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject).end(options.body);
  });
}

async function main() {
  try {
    console.log(`Reprocessing contacts since ${since}...`);

    // Connect to NATS
    const nc = await connect({ servers: NATS_URL });
    console.log('✓ Connected to NATS');

    // Query CouchDB for contacts since that time
    const auth = Buffer.from(`${COUCHDB_USER}:${COUCHDB_PASSWORD}`).toString('base64');
    const query = {
      selector: {
        type: 'contact_message',
        created_at: { $gte: since }
      },
      sort: [{ created_at: 'asc' }]
    };

    const body = JSON.stringify(query);
    const result = await fetchJson(`${COUCHDB_URL}/contact_messages/_find`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });

    const contacts = result.docs || [];
    console.log(`Found ${contacts.length} contacts to reprocess`);

    if (contacts.length === 0) {
      console.log('No contacts found for reprocessing');
      await nc.drain();
      process.exit(0);
    }

    // Republish each to NATS
    let published = 0;
    for (const contact of contacts) {
      try {
        nc.publish('contact.messages', JSON.stringify({
          message_id: contact._id,
          email: contact.email,
          timestamp: new Date().toISOString()
        }));
        published++;
        console.log(`  ✓ ${contact._id} (${contact.email})`);
      } catch (err) {
        console.error(`  ✗ ${contact._id}: ${err.message}`);
      }
    }

    console.log(`\n✓ Reprocessed ${published}/${contacts.length} contacts`);
    await nc.drain();
    process.exit(0);
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  }
}

main();
