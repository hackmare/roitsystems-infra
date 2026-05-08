import { connect } from 'nats';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const TIMEOUT_MS = 30000;

async function convertSocialPreview() {
  const svgPath = resolve('../roitsystems.ca/public/images/social-preview.svg');
  const pngPath = resolve('../roitsystems.ca/public/images/social-preview.png');

  try {
    console.log(`Reading ${svgPath}...`);
    const svgBuffer = await readFile(svgPath);
    const base64Svg = svgBuffer.toString('base64');

    console.log(`Connecting to NATS at ${NATS_URL}...`);
    const nc = await connect({ servers: NATS_URL });

    console.log(`Sending conversion request to image.convert...`);
    const request = {
      format_in: 'svg',
      format_out: 'png',
      data: base64Svg
    };

    const response = await nc.request(
      'image.convert',
      new TextEncoder().encode(JSON.stringify(request)),
      { timeout: TIMEOUT_MS }
    );

    const result = JSON.parse(new TextDecoder().decode(response.data));

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
