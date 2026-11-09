import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { JobRequest, JobResponse } from './protocol.js';
import { WorkerError } from './worker-error.js';

export const WORKER_MESSAGES = {
  busy: 'Background removal is busy; please try again in a minute',
  timedOut:
    'Background removal timed out; please try again or upload without background removal',
  outOfMemory:
    'Background removal ran out of memory; please try a smaller photo or upload without background removal',
  crashed:
    'Background removal stopped unexpectedly; please try again or upload without background removal',
  cancelled: 'Background removal was cancelled',
  shuttingDown: 'Background removal is restarting; please try again shortly',
} as const;

export interface WorkerOptions {
  /** Script forked for inference (dist/background-worker/job-process.js in production). */
  jobProcessPath: string | URL;
  /** Upper bound for one image, after which the job process is killed. */
  jobTimeoutMs?: number;
  /** Resident memory of the job process above which it is killed. */
  maxRssBytes?: number;
  /** Jobs allowed to wait behind the running one. */
  maxQueue?: number;
  /** Idle time after which the job process (and the model in memory) is released; 0 keeps it. */
  idleMs?: number;
  /** After a job, a process still above this resident memory is replaced by a fresh one. */
  recycleAboveRssBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** `image: null` means the original upload must be stored unchanged. */
export interface JobResult {
  image: Buffer | null;
}

interface Job {
  id: number;
  image: Buffer;
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
  settled?: boolean;
  timer?: NodeJS.Timeout;
  memoryTimer?: NodeJS.Timeout;
  detach?: () => void;
}

/**
 * Runs background removal one image at a time in a disposable child process.
 * Timeouts, memory overruns and crashes kill only that child; the next job gets a fresh one.
 */
export class BackgroundRemovalWorker {
  private child?: ChildProcess;
  private active?: Job;
  private readonly queue: Job[] = [];
  private nextId = 1;
  private reportedRss = 0;
  private peakRss = 0;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly stats = { completed: 0, failed: 0, restarts: 0 };
  private readonly jobTimeoutMs: number;
  private readonly maxRssBytes: number;
  private readonly maxQueue: number;
  private readonly idleMs: number;
  private readonly recycleAboveRssBytes: number;

  constructor(private readonly options: WorkerOptions) {
    this.jobTimeoutMs = options.jobTimeoutMs ?? 150_000;
    this.maxRssBytes = options.maxRssBytes ?? 6 * 1024 ** 3;
    this.maxQueue = options.maxQueue ?? 2;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.recycleAboveRssBytes = options.recycleAboveRssBytes ?? 1024 ** 3;
  }

  run(image: Buffer, signal?: AbortSignal): Promise<JobResult> {
    if (this.closed)
      return Promise.reject(new WorkerError(503, WORKER_MESSAGES.shuttingDown));
    if (signal?.aborted)
      return Promise.reject(new WorkerError(503, WORKER_MESSAGES.cancelled));
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new WorkerError(503, WORKER_MESSAGES.busy));
    return new Promise<JobResult>((resolve, reject) => {
      const job: Job = { id: this.nextId++, image, resolve, reject };
      if (signal) {
        // A caller that gave up must not keep the single worker slot busy.
        const cancel = () =>
          this.fail(job, new WorkerError(503, WORKER_MESSAGES.cancelled));
        signal.addEventListener('abort', cancel, { once: true });
        job.detach = () => signal.removeEventListener('abort', cancel);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  status() {
    return {
      busy: !!this.active,
      queued: this.queue.length,
      processRunning: !!this.child,
      processRssMb: Math.round(this.reportedRss / 1024 ** 2),
      peakRssMb: Math.round(this.peakRss / 1024 ** 2),
      ...this.stats,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])])
      this.settle(job, new WorkerError(503, WORKER_MESSAGES.shuttingDown));
    this.stopChild();
  }

  private pump() {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return this.scheduleIdle();
    clearTimeout(this.idleTimer);
    this.active = job;
    const child = this.spawn();
    job.timer = setTimeout(
      () => this.fail(job, new WorkerError(504, WORKER_MESSAGES.timedOut)),
      this.jobTimeoutMs,
    );
    job.memoryTimer = setInterval(() => this.checkMemory(), 250);
    const request: JobRequest = { type: 'job', id: job.id, image: job.image };
    child.send(request, (error) => {
      if (error) this.fail(job, new WorkerError(503, WORKER_MESSAGES.crashed));
    });
  }

  private spawn(): ChildProcess {
    if (this.child?.connected) return this.child;
    this.stopChild();
    const child = fork(this.options.jobProcessPath, [], {
      serialization: 'advanced',
      env: this.options.env ?? process.env,
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    child.on('message', (message: JobResponse) => {
      if (this.child !== child) return;
      if (message.type === 'rss') {
        this.reportedRss = message.rss;
        this.peakRss = Math.max(this.peakRss, message.rss);
        return this.checkMemory();
      }
      const job = this.active;
      if (message.type !== 'result' || !job || job.id !== message.id) return;
      // The allocator may keep inference memory after a run; a fresh process (the model loads
      // in ~1 s) hands it back to the OS. Done before settling, which starts the next job.
      if (
        Math.max(this.reportedRss, linuxRss(child.pid)) >
        this.recycleAboveRssBytes
      )
        this.stopChild();
      if (message.ok) {
        this.stats.completed++;
        this.settle(job, {
          image: message.image
            ? Buffer.from(
                message.image.buffer,
                message.image.byteOffset,
                message.image.byteLength,
              )
            : null,
        });
      } else this.settle(job, new WorkerError(message.status, message.message));
    });
    const lost = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.reportedRss = 0;
      if (this.active) {
        this.stats.restarts++;
        this.settle(this.active, new WorkerError(503, WORKER_MESSAGES.crashed));
      }
    };
    child.once('exit', lost);
    child.once('error', () => {
      lost();
      child.kill('SIGKILL');
    });
    return child;
  }

  private checkMemory() {
    const job = this.active;
    const child = this.child;
    if (!job || !child) return;
    const rss = Math.max(this.reportedRss, linuxRss(child.pid));
    if (rss > this.maxRssBytes) {
      console.error(
        `Background removal job process exceeded ${Math.round(this.maxRssBytes / 1024 ** 2)} MB (rss ${Math.round(rss / 1024 ** 2)} MB); restarting it`,
      );
      this.fail(job, new WorkerError(503, WORKER_MESSAGES.outOfMemory));
    }
  }

  /** Fails a job; a running one also loses its process, since inference cannot be interrupted. */
  private fail(job: Job, error: WorkerError) {
    if (job.settled) return;
    if (this.active === job) {
      this.stats.restarts++;
      this.stopChild();
    }
    this.settle(job, error);
  }

  private settle(job: Job, outcome: JobResult | Error) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    clearInterval(job.memoryTimer);
    job.detach?.();
    if (this.active === job) this.active = undefined;
    else {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
    }
    if (outcome instanceof Error) {
      this.stats.failed++;
      job.reject(outcome);
    } else job.resolve(outcome);
    this.pump();
  }

  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (!this.child || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.active && !this.queue.length) this.stopChild();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private stopChild() {
    const child = this.child;
    this.child = undefined;
    this.reportedRss = 0;
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
}

/** Reads resident memory from /proc, which works even while the child's event loop is busy. */
function linuxRss(pid: number | undefined): number {
  if (process.platform !== 'linux' || !pid) return 0;
  try {
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(
      readFileSync(`/proc/${pid}/status`, 'utf8'),
    );
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}
