import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp from 'sharp';
import {
  BACKGROUND_REMOVAL_BUSY,
  BACKGROUND_REMOVAL_TIMED_OUT,
  BACKGROUND_REMOVAL_UNAVAILABLE,
  BackgroundRemovalService,
} from './background-removal.service.js';
import { createWorkerServer } from '../background-worker/worker-server.js';
import { WorkerError } from '../background-worker/worker-error.js';
import type { BackgroundRemovalWorker } from '../background-worker/background-removal-worker.js';

const jpeg = await sharp({
  create: { width: 16, height: 16, channels: 3, background: 'white' },
})
  .jpeg()
  .toBuffer();
const png = await sharp({
  create: {
    width: 8,
    height: 8,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .png()
  .toBuffer();
const upload = () =>
  ({
    buffer: jpeg,
    size: jpeg.length,
    mimetype: 'image/jpeg',
    originalname: 'photo.jpg',
  }) as Express.Multer.File;

describe('BackgroundRemovalService (API side)', () => {
  const run = vi.fn<BackgroundRemovalWorker['run']>();
  let server: Server;
  let workerUrl: string;
  let env: Record<string, string>;
  const service = () => new BackgroundRemovalService(new ConfigService(env));
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

  beforeAll(async () => {
    server = createWorkerServer(
      { run, status: () => ({}) as never },
      { token: 'shared-secret' },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    workerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    run.mockReset().mockResolvedValue({ image: png });
    env = {
      BACKGROUND_REMOVAL_ENABLED: 'true',
      BACKGROUND_REMOVAL_WORKER_URL: workerUrl,
      BACKGROUND_REMOVAL_WORKER_TOKEN: 'shared-secret',
    };
  });

  describe('when BACKGROUND_REMOVAL_ENABLED is false or unset', () => {
    it.each([undefined, 'false', '0', ''])(
      'returns the upload unchanged without contacting the worker (%s)',
      async (value) => {
        if (value === undefined) delete env.BACKGROUND_REMOVAL_ENABLED;
        else env.BACKGROUND_REMOVAL_ENABLED = value;
        const file = upload();
        const removal = service();
        expect(removal.enabled).toBe(false);
        expect(removal.shouldRemove(true)).toBe(false);
        expect(await removal.remove(file)).toBe(file);
        expect(run).not.toHaveBeenCalled();
        expect(await removal.status()).toEqual({
          enabled: false,
          available: false,
        });
      },
    );
  });

  it('is opt-in: only an explicit boolean true requests removal', () => {
    const removal = service();
    expect(removal.shouldRemove(true)).toBe(true);
    for (const value of [undefined, null, false, 'true', 1])
      expect(removal.shouldRemove(value)).toBe(false);
  });

  it('sends the image to the worker and returns its PNG foreground', async () => {
    const result = await service().remove(upload());
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual(jpeg);
    expect(result).toMatchObject({
      mimetype: 'image/png',
      originalname: 'foreground.png',
      size: png.length,
    });
    expect(result.buffer).toEqual(png);
  });

  it('keeps the original object when the worker answers 204 (already transparent)', async () => {
    run.mockResolvedValue({ image: null });
    const file = upload();
    expect(await service().remove(file)).toBe(file);
  });

  it('turns photo errors into 400 with the worker message', async () => {
    run.mockRejectedValue(
      new WorkerError(
        400,
        'No foreground detected; please upload another photo',
      ),
    );
    const error = await service()
      .remove(upload())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      'No foreground detected; please upload another photo',
    );
  });

  it.each([
    [503, 'Background removal ran out of memory; please try a smaller photo'],
    [504, 'Background removal timed out; please try again'],
  ])(
    'turns worker status %s into a clear 503 instead of crashing',
    async (status, message) => {
      run.mockRejectedValue(new WorkerError(status, message));
      await expect(service().remove(upload())).rejects.toThrow(
        new ServiceUnavailableException(message),
      );
    },
  );

  it('hides unexpected worker failures behind a generic 503', async () => {
    run.mockRejectedValue(new Error('segfault at 0x0'));
    const error = await service()
      .remove(upload())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(BACKGROUND_REMOVAL_UNAVAILABLE);
  });

  it('returns 503 when the worker is not running', async () => {
    env.BACKGROUND_REMOVAL_WORKER_URL = 'http://127.0.0.1:1';
    await expect(service().remove(upload())).rejects.toThrow(
      new ServiceUnavailableException(BACKGROUND_REMOVAL_UNAVAILABLE),
    );
    expect(await service().status()).toEqual({
      enabled: true,
      available: false,
    });
  });

  it('times out with 503 and cancels the job in the worker', async () => {
    env.BACKGROUND_REMOVAL_TIMEOUT_MS = '200';
    run.mockImplementation(() => new Promise(() => {}));
    await expect(service().remove(upload())).rejects.toThrow(
      new ServiceUnavailableException(BACKGROUND_REMOVAL_TIMED_OUT),
    );
    await vi.waitFor(() => expect(run.mock.calls[0][1]!.aborted).toBe(true));
  });

  it('rejects an invalid image from the worker instead of storing it', async () => {
    run.mockResolvedValue({ image: Buffer.from('not a png') });
    await expect(service().remove(upload())).rejects.toThrow(
      new ServiceUnavailableException(BACKGROUND_REMOVAL_UNAVAILABLE),
    );
  });

  it('reports a token mismatch as unavailable, not as a client error', async () => {
    env.BACKGROUND_REMOVAL_WORKER_TOKEN = 'wrong';
    await expect(service().remove(upload())).rejects.toThrow(
      new ServiceUnavailableException(BACKGROUND_REMOVAL_UNAVAILABLE),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('limits how many uploads wait for the worker at once', async () => {
    env.BACKGROUND_REMOVAL_MAX_PENDING = '1';
    let release!: () => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ image: png });
        }),
    );
    const removal = service();
    const first = removal.remove(upload());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await expect(removal.remove(upload())).rejects.toThrow(
      new ServiceUnavailableException(BACKGROUND_REMOVAL_BUSY),
    );
    release();
    await expect(first).resolves.toMatchObject({ mimetype: 'image/png' });
  });

  it('reports availability from the worker health check', async () => {
    expect(await service().status()).toEqual({
      enabled: true,
      available: true,
    });
  });
});
