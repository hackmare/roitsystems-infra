import { connect } from 'nats';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID } from 'crypto';

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const TIMEOUT_MS = 30000;

async function convertSocialPreview() {
  const svgPath = resolve('../roitsystems.ca/public/images/social-preview.svg');
  const pngPath = resolve('../roitsystems.ca/public/images/social-preview.png');
  const transactionId = randomUUID();

  try {
    console.log(`Reading ${svgPath}...`);
    const svgBuffer = await readFile(svgPath);
    const base64Svg = svgBuffer.toString('base64');

    console.log(`Connecting to NATS at ${NATS_URL}...`);
    const nc = await connect({ servers: NATS_URL });

    // Subscribe to image.ready before publishing request
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for conversion (${TIMEOUT_MS}ms)`));
      }, TIMEOUT_MS);

      const sub = nc.subscribe('image.ready');
      (async () => {
        for await (const msg of sub) {
          const result = JSON.parse(new TextDecoder().decode(msg.data));
          if (result.transaction_id === transactionId) {
            clearTimeout(timeout);
            sub.unsubscribe();
            resolve(result);
            break;
          }
        }
      })();
    });

    console.log(`Sending conversion request to image.convert (transaction: ${transactionId})...`);
    const request = {
      transaction_id: transactionId,
      format_in: 'svg',
      format_out: 'png',
      data: base64Svg
    };

    nc.publish('image.convert', new TextEncoder().encode(JSON.stringify(request)));

    const result = await responsePromise;

    if (!result.success) {
      console.error(`Conversion failed: ${result.error}`);
      process.exit(1);
    }

    const pngBuffer = Buffer.from(result.data, 'base64');
    console.log(`Writing ${pngPath} (${pngBuffer.length} bytes)...`);
    await writeFile(pngPath, pngBuffer);

    console.log(`✓ Successfully converted social-preview.svg to social-preview.png`);
    await nc.close();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

convertSocialPreview();
