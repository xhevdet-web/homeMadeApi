/**
 * Child process forked by the worker supervisor. It is the only process that loads ONNX
 * Runtime and the BiRefNet model; the supervisor kills it on timeout, memory overrun or
 * idleness, which returns all native memory to the operating system.
 */
import { writeFileSync } from 'node:fs';
import { ForegroundProcessor } from './foreground-processor.js';
import { ForegroundSegmenter } from './foreground-segmenter.js';
import { PROCESSING_FAILED, WorkerError } from './worker-error.js';
import type { JobRequest, JobResponse } from './protocol.js';

if (!process.send) {
  console.error('job-process must be started by the background-removal worker');
  process.exit(1);
}

// If the machine runs short of memory anyway, the kernel should kill this process first,
// never the API. Raising one's own score needs no privileges.
if (process.platform === 'linux')
  try {
    writeFileSync('/proc/self/oom_score_adj', '1000');
  } catch {
    /* Not fatal: systemd MemoryMax and the supervisor's RSS limit still apply. */
  }

const send = (message: JobResponse) => process.send?.(message);
const segmenter = new ForegroundSegmenter({
  modelPath: process.env.BACKGROUND_REMOVAL_MODEL_PATH,
  threads: Number(process.env.BACKGROUND_REMOVAL_THREADS) || 2,
});
const processor = new ForegroundProcessor(segmenter);

// Self-reported memory. Inference blocks this process's event loop, so reports pause during
// a run; on Linux the supervisor also reads /proc/<pid>/status, which keeps working then.
const report = () => send({ type: 'rss', rss: process.memoryUsage.rss() });
setInterval(report, 200).unref();

process.on('message', (message: JobRequest) => {
  if (message?.type !== 'job') return;
  report();
  const input = Buffer.from(
    message.image.buffer,
    message.image.byteOffset,
    message.image.byteLength,
  );
  processor.process(input).then(
    ({ image }) => send({ type: 'result', id: message.id, ok: true, image }),
    (error: unknown) =>
      send({
        type: 'result',
        id: message.id,
        ok: false,
        // Only messages written for users leave this process; native details stay here.
        status: error instanceof WorkerError ? error.status : 500,
        message:
          error instanceof WorkerError ? error.message : PROCESSING_FAILED,
      }),
  );
});
process.on('disconnect', () => process.exit(0));
