/**
 * Background-removal worker: `node dist/background-worker/main.js` (pnpm start:worker).
 * Runs separately from the API so ONNX inference can never take the API down.
 */
import 'dotenv/config';
import { BackgroundRemovalWorker } from './background-removal-worker.js';
import { createWorkerServer } from './worker-server.js';

const number = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const host = process.env.BACKGROUND_REMOVAL_WORKER_HOST?.trim() || '127.0.0.1';
const port = number('BACKGROUND_REMOVAL_WORKER_PORT', 4100);
const token = process.env.BACKGROUND_REMOVAL_WORKER_TOKEN?.trim() || undefined;

const worker = new BackgroundRemovalWorker({
  jobProcessPath: new URL('./job-process.js', import.meta.url),
  jobTimeoutMs: number('BACKGROUND_REMOVAL_JOB_TIMEOUT_MS', 150_000),
  // BiRefNet General Lite peaks at ~5.4 GB per image; leave headroom above that.
  maxRssBytes: number('BACKGROUND_REMOVAL_MAX_RSS_MB', 6144) * 1024 ** 2,
  maxQueue: number('BACKGROUND_REMOVAL_MAX_QUEUE', 2),
  idleMs: number('BACKGROUND_REMOVAL_IDLE_MS', 5 * 60_000),
  recycleAboveRssBytes:
    number('BACKGROUND_REMOVAL_RECYCLE_RSS_MB', 1024) * 1024 ** 2,
});
const server = createWorkerServer(worker, { token });

if (!token && !['127.0.0.1', '::1', 'localhost'].includes(host))
  console.warn(
    'BACKGROUND_REMOVAL_WORKER_TOKEN is not set while listening beyond loopback; set a token',
  );

server.listen(port, host, () =>
  console.log(`Background removal worker listening on http://${host}:${port}`),
);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  void worker.close().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
