import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Logger, type INestApplication } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import sharp from 'sharp';
import { CategoriesModule } from '../../src/modules/categories/categories.module.js';
import { SubCategoriesModule } from '../../src/modules/sub-categories/sub-categories.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';
import {
  BackgroundRemovalWorker,
  WORKER_MESSAGES,
} from '../../src/background-worker/background-removal-worker.js';
import { createWorkerServer } from '../../src/background-worker/worker-server.js';
import {
  BACKGROUND_REMOVAL_TIMED_OUT,
  BACKGROUND_REMOVAL_UNAVAILABLE,
} from '../../src/storage/background-removal.service.js';

// What the fake job process returns in "foreground" mode.
const FOREGROUND = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4//9/Az7MMDIUAABUZd9Bgp/b1QAAAABJRU5ErkJggg==',
  'base64',
);
const fakeJobProcess = new URL(
  '../../src/background-worker/testing/fake-job-process.mjs',
  import.meta.url,
);
const id = 'ac78a80a-ce2b-4c45-8076-fca001c71418';

/**
 * Whole path: API → HTTP → worker supervisor → forked job process. The job process is the
 * test double (no model), so failure modes such as crashes, hangs and memory overruns are real.
 */
describe('Background removal through the separate worker', () => {
  let app: INestApplication<App>;
  let token: string;
  let jpeg: Buffer;
  const settings: Record<string, string | undefined> = {};
  const send = vi.spyOn(S3Client.prototype, 'send');
  const puts = () =>
    send.mock.calls
      .map(([command]) => command as unknown)
      .filter((command) => command instanceof PutObjectCommand)
      .map((command) => (command as PutObjectCommand).input);
  const category = { findUnique: vi.fn(), findMany: vi.fn() };
  const subCategory = { create: vi.fn() };
  const config = new ConfigService({
    NODE_ENV: 'test',
    R2_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
    R2_BUCKET_NAME: 'test',
    R2_PUBLIC_URL: 'https://images.example.test',
  });
  const originalGet = config.get.bind(config);

  let running: {
    worker: BackgroundRemovalWorker;
    server: Server;
    hits: number;
  }[] = [];
  const startWorker = async (
    mode: string,
    options: { delayMs?: number; maxRssBytes?: number } = {},
  ) => {
    const worker = new BackgroundRemovalWorker({
      jobProcessPath: fakeJobProcess,
      idleMs: 0,
      maxRssBytes: options.maxRssBytes,
      env: {
        ...process.env,
        FAKE_MODE: mode,
        FAKE_DELAY_MS: String(options.delayMs ?? 0),
      },
    });
    const server = createWorkerServer(worker);
    const entry = { worker, server, hits: 0 };
    server.on('request', (incoming: { url?: string }) => {
      if (incoming.url?.startsWith('/v1/')) entry.hits++;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    settings.BACKGROUND_REMOVAL_WORKER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    running.push(entry);
    return entry;
  };

  const createDesign = (removeBackground?: 'true' | 'false') => {
    const call = request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .auth(token, { type: 'bearer' })
      .field('name', 'Pearl')
      .field('categoryId', id);
    if (removeBackground) call.field('removeBackground', removeBackground);
    return call.attach('file', jpeg, 'pearl.jpg');
  };

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'background-tests-only-secret-at-least-32-characters',
    );
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jpeg = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    vi.spyOn(config, 'get').mockImplementation((key: string) =>
      key in settings ? settings[key] : originalGet(key),
    );
    const module = await Test.createTestingModule({
      imports: [CategoriesModule, SubCategoriesModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(PrismaService)
      .useValue({
        category,
        subCategory,
        user: {
          findUnique: async () => ({ id, role: 'ADMIN', isActive: true }),
        },
      })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    // Listen for real, so concurrent requests share one server like production.
    await app.listen(0, '127.0.0.1');
    token = await module
      .get(JwtService)
      .signAsync({ sub: id, tokenUse: 'access' });
  });
  beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
    settings.BACKGROUND_REMOVAL_ENABLED = 'true';
    send.mockReset().mockResolvedValue({} as never);
    category.findUnique.mockReset().mockResolvedValue({
      id,
      name: 'Necklaces',
      builderType: null,
      builderConfig: null,
    });
    category.findMany
      .mockReset()
      .mockResolvedValue([{ id, name: 'Necklaces' }]);
    subCategory.create
      .mockReset()
      .mockImplementation(async ({ data }: { data: object }) => ({
        id,
        ...data,
      }));
  });
  afterEach(async () => {
    for (const { worker, server } of running) {
      await worker.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    running = [];
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('stores the upload unchanged and never contacts the worker when BACKGROUND_REMOVAL_ENABLED=false', async () => {
    const worker = await startWorker('foreground');
    settings.BACKGROUND_REMOVAL_ENABLED = 'false';
    const response = await createDesign('true').expect(201);
    expect(worker.hits).toBe(0);
    expect(worker.worker.status().processRunning).toBe(false);
    const [stored, ...rest] = puts();
    expect(rest).toEqual([]);
    expect(stored.Body).toEqual(jpeg);
    expect(stored.ContentType).toBe('image/jpeg');
    expect(response.body.imageKey).toMatch(
      /^subcategories\/[0-9a-f-]{36}\.jpg$/,
    );
    expect(
      subCategory.create.mock.calls[0][0].data.originalImageKey,
    ).toBeUndefined();
  });

  it.each([undefined, 'false'] as const)(
    'treats removeBackground=%s as no removal even when the feature is enabled',
    async (value) => {
      const worker = await startWorker('foreground');
      await createDesign(value).expect(201);
      expect(worker.hits).toBe(0);
      expect(puts().map((input) => input.Body)).toEqual([jpeg]);
    },
  );

  it('removes the background in the worker process when removeBackground=true', async () => {
    const worker = await startWorker('foreground');
    const response = await createDesign('true').expect(201);
    expect(worker.hits).toBe(1);
    expect(worker.worker.status()).toMatchObject({ completed: 1, failed: 0 });
    const [display, original] = puts();
    // Same key layout as before: processed display image plus the untouched original.
    expect(display.Key).toMatch(/^subcategories\/[0-9a-f-]{36}\.png$/);
    expect(display.ContentType).toBe('image/png');
    expect(display.Body).toEqual(FOREGROUND);
    expect(original.Key).toMatch(/^originals\/[0-9a-f-]{36}\.jpg$/);
    expect(original.Body).toEqual(jpeg);
    expect(response.body.imageUrl).toBe(
      'https://images.example.test/' + response.body.imageKey,
    );
  });

  it.each([
    ['crashes', 'crash', {}, WORKER_MESSAGES.crashed],
    [
      'exceeds its memory limit',
      'memory',
      { maxRssBytes: 1024 ** 3 },
      WORKER_MESSAGES.outOfMemory,
    ],
  ])(
    'returns a clear 503 and writes nothing to R2 or the database when the job process %s',
    async (_case, mode, options, message) => {
      await startWorker(mode, options);
      const response = await createDesign('true').expect(503);
      expect(response.body.message).toBe(message);
      expect(send).not.toHaveBeenCalled();
      expect(subCategory.create).not.toHaveBeenCalled();
      // The API survived and keeps working.
      await request(app.getHttpServer()).get('/api/v1/categories').expect(200);
    },
  );

  it('times out with 503, writes nothing and frees the worker for the next job', async () => {
    const { worker } = await startWorker('hang');
    settings.BACKGROUND_REMOVAL_TIMEOUT_MS = '500';
    const response = await createDesign('true').expect(503);
    expect(response.body.message).toBe(BACKGROUND_REMOVAL_TIMED_OUT);
    expect(send).not.toHaveBeenCalled();
    expect(subCategory.create).not.toHaveBeenCalled();
    // The abandoned job is cancelled instead of blocking the single worker slot.
    await vi.waitFor(() => expect(worker.status().busy).toBe(false));
  });

  it('returns 503 when the worker is not running', async () => {
    settings.BACKGROUND_REMOVAL_WORKER_URL = 'http://127.0.0.1:1';
    const response = await createDesign('true').expect(503);
    expect(response.body.message).toBe(BACKGROUND_REMOVAL_UNAVAILABLE);
    expect(send).not.toHaveBeenCalled();
    expect(subCategory.create).not.toHaveBeenCalled();
  });

  it('keeps serving other requests while a background-removal job runs', async () => {
    const { worker } = await startWorker('foreground', { delayMs: 1500 });
    const upload = createDesign('true').then((response) => response);
    await vi.waitFor(() => expect(worker.status().busy).toBe(true), {
      timeout: 5000,
    });
    const started = Date.now();
    await request(app.getHttpServer()).get('/api/v1/categories').expect(200);
    const status = await request(app.getHttpServer())
      .get('/api/v1/images/background-removal')
      .expect(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(status.body).toEqual({ enabled: true, available: true });
    // Still running: the API answered while inference was in progress.
    expect(worker.status().busy).toBe(true);
    const response = await upload;
    expect(response.status).toBe(201);
    expect(puts()[0].Body).toEqual(FOREGROUND);
  });
});
