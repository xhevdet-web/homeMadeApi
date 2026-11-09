// Test double for job-process.js: same IPC protocol, no model. The image bytes are a command.
//   ok:<text>      returns <text> reversed as the image, after FAKE_DELAY_MS
//   transparent    returns image: null (store the original)
//   reject         returns a 400 WorkerError
//   hang           never answers
//   crash          exits with code 1
//   memory         reports 10 GB resident memory and never answers
//   foreground     returns a small valid PNG (for HTTP tests that upload real images)
// FAKE_MODE overrides the command, so end-to-end tests can upload real images.
const FOREGROUND = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4//9/Az7MMDIUAABUZd9Bgp/b1QAAAABJRU5ErkJggg==',
  'base64',
);
const delay = Number(process.env.FAKE_DELAY_MS) || 0;
const send = (message) => process.send(message);
send({ type: 'rss', rss: 50 * 1024 * 1024 });

process.on('message', (message) => {
  if (message?.type !== 'job') return;
  const command =
    process.env.FAKE_MODE || Buffer.from(message.image).toString();
  const started = Date.now();
  if (command === 'crash') process.exit(1);
  if (command === 'hang') return;
  if (command === 'memory') {
    setInterval(() => send({ type: 'rss', rss: 10 * 1024 ** 3 }), 20);
    return;
  }
  setTimeout(() => {
    if (command === 'reject')
      return send({
        type: 'result',
        id: message.id,
        ok: false,
        status: 400,
        message: 'No foreground detected; please upload another photo',
      });
    if (command === 'foreground')
      return send({
        type: 'result',
        id: message.id,
        ok: true,
        image: FOREGROUND,
      });
    if (command === 'transparent')
      return send({ type: 'result', id: message.id, ok: true, image: null });
    const text = command.replace(/^ok:/, '');
    // pid and timings let tests check process reuse and one-at-a-time execution.
    const image = Buffer.from(
      JSON.stringify({
        result: [...text].reverse().join(''),
        pid: process.pid,
        started,
        finished: Date.now(),
      }),
    );
    send({ type: 'result', id: message.id, ok: true, image });
  }, delay);
});
process.on('disconnect', () => process.exit(0));
