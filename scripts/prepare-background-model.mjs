import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Fixed upstream model and checksum published by rembg's BiRefNetSessionGeneralLite.
const source =
  'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx';
const checksum = '4fab47adc4ff364be1713e97b7e66334';
const destination = resolve(
  process.env.BACKGROUND_REMOVAL_MODEL_PATH ||
    '.models/birefnet-general-lite.onnx',
);
const hashFile = async (path) => {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
try {
  if ((await hashFile(destination)) === checksum) {
    console.log('Background removal model is ready.');
    process.exit(0);
  }
} catch {
  /* Provision missing or invalid local model. */
}
await mkdir(dirname(destination), { recursive: true });
const temporary = destination + '.download-' + process.pid;
try {
  console.log('Downloading BiRefNet General Lite foreground model...');
  const response = await fetch(source, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error('Model download failed');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  if ((await hashFile(temporary)) !== checksum)
    throw new Error('Model checksum mismatch');
  await rename(temporary, destination);
  console.log('Background removal model downloaded and verified.');
} finally {
  await rm(temporary, { force: true });
}
