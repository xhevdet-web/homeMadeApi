/** An error whose status and message are safe to return to the API. */
export class WorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

export const PROCESSING_FAILED =
  'Image processing failed; please try another photo';
