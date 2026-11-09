import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWorkerServer } from './worker-server.js';
import { WorkerError } from './worker-error.js';
import type { BackgroundRemovalWorker } from './background-removal-worker.js';

describe('Background removal worker HTTP server', () => {
  const run = vi.fn<BackgroundRemovalWorker['run']>();
  const status = vi.fn(() => ({
    busy: false,
    queued: 0,
    processRunning: false,
    completed: 0,
    failed: 0,
    restarts: 0,
  }));
  let server: Server;
  let base: string;
  const start = async (token?: string) => {
    server = createWorkerServer({ run, status }, { token });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    fetch(base + '/v1/remove-background', { method: 'POST', body, headers });
  beforeEach(() => {
    run.mockReset();
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers health checks with the queue state', async () => {
    await start();
    const response = await fetch(base + '/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', busy: false });
  });

  it('returns PNG bytes, or 204 when the original should be kept', async () => {
    await start();
    run.mockResolvedValueOnce({ image: Buffer.from('png-bytes') });
    const processed = await post('input');
    expect(processed.status).toBe(200);
    expect(processed.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await processed.arrayBuffer()).toString()).toBe(
      'png-bytes',
    );
    expect(run.mock.calls[0][0].toString()).toBe('input');
    run.mockResolvedValueOnce({ image: null });
    expect((await post('input')).status).toBe(204);
  });

  it('maps worker errors to their status and hides unexpected details', async () => {
    await start();
    run.mockRejectedValueOnce(new WorkerError(400, 'No foreground detected'));
    const rejected = await post('input');
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      statusCode: 400,
      message: 'No foreground detected',
    });
    run.mockRejectedValueOnce(new Error('native stack at 0xdeadbeef'));
    const failed = await post('input');
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('0xdeadbeef');
  });

  it('requires the shared token when one is configured', async () => {
    await start('worker-secret');
    run.mockResolvedValue({ image: null });
    expect((await post('input')).status).toBe(401);
    expect(
      (await post('input', { Authorization: 'Bearer wrong' })).status,
    ).toBe(401);
    expect(
      (await post('input', { Authorization: 'Bearer worker-secret' })).status,
    ).toBe(204);
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects empty and oversized bodies before queueing a job', async () => {
    await start();
    expect((await post(new Uint8Array(0))).status).toBe(400);
    expect((await post(new Uint8Array(5 * 1024 * 1024 + 1))).status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels the job when the API disconnects', async () => {
    await start();
    run.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const request = fetch(base + '/v1/remove-background', {
      method: 'POST',
      body: 'input',
      signal: controller.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.calls[0][1]!;
    expect(signal.aborted).toBe(false);
    controller.abort();
    await request;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });
});
