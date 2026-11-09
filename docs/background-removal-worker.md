# Background removal worker

Background removal (BiRefNet General Lite via ONNX Runtime) runs in a **separate worker
process**, never inside the NestJS API. Before this change the API ran inference itself.
One image could push the API process to ~7 GB, Linux OOM-killed it, every request
returned 503, and browsers reported those failures as CORS errors.

```
browser ──► API (NestJS, dist/main.js)                  never loads ONNX
              │  POST /v1/remove-background (raw image, 127.0.0.1:4100)
              ▼
            worker supervisor (dist/background-worker/main.js)  ~50 MB
              │  FIFO queue, one job at a time, timeout + RSS watchdog
              ▼  fork + IPC
            job process (dist/background-worker/job-process.js)  ~5.4 GB peak
              loads the model, runs inference; killed on timeout, memory
              overrun or idleness, then started fresh for the next job
```

## Behaviour

- **Off unless enabled.** With `BACKGROUND_REMOVAL_ENABLED` unset or `false`, every upload
  is stored unchanged and the API never contacts the worker. No model loads anywhere,
  even if the worker is running.
- **Opt-in per upload.** Only `removeBackground: true` (multipart `"true"`) requests
  removal, on categories, sub-categories and products. A missing field means `false`.
  The admin UI checkbox defaults to off.
- **The API stays responsive.** The upload request waits for its own result (up to
  `BACKGROUND_REMOVAL_TIMEOUT_MS`). All other requests are served normally meanwhile,
  because the work happens in another process.
- **Failures fail only that upload, cleanly.** Removal runs before anything is written to
  R2 or the database, and the existing safe-write flow deletes any object already uploaded
  in the same request. Worker down, crash, timeout or memory overrun return **503** with a
  clear message. A photo that cannot be processed (undecodable, no foreground, result over
  5 MB) returns **400**. Nothing is half-written.
- **Same storage layout.** Processed images are PNGs under `categories/`,
  `subcategories/` or `products/` with UUID keys. A processed sub-category also keeps the
  untouched upload under `originals/`. Unprocessed uploads keep their original format and
  extension, exactly as before.
- Uploads that already have transparency are returned as-is (`204` from the worker).
- `GET /api/v1/images/background-removal` returns `{ enabled, available }`. The admin UI
  uses it to disable the checkbox or warn when the worker is offline.

## Configuration

API (`homeMadeApi/.env`):

| Variable | Default | Meaning |
|---|---|---|
| `BACKGROUND_REMOVAL_ENABLED` | `false` | Master switch. `false`: uploads stored unchanged, no model. |
| `BACKGROUND_REMOVAL_WORKER_URL` | `http://127.0.0.1:4100` | Worker origin. |
| `BACKGROUND_REMOVAL_WORKER_TOKEN` | unset | Shared secret; set the same value for the worker. Required if the worker is not on loopback. |
| `BACKGROUND_REMOVAL_TIMEOUT_MS` | `170000` | Whole-job deadline seen by the API (queue + inference). Keep it above the worker's job timeout. |
| `BACKGROUND_REMOVAL_MAX_PENDING` | `3` | Uploads per API process allowed to wait for the worker; more get 503 "busy". |

Worker (it reads the same `.env` from its working directory):

| Variable | Default | Meaning |
|---|---|---|
| `BACKGROUND_REMOVAL_WORKER_HOST` | `127.0.0.1` | Listen address. Keep loopback unless the worker runs on another machine. |
| `BACKGROUND_REMOVAL_WORKER_PORT` | `4100` | Listen port. |
| `BACKGROUND_REMOVAL_WORKER_TOKEN` | unset | See above. |
| `BACKGROUND_REMOVAL_MODEL_PATH` | `.models/birefnet-general-lite.onnx` | Model file (`pnpm images:prepare-model`). |
| `BACKGROUND_REMOVAL_THREADS` | `2` | ONNX intra-op threads. Use vCPUs − 1 so the API keeps a core. |
| `BACKGROUND_REMOVAL_JOB_TIMEOUT_MS` | `150000` | Per-image limit; the job process is killed after it. |
| `BACKGROUND_REMOVAL_MAX_RSS_MB` | `6144` | Job process memory limit; killed above it, with a 503 answer. |
| `BACKGROUND_REMOVAL_MAX_QUEUE` | `2` | Jobs waiting behind the running one. |
| `BACKGROUND_REMOVAL_IDLE_MS` | `300000` | Idle time before the job process (and the model) is released. |
| `BACKGROUND_REMOVAL_RECYCLE_RSS_MB` | `1024` | After a job, a process still above this is replaced, returning memory to the OS. |

## Memory and CPU sizing

Measured with the real model and a real 1024² inference, 2 threads, fresh process each time:

| Graph optimization | Time | Peak RSS |
|---|---|---|
| `all` | 39 s | 6.0 GB |
| `disabled` (used) | 45 s | **5.4 GB** |

BiRefNet's input is fixed at 1×3×1024×1024, and that alone is what needs ~5.4 GB.
The worker can't make one image use less. What it does is keep that memory out of the API
and release it right after the job. For comparison, the older `u2net.onnx` (320²) peaks at
~0.46 GB in under a second, with noticeably weaker cut-outs. Switching models is a product
decision; the worker would need a model-specific segmenter for it.

On an **8 GB VPS** (API + PostgreSQL + OS take roughly 1.5–2 GB):

- Expect ~5.5 GB for the worker during a job. That fits, but leaves little headroom.
- Add a 2–4 GB swap file for the system, so idle pages of other services can move out
  while a job runs. The worker unit itself has `MemorySwapMax=0`.
- The worker unit caps memory at `MemoryMax=6500M` and sets `OOMScoreAdjust=500`. The job
  process sets its own `oom_score_adj` to 1000, and the API unit sets `-500`. If the host
  runs short anyway, the kernel kills the job process first and the API keeps running.
- Inference is CPU-heavy for 40–60 s per image. The unit runs it at `Nice=10` and
  `CPUWeight=20`, so API requests take priority.
- If removal regularly fails with "ran out of memory", the server is too small for this
  model. Run the worker on another machine (`BACKGROUND_REMOVAL_WORKER_URL` + token), use a
  larger VPS, or set `BACKGROUND_REMOVAL_ENABLED=false`.

## Running locally

```sh
pnpm install
pnpm images:prepare-model      # once: downloads and verifies the BiRefNet model
pnpm build                     # builds the API and the worker into dist/
```

Then, in `.env`:

```env
BACKGROUND_REMOVAL_ENABLED=true
```

Run the API and the worker in two terminals:

```sh
pnpm start:dev                 # API (rebuilds dist/ on change)
pnpm start:worker:dev          # worker (restarts when dist/ changes)
```

Check it: `curl http://127.0.0.1:4100/health` returns
`{"status":"ok","busy":false,...,"peakRssMb":0}`. With the worker stopped, uploads without
removal work normally, and uploads with removal return 503 "Background removal is
unavailable right now".

On Windows the timeout, crash handling and idle release all work. The memory limit is
only enforced between images there, because the job process can't report memory while
inference blocks it. On Linux the supervisor reads `/proc/<pid>/status` directly, so the
limit also applies during inference.

## Production with systemd

Unit files are in [`deploy/systemd/`](../deploy/systemd). They assume the app lives in
`/opt/homemade/homeMadeApi`, runs as user `homemade`, and that node is `/usr/bin/node`.
Adjust them to your server (`which node`).

```sh
# On the server, in /opt/homemade/homeMadeApi
pnpm install --frozen-lockfile
pnpm images:prepare-model
pnpm build

sudo cp deploy/systemd/homemade-api.service deploy/systemd/homemade-bg-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now homemade-bg-worker homemade-api

systemctl status homemade-bg-worker homemade-api
journalctl -u homemade-bg-worker -f
curl -s http://127.0.0.1:4100/health
```

Set `BACKGROUND_REMOVAL_ENABLED=true` in `.env` and restart the API
(`sudo systemctl restart homemade-api`) to turn the feature on. Deploying new code means
`pnpm build`, then `sudo systemctl restart homemade-bg-worker homemade-api`.

Both services load `.env` from `WorkingDirectory` through dotenv, so quoting and `$` in
values behave exactly as in development. Don't also add an `EnvironmentFile=`: systemd
parses quotes differently.

If you previously ran the API under pm2 or another manager, stop that first. Two API
processes would both try to bind the same port.

### Reverse proxy

An upload with background removal can take up to ~3 minutes. Give the API location in
nginx enough time and body size:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 200s;
    proxy_send_timeout 200s;
    client_max_body_size 30m;
}
```

Keep port 4100 private. The default bind is 127.0.0.1; don't expose it in nginx or the
firewall.

## Image delivery

`imageUrl` (and the other `*Url` fields) are built from `R2_PUBLIC_URL`, an r2.dev URL or
your CDN/custom domain. Browsers then load images straight from Cloudflare, never through
the API.

- `R2_PUBLIC_URL` set: always the direct URL. `IMAGE_PROXY_URL` is ignored.
- `R2_PUBLIC_URL` unset: `IMAGE_PROXY_URL` (optional), for example
  `https://api.example.com/api/v1/images`, serves images through the API's `/images`
  endpoint as a fallback.
- Neither set: `imageUrl` is `null`.

The studios draw images on a canvas. If the frontend reads pixels back from an R2 image
(for example to export a design preview), the R2 bucket needs a CORS rule allowing `GET`
from the frontend origins (Cloudflare dashboard → R2 → bucket → Settings → CORS policy).

## Tests

```sh
pnpm test        # unit: worker supervisor with real child processes, HTTP server, API client
pnpm test:e2e    # e2e: API → worker → job process, plus the existing image flows
RUN_BACKGROUND_MODEL_TESTS=1 pnpm test:e2e   # opt-in: real BiRefNet inference (~3 min)
```

- `src/background-worker/background-removal-worker.spec.ts` runs real forked processes
  with a fake model. It covers one-at-a-time order, queue limit, crash restart, timeout
  kill, memory-limit kill, cancellation and idle release.
- `test/storage/background-removal.e2e-spec.ts` runs the full path. It covers removal
  disabled, removal requested, a missing or `false` flag, worker crash, memory overrun,
  timeout and worker down (503 with no R2/DB writes), and the API answering other
  requests while a job runs.
- `src/storage/background-removal-isolation.spec.ts` fails if any API source imports
  `onnxruntime-node` or the worker.
