#!/usr/bin/env node
/**
 * Reprocess contact messages since a specific UTC timestamp
 * Usage: node reprocess-contacts.js "2026-05-08T08:01:00Z"
 */

import { connect } from 'nats';
import fetch from 'node-fetch';

const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const COUCHDB_URL = process.env.COUCHDB_URL || 'http://couchdb:5984';
const COUCHDB_USER = process.env.COUCHDB_USER || 'admin';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'password';

const since = process.argv[2];

if (!since) {
  console.error('Usage: node reprocess-contacts.js "2026-05-08T08:01:00Z"');
  console.error('Argument must be a UTC datetime string (ISO 8601 format)');
  process.exit(1);
}

// Validate ISO 8601 format
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since)) {
  console.error('Error: Invalid datetime format. Use ISO 8601 UTC format: YYYY-MM-DDTHH:MM:SSZ');
  process.exit(1);
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

    const response = await fetch(`${COUCHDB_URL}/contact_messages/_find`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      throw new Error(`CouchDB error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
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
