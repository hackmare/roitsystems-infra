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
          const { transaction_id, format_in, format_out, data: base64Data } = request;

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

            // Run ImageMagick convert
            const convertCmd = `${inputPath}[0]`;
            await execFileAsync('convert', [
              '-density', '300',
              convertCmd,
              '-quality', '85',
              outputPath
            ]);

            // Read output file
            const outputBuffer = await readFile(outputPath);
            const base64Output = outputBuffer.toString('base64');

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
