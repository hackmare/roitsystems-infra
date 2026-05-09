import { connect } from 'nats';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(unlink);

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const log = (level, msg, data) => {
  const entry = { timestamp: new Date().toISOString(), level, msg, ...data };
  console.log(JSON.stringify(entry));
};

async function main() {
  const nc = await connect({ servers: NATS_URL });
  log('info', 'Connected to NATS');

  const sub = nc.subscribe('image.convert');

  const handleShutdown = async () => {
    log('info', 'SIGTERM received, gracefully closing');
    await nc.drain();
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);

  try {
    for await (const msg of sub) {
      (async () => {
        try {
          const request = JSON.parse(new TextDecoder().decode(msg.data));
          const { transaction_id, format_in, format_out, data: base64Data, params = {} } = request;

          if (!transaction_id || !base64Data || !format_in || !format_out) {
            const error = 'Missing required fields: transaction_id, data, format_in, format_out';
            log('warn', 'Invalid request', { transaction_id, error });
            nc.publish('image.ready', new TextEncoder().encode(
              JSON.stringify({ transaction_id, success: false, error })
            ));
            return;
          }

          // Decode base64 input
          const inputBuffer = Buffer.from(base64Data, 'base64');
          const tmpId = randomUUID();
          const inputPath = join(tmpdir(), `convert-${tmpId}-input.${format_in}`);
          const outputPath = join(tmpdir(), `convert-${tmpId}-output.${format_out}`);

          try {
            // Write input file
            await writeFile(inputPath, inputBuffer);

            // Build ImageMagick convert command with parameters
            const args = ['-density', String(params.density || 72)];

            // Input file (use [0] to select first frame for multi-frame images)
            args.push(`${inputPath}[0]`);

            // Resize with aspect ratio lock if specified
            if (params.width || params.height) {
              const w = params.width || '';
              const h = params.height || '';
              const lockAR = params.lockAspectRatio ? '' : '!';
              args.push('-resize', `${w}x${h}${lockAR}`);
            }

            // Rotate
            if (params.rotate && params.rotate !== 0) {
              args.push('-rotate', String(params.rotate));
            }

            // Trim whitespace
            if (params.trim) {
              args.push('-trim');
            }

            // Colorspace
            if (params.colorspace && params.colorspace !== 'sRGB') {
              args.push('-colorspace', params.colorspace);
            }

            // Background color (for flattening transparent areas)
            if (params.background) {
              args.push('-background', params.background);
            }

            // Flatten (merge layers and remove transparency)
            if (params.flatten) {
              args.push('-flatten');
            }

            // Blur
            if (params.blur && params.blur > 0) {
              args.push('-blur', `0x${params.blur}`);
            }

            // Sharpen
            if (params.sharpen && params.sharpen > 0) {
              args.push('-sharpen', `0x${params.sharpen}`);
            }

            // Quality (for lossy formats)
            args.push('-quality', String(params.quality || 85));

            // Output format and path
            args.push(outputPath);

            // Run ImageMagick convert
            await execFileAsync('convert', args);

            // Read output file
            let base64Output = '';

            if (format_out.toLowerCase() === 'svg') {
              // For SVG, we need to embed the raster image in an SVG container
              // Convert to PNG first, then wrap in SVG
              const pngPath = join(tmpdir(), `convert-${tmpId}-temp.png`);

              // Re-run convert to generate PNG
              const pngArgs = [...args.slice(0, -1)]; // Remove output path
              pngArgs.push(pngPath);
              await execFileAsync('convert', pngArgs);

              // Read PNG and encode as base64
              const pngBuffer = await readFile(pngPath);
              const pngBase64 = pngBuffer.toString('base64');

              // Get image dimensions
              const identifyResult = await execFileAsync('identify', ['-format', '%wx%h', pngPath]);
              const [width, height] = identifyResult.stdout.split('x').map(Number);

              // Create SVG wrapper
              const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image x="0" y="0" width="${width}" height="${height}" xlink:href="data:image/png;base64,${pngBase64}"/>
</svg>`;

              base64Output = Buffer.from(svgContent).toString('base64');

              // Clean up PNG temp file
              try {
                await unlinkAsync(pngPath);
              } catch (e) {}
            } else {
              const outputBuffer = await readFile(outputPath);
              base64Output = outputBuffer.toString('base64');
            }

            // Publish result with transaction_id
            nc.publish('image.ready', new TextEncoder().encode(
              JSON.stringify({ transaction_id, success: true, data: base64Output })
            ));

            log('info', 'Conversion succeeded', {
              transaction_id,
              format_in,
              format_out,
              input_size: inputBuffer.length,
              output_size: outputBuffer.length
            });
          } finally {
            // Clean up temp files
            try {
              await unlinkAsync(inputPath);
            } catch (e) {
              // File may not exist
            }
            try {
              await unlinkAsync(outputPath);
            } catch (e) {
              // File may not exist
            }
          }
        } catch (err) {
          const error = err.message || String(err);
          log('error', 'Conversion failed', { error });
          // Publish error without transaction_id if it failed to parse
          try {
            nc.publish('image.ready', new TextEncoder().encode(
              JSON.stringify({ success: false, error })
            ));
          } catch (publishErr) {
            log('error', 'Failed to publish error response', { error: publishErr.message });
          }
        }
      })();
    }
  } catch (err) {
    log('error', 'Fatal error', { error: err.message });
    process.exit(1);
  }
}

main().catch(err => {
  log('error', 'Startup failed', { error: err.message });
  process.exit(1);
});
