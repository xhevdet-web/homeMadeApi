import {
  BackgroundRemovalWorker,
  WORKER_MESSAGES,
  type WorkerOptions,
} from './background-removal-worker.js';

const fake = new URL('./testing/fake-job-process.mjs', import.meta.url);
const command = (text: string) => Buffer.from(text);
const decode = (image: Buffer | null) =>
  JSON.parse(image!.toString()) as {
    result: string;
    pid: number;
    started: number;
    finished: number;
  };

describe('BackgroundRemovalWorker (real child processes, fake model)', () => {
  const workers: BackgroundRemovalWorker[] = [];
  const create = (options: Partial<WorkerOptions> = {}, delayMs = 0) => {
    const worker = new BackgroundRemovalWorker({
      jobProcessPath: fake,
      jobTimeoutMs: 5000,
      idleMs: 0,
      env: { ...process.env, FAKE_DELAY_MS: String(delayMs) },
      ...options,
    });
    workers.push(worker);
    return worker;
  };
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
  });

  it('returns the processed image and reuses one job process', async () => {
    const worker = create();
    const first = decode((await worker.run(command('ok:abc'))).image);
    const second = decode((await worker.run(command('ok:xyz'))).image);
    expect(first.result).toBe('cba');
    expect(second.result).toBe('zyx');
    expect(second.pid).toBe(first.pid);
    expect(worker.status()).toMatchObject({ busy: false, completed: 2 });
  });

  it('keeps the original when the job reports existing transparency', async () => {
    await expect(create().run(command('transparent'))).resolves.toEqual({
      image: null,
    });
  });

  it('processes only one image at a time, in arrival order', async () => {
    const worker = create({}, 150);
    const results = await Promise.all(
      ['ok:1', 'ok:2', 'ok:3'].map((text) => worker.run(command(text))),
    );
    const runs = results.map(({ image }) => decode(image));
    expect(runs.map((run) => run.result)).toEqual(['1', '2', '3']);
    for (let index = 1; index < runs.length; index++)
      expect(runs[index].started).toBeGreaterThanOrEqual(
        runs[index - 1].finished,
      );
  });

  it('rejects jobs beyond the queue limit instead of buffering without bound', async () => {
    const worker = create({ maxQueue: 1 }, 300);
    const running = worker.run(command('ok:a'));
    // Let the first job start so the next one waits in the queue.
    await vi.waitFor(() => expect(worker.status().busy).toBe(true));
    const queued = worker.run(command('ok:b'));
    await expect(worker.run(command('ok:c'))).rejects.toMatchObject({
      status: 503,
      message: WORKER_MESSAGES.busy,
    });
    await expect(running).resolves.toBeDefined();
    await expect(queued).resolves.toBeDefined();
  });

  it('passes photo errors through and keeps the process for the next job', async () => {
    const worker = create();
    const before = decode((await worker.run(command('ok:a'))).image).pid;
    await expect(worker.run(command('reject'))).rejects.toMatchObject({
      status: 400,
      message: 'No foreground detected; please upload another photo',
    });
    expect(decode((await worker.run(command('ok:b'))).image).pid).toBe(before);
  });

  it('fails a crashed job cleanly and starts a fresh process for the next one', async () => {
    const worker = create();
    const before = decode((await worker.run(command('ok:a'))).image).pid;
    await expect(worker.run(command('crash'))).rejects.toMatchObject({
      status: 503,
      message: WORKER_MESSAGES.crashed,
    });
    const after = decode((await worker.run(command('ok:b'))).image);
    expect(after.result).toBe('b');
    expect(after.pid).not.toBe(before);
  });

  it('kills a job that exceeds the timeout so the queue keeps moving', async () => {
    // Generous enough for forking a fresh process for the next job on a loaded machine.
    const worker = create({ jobTimeoutMs: 2000 });
    const hung = worker.run(command('hang'));
    const next = worker.run(command('ok:next'));
    await expect(hung).rejects.toMatchObject({
      status: 504,
      message: WORKER_MESSAGES.timedOut,
    });
    expect(decode((await next).image).result).toBe('txen');
  });

  it('kills a job process that exceeds the memory limit', async () => {
    const worker = create({ maxRssBytes: 1024 ** 3 });
    await expect(worker.run(command('memory'))).rejects.toMatchObject({
      status: 503,
      message: WORKER_MESSAGES.outOfMemory,
    });
    expect(decode((await worker.run(command('ok:a'))).image).result).toBe('a');
  });

  it('drops a job whose caller gave up, so it does not hold the single slot', async () => {
    const worker = create({ jobTimeoutMs: 60_000 });
    const controller = new AbortController();
    const abandoned = worker.run(command('hang'), controller.signal);
    await vi.waitFor(() => expect(worker.status().busy).toBe(true));
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({
      message: WORKER_MESSAGES.cancelled,
    });
    expect(decode((await worker.run(command('ok:a'))).image).result).toBe('a');
  });

  it('releases the job process (and its model memory) when idle', async () => {
    const worker = create({ idleMs: 100 });
    await worker.run(command('ok:a'));
    expect(worker.status().processRunning).toBe(true);
    await vi.waitFor(() => expect(worker.status().processRunning).toBe(false), {
      timeout: 2000,
    });
  });
});
