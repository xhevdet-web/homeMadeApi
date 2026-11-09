/** IPC messages between the worker supervisor and its job process. */
export interface JobRequest {
  type: 'job';
  id: number;
  image: Uint8Array;
}

export type JobResponse =
  | { type: 'rss'; rss: number }
  | { type: 'result'; id: number; ok: true; image: Uint8Array | null }
  | { type: 'result'; id: number; ok: false; status: number; message: string };
