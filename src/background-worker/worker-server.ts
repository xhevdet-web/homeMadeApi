import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { MAX_IMAGE_BYTES } from '../storage/image-limits.js';
import type { BackgroundRemovalWorker } from './background-removal-worker.js';
import { PROCESSING_FAILED, WorkerError } from './worker-error.js';

export const REMOVE_BACKGROUND_PATH = '/v1/remove-background';

export interface WorkerServerOptions {
  /** Shared secret the API sends as `Authorization: Bearer <token>`; optional on loopback. */
  token?: string;
}

/**
 * HTTP front of the worker.
 *
 * POST /v1/remove-background, raw image body:
 *   200 image/png (the foreground), 204 (store the original unchanged), or JSON { statusCode, message }.
 * GET /health: queue and process state.
 */
export function createWorkerServer(
  worker: Pick<BackgroundRemovalWorker, 'run' | 'status'>,
  options: WorkerServerOptions = {},
): Server {
  const expected = options.token ? digest(options.token) : undefined;
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://worker').pathname;
    if (request.method === 'GET' && path === '/health')
      return json(response, 200, { status: 'ok', ...worker.status() });
    if (path !== REMOVE_BACKGROUND_PATH)
      return json(response, 404, { statusCode: 404, message: 'Not found' });
    if (request.method !== 'POST')
      return json(response, 405, { statusCode: 405, message: 'Use POST' });
    if (expected) {
      const header = request.headers.authorization ?? '';
      const supplied = digest(header.replace(/^Bearer\s+/i, ''));
      if (!header.startsWith('Bearer ') || !timingSafeEqual(supplied, expected))
        return json(response, 401, {
          statusCode: 401,
          message: 'Unauthorized',
        });
    }
    void handle(worker, request, response);
  });
}

async function handle(
  worker: Pick<BackgroundRemovalWorker, 'run'>,
  request: IncomingMessage,
  response: ServerResponse,
) {
  // The API timed out or the browser went away: drop the job instead of finishing it for nobody.
  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  try {
    const body = await readBody(request);
    const { image } = await worker.run(body, controller.signal);
    if (response.destroyed) return;
    if (!image) {
      response.writeHead(204).end();
      return;
    }
    response
      .writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': image.length,
      })
      .end(image);
  } catch (error) {
    if (response.destroyed || response.headersSent) return;
    const status = error instanceof WorkerError ? error.status : 500;
    json(response, status, {
      statusCode: status,
      message: error instanceof WorkerError ? error.message : PROCESSING_FAILED,
    });
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (declared > MAX_IMAGE_BYTES) {
    request.resume();
    throw new WorkerError(413, 'Image must be at most 5 MB');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES)
      throw new WorkerError(413, 'Image must be at most 5 MB');
    chunks.push(chunk);
  }
  if (!size) throw new WorkerError(400, 'An image file is required');
  return Buffer.concat(chunks, size);
}

function json(response: ServerResponse, status: number, body: object) {
  const text = JSON.stringify(body);
  response
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    })
    .end(text);
}

const digest = (value: string) => createHash('sha256').update(value).digest();
