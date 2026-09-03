# Swoge AI Video

Converts an animated video into photorealistic live-action, one grid at a time.

The video is split into frames, the frames are assembled into N×N grids, each
grid goes through the image model once for a style transfer, then the grids are
cut back up and the video is reassembled with the original audio.

**One grid = one API call = one charge.** That single fact shapes the whole
service: a grid already styled on disk is *never* redone, so an interrupted job
resumes without paying twice.

---

## Environment variables

| Variable | Required | Default | What it is |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | Read server-side only. It is never sent to the browser, never written to a log, and stripped from error messages. |
| `GEMINI_MODEL` | no | `gemini-3-pro-image` | The image model. |
| `DATA_DIR` | no | `/data` | Where jobs live. Must be a Railway volume — the rest of the filesystem is wiped on redeploy. |
| `PORT` | no | `3000` | Railway sets this itself. |
| `FFMPEG_BIN` / `FFPROBE_BIN` | no | `ffmpeg` / `ffprobe` | Only needed where the binaries are not on `PATH`. |

## Deploying on Railway

1. **New project → Deploy from GitHub repo**, and set the service **Root
   Directory** to `swoge-ai-video`.
2. **Variables** → add `GEMINI_API_KEY`.
3. **Volumes** → add a volume mounted at **`/data`**. Without it the
   filesystem is ephemeral: every redeploy loses the jobs *and* the grids you
   already paid for.
4. Deploy. `nixpacks.toml` installs `ffmpeg` (which brings `ffprobe`); the
   start command is `npm start`.
5. Open the service URL. The root serves the page.

## Routes

| Route | Purpose |
|---|---|
| `GET /` and `/swoge-ai-video.html` | The page. |
| `POST /api/estimation` | Probes a video and returns frames, grids and estimated cost — **before** anything is charged. |
| `POST /api/jobs` | Video + reference images → `{ jobId }`. Returns immediately; the work runs in the background. |
| `GET /api/jobs/:id` | Status, grids done/total, actual cost, error. Poll every 2 s. |
| `GET /api/jobs/:id/grille/:g` | One styled grid, for the live thumbnails. |
| `GET /api/jobs/:id/result` | The finished video. |
| `POST /api/jobs/:id/resume` | Re-runs **only** the missing grids. |

## Why the work is not done inside the request

Railway cuts long HTTP requests. A job is queued and answered immediately with
its id; the page polls. The queue runs 3 jobs at a time, and the job state is
written as JSON to `/data` after every grid — so a redeploy mid-job loses
nothing but the current call.

## Limits

- Videos longer than **2 minutes** are refused in v1. Past that the number of
  calls, and so the cost, cannot be announced honestly before starting.
- Working files older than **24 hours** are deleted hourly.
- Reference images are capped at 6 per call.

## Cost

`$0.134` per call at 1K/2K, `$0.24` at 4K. These are the only numbers in the
service that are not measured — they come from the price list and are written
in one place (`COUT` in `server.js`) so there is one place to correct when it
changes.

Grid size is the cost lever: 4×4 puts 16 frames in one call, 2×2 puts 4. A
10-second 24 fps clip is 240 frames — 15 calls at 4×4, 60 at 2×2.

## Tests

```
npm install
node pipeline.test.js          # ffmpeg must be on PATH, or set FFMPEG_BIN
```

`pipeline.test.js` builds a video whose every frame is a different, identifiable
colour, runs it through the real pipeline with the model replaced by the
identity, and checks that **each frame comes back in its own position**. A
swapped cell would otherwise produce a video that reassembles, plays, and
jumps — with nothing to signal it.
