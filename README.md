# Intelligent Media Processing Pipeline

An async backend for uploading vehicle images, running a battery of image-quality
and integrity checks on them, and reporting structured results.

Built with **Node.js + TypeScript, Express, BullMQ (Redis), PostgreSQL (Prisma), and Sharp**.

---

## 1. Quick Start (Docker)

```bash
cp .env.example .env
docker compose up --build
```

This brings up Postgres, Redis, a one-shot `migrate` container (runs `prisma migrate deploy`),
the API (`:3000`), and a worker process. Once it's up:

```bash
# Upload an image
curl -X POST http://localhost:3000/api/images -F "image=@/path/to/vehicle.jpg"

# -> { "id": "…", "status": "pending", "statusUrl": "...", "resultsUrl": "..." }

# Poll status
curl http://localhost:3000/api/images/<id>/status

# Fetch results once status == "completed"
curl http://localhost:3000/api/images/<id>/results
```

Or seed a few synthetic images automatically:

```bash
npm install && npm run seed   # requires the stack above to already be running
```

## 2. Running Locally (without Docker)

```bash
npm install
docker compose up postgres redis -d   # or run your own local Postgres/Redis
cp .env.example .env                  # adjust DATABASE_URL/REDIS_HOST if needed
npx prisma migrate deploy
npm run dev            # API on :3000
npm run dev:worker     # in a second terminal - the queue worker
```

Run the unit tests (pure-logic tests, no DB/Redis required):

```bash
npm test
```

---

## 3. Architecture

### 3.1 Service Flow

```
                 ┌──────────────┐        ┌───────────────┐
  Client ───────▶│  Express API │───────▶│  Postgres      │
  (multipart)    │  (uploadImage)│  save  │  Image row     │
                 └──────┬───────┘  metadata└───────────────┘
                        │ enqueue(imageId)
                        ▼
                 ┌──────────────┐
                 │ Redis (BullMQ)│
                 │  analysis queue│
                 └──────┬───────┘
                        │ pulled by
                        ▼
                 ┌──────────────┐        ┌───────────────┐
                 │ Worker process│───────▶│  Postgres      │
                 │ runs 8 checks │ writes │  status +      │
                 │ concurrently  │        │  AnalysisResult│
                 └──────────────┘        └───────────────┘
```

- **API process** (`src/index.ts`): accepts uploads, validates the file is a
  decodable image, writes it to disk, inserts an `Image` row with
  `status = pending`, enqueues a BullMQ job, and returns `202 Accepted`
  immediately with the processing ID. It never runs analysis itself.
- **Worker process** (`src/queue/worker.ts`): a separate Node process (own
  `Dockerfile`/`docker-compose` service) that pulls jobs off the queue, flips
  the image to `processing`, runs the analysis pipeline, and writes the final
  `completed`/`failed` state + results in one transaction.
- Running API and worker as **separate processes** (rather than in-process
  background jobs) means the API stays responsive under load and the worker
  can be scaled independently (`docker compose up --scale worker=4`).

### 3.2 Processing Flow (per image)

1. `pending` → set on insert, before the job is even picked up.
2. `processing` → set the moment the worker starts the job; `attempts` is
   incremented and `processingStartedAt` recorded.
3. Seven of the eight checks (everything except duplicate detection) run
   **concurrently** via `Promise.all` since they're independent, read-only
   operations on the same file - this is the main perf lever available
   without adding more worker concurrency.
4. Duplicate detection runs separately because it needs to query the DB for
   every other image's perceptual hash - keeping it out of the `Promise.all`
   batch keeps the concurrency model simple to reason about.
5. Results are written in a single Prisma `$transaction` (`Image.status =
   completed` + upsert `AnalysisResult`) so a reader can never observe
   "completed" status with a missing result row.
6. On an unhandled exception, the error is caught, and only on the **final**
   retry attempt is the image marked `failed` with `failureReason` - earlier
   attempts are left as `processing` so BullMQ's backoff/retry can proceed
   without a reader seeing a premature failure.

### 3.3 Queue Strategy

**BullMQ backed by Redis.** Chosen over an in-memory queue because it survives
API/worker restarts (jobs aren't lost if the worker crashes mid-batch) and
over heavier options (SQS, RabbitMQ) because for a take-home-sized system it's
the lowest-ceremony option that still gives real persistence, retries, and
concurrency control - a small Docker Compose stack, not a managed cloud queue
or a separate broker to operate.

- `attempts: 3` with exponential backoff (`2s, 4s, 8s`) — transient failures
  (e.g. a momentary DB blip) get retried automatically without operator
  intervention.
- `jobId: imageId` — makes job enqueuing idempotent; re-uploading the exact
  same request twice by accident can't double-enqueue the same image ID.
- `removeOnComplete`/`removeOnFail` retention windows keep Redis from growing
  unbounded while still leaving failed jobs inspectable for a week.
- Worker `concurrency` is configurable via `QUEUE_CONCURRENCY` (default 2) -
  tesseract.js OCR is the most CPU-heavy step, so concurrency is deliberately
  conservative by default to avoid starving the container.

### 3.4 Data Model

```
Image
  id, originalFilename, storagePath, mimeType, sizeBytes, width, height,
  perceptualHash, status(enum), failureReason, attempts,
  createdAt, updatedAt, processingStartedAt, processingCompletedAt

AnalysisResult (1:1 with Image, onDelete: Cascade)
  id, imageId, overallVerdict(enum), issues(JSONB array of issue codes),
  checks(JSONB - full per-check breakdown), extractedText, plateNumber,
  plateValid, createdAt, updatedAt
```

Key decisions:
- **`Image` and `AnalysisResult` are separate tables**, not one wide table.
  `Image` is written twice (insert, then status update) regardless of
  whether analysis ever produces results (e.g. it can fail before producing
  any); keeping them separate means the upload path never has to touch
  analysis-shaped columns, and `AnalysisResult` can be `null` cleanly for
  images still in flight.
- **`checks` is a JSONB blob**, not one row per check. A fully normalized
  `Check` table (imageId, checkName, status, confidence, details...) would
  be more queryable (e.g. "find all images that failed blur_detection") but
  adds a join for every single results read, for a field set that's
  read-mostly and whose "shape" (which checks exist) can evolve without a
  migration. Documented as a trade-off below - if per-check analytics
  became a real product requirement, that table would be the first thing
  I'd add.
- **Indexes** on `Image.status` (worklist/dashboard queries),
  `Image.perceptualHash` (duplicate lookups), `Image.createdAt` (recency
  sorts/pagination), and `AnalysisResult.overallVerdict` (fast "show me
  flagged images" queries).

### 3.5 API Surface

| Method | Path                        | Purpose                                   |
|--------|-----------------------------|--------------------------------------------|
| POST   | `/api/images`                | Upload an image (`multipart/form-data`, field `image`). Returns `202` with the image ID immediately. |
| GET    | `/api/images/:id/status`     | Poll processing status.                    |
| GET    | `/api/images/:id/results`    | Full analysis results (409 if not yet completed, with the current status + reason). |
| GET    | `/api/images/:id`            | Full row (metadata + analysis if present). |
| GET    | `/api/images`                | Paginated listing (`?limit=&cursor=&status=`), bonus for a dashboard/debugging. |
| GET    | `/health`                    | Liveness/readiness - pings Postgres and Redis. |

Sample requests/responses are in [`docs/sample-requests.md`](./docs/sample-requests.md).

### 3.6 The 8 Analysis Checks

All implemented as independent, pure-ish functions in `src/services/analysis/`,
each returning a common `CheckResult` shape (`status`, `confidence`,
`message`, `details`). The orchestrator (`src/services/analysis/index.ts`)
fans them out, `Promise.all`s the independent ones, and folds the results
into a single `AnalysisReport` + an `issues[]` summary + an `overallVerdict`.

| Check | Technique | Notes |
|---|---|---|
| **Blur detection** | Variance of Laplacian on a downscaled greyscale image (hand-rolled convolution, no OpenCV dependency) | Standard, fast heuristic. Threshold is env-configurable. |
| **Brightness analysis** | Mean greyscale luminance via `sharp().stats()` | Flags both low-light *and* overexposed images. |
| **Duplicate detection** | Difference hash (dHash, 64-bit) + Hamming distance against every other stored hash | Robust to re-compression/resizing, not to rotation/crop (documented below). |
| **Screenshot detection** | Weighted heuristic: EXIF absence, PNG format, aspect ratio match to known device screens, uniform "status bar" strip | Multiple weak signals combined rather than any single one trusted. |
| **Photo-of-photo detection** | Uniform border/frame detection + overall colour-variance check | Weakest of the 8 checks by design - reports as `warning`, not `fail`, and capped confidence. |
| **Tampering/editing heuristics** | Error Level Analysis (JPEG re-compression diff, grid-based outlier detection) + EXIF "software" tag scan (Photoshop/GIMP/etc.) | Suggestive, not conclusive - see trade-offs. |
| **Plate OCR + format validation** | Tesseract.js OCR against a prioritized sequence of crop regions (bottom-center, bottom band, bottom-left/right, full frame), regex-matched against the standard Indian plate format (`^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$`) | Heuristic geometric localization, not a trained detector - see trade-offs. |
| **Dimension validation** | Deterministic width/height floor check | The one check with a hard, non-probabilistic verdict. |

`overallVerdict` is `flagged` if **any** check returns `fail` or `warning`,
otherwise `clean`. `issues` is a flat array of stable issue codes (e.g.
`"blurry"`, `"duplicate_image"`, `"invalid_or_missing_plate"`) meant to be
consumed by a UI without it needing to know about individual check names.

---

## 4. AI Usage Disclosure (mandatory)

I used Claude throughout this build as a pair-programmer, not as an oracle.
Being specific about where it helped and where it was wrong:

**Where AI helped:**
- Scaffolding the boilerplate-heavy parts fast: Express routing, Multer
  config, Prisma schema syntax, BullMQ job/worker wiring, Dockerfile/Compose
  structure. This is exactly the kind of code where AI is reliable and the
  time saved is real.
- Drafting the first pass of each heuristic check (Laplacian blur variance,
  dHash, ELA) from a plain-English description of the algorithm, which I
  then read line-by-line and adjusted (thresholds, edge cases, confidence
  scoring).
- Writing this README's structure/prose after the actual design decisions
  were made - the reasoning and trade-offs are the substance; AI helped
  organize and phrase them.

**Where AI output was wrong / needed correction:**
- The **first version of the plate-matching regex logic compacted
  whitespace across the entire OCR'd document before matching**, which
  silently merged unrelated words directly onto the plate digits (e.g.
  `"…KARNATAKA" + "KA 05 MH 1234"` became one run-on token) and broke the
  regex's `\b` word-boundary check. This wasn't caught by inspection - it
  only surfaced once a unit test exercised realistic multi-line OCR noise
  around the plate. Fixed by scoping the compaction to one line at a time
  instead of the whole document. This is exactly why the check has unit
  tests (`tests/plateOcr.test.ts`) with adversarial-ish inputs, not just the
  happy path.
- An early draft of the ELA tampering check flagged almost every image as
  "possibly edited" because it treated *any* elevated recompression error as
  suspicious, rather than looking for *localized* outliers relative to the
  image's own average. It was rewritten to grid the image and only flag
  blocks that are statistical outliers vs. the rest of the same image - a
  meaningfully different (and much less false-positive-prone) approach.
- Suggested dependency versions / API shapes for less common libraries
  (BullMQ job options, Sharp's raw buffer output format, Tesseract.js v5's
  worker API) were not taken on faith - these were cross-checked against
  actual `node_modules` behavior, since AI training data can lag a
  library's current API.

**How AI-generated code was validated:**
- `tsc --noEmit` run continuously as a compile-correctness gate (the full
  project currently compiles clean).
- Unit tests (`vitest`) for the pure-logic pieces that don't need
  infrastructure (Hamming distance math, plate regex matching against
  adversarial OCR-noise inputs) - written specifically to catch the kind of
  subtle bug described above. All 9 currently pass.
- Manual read-through of every heuristic's actual math (not just "does it
  run"), since these are exactly the parts of the assignment where a
  plausible-looking-but-wrong implementation is the biggest risk.
- **Honest limitation:** this was authored in an environment without a live
  Postgres/Redis instance or real vehicle photos, so the full
  upload → queue → worker → results round-trip through Docker Compose has
  not been executed end-to-end by me. Verification here was via full
  TypeScript compilation and focused unit tests only. **Before relying on
  this, run `docker compose up --build` and `npm run seed` and sanity-check
  a few real images** - flagging this explicitly rather than claiming an
  e2e run that didn't happen.

---

## 5. Trade-offs

### What was intentionally simplified
- **Local disk storage**, not S3/GCS. `StorageService` is a small interface
  specifically so swapping in an object-store implementation later doesn't
  touch any calling code - but a second implementation wasn't built since
  it wasn't the point of the exercise.
- **Plate localization is geometric, not learned.** OCR now runs against a
  prioritized sequence of crop regions (`CANDIDATE_REGIONS` in
  `plateOcr.ts`) chosen from where plates typically sit in a full-vehicle
  photo (front/rear, centered, lower half of frame), rather than a trained
  object detector or contour analysis. This is a meaningful improvement
  over full-frame OCR for busy photos (large ad wraps, cluttered
  backgrounds) - it stops Tesseract's layout analysis from getting
  dominated by unrelated banner/signage text - but it is still a prior
  over typical camera framing, not actual plate detection. A photo taken
  from an unusual angle, or where the plate sits outside the assumed
  regions (e.g. a tight close-up crop, or an odd non-standard mounting
  position), will fall through every region and land on the full-frame
  fallback, inheriting its original weakness. A real system would replace
  this with a lightweight trained detector (or classical contour/edge
  analysis scored by aspect ratio) so localization is driven by the
  image's actual content instead of an assumed region prior.
- **Duplicate detection is O(N) per upload** - it loads every other image's
  hash and compares in application code. Fine at hundreds/low-thousands of
  images; would need bucketing (hash-prefix sharding) or a proper
  similarity index (e.g. an LSH structure) once the dataset grows large.
- **No plate-region-specific tampering check** - ELA runs over the whole
  image, not specifically the plate area, even though plate tampering (e.g.
  digit swapping) is the highest-value case to catch for this domain.
- **Screenshot/photo-of-photo/tampering are heuristic and best-effort by
  design** - the assignment explicitly says perfect ML accuracy isn't the
  goal. These three checks report `warning` rather than hard `fail` where
  confidence is inherently limited, and their `confidence` scores are
  deliberately capped lower than the more deterministic checks (blur,
  brightness, dimensions) so a consumer of the API can tell them apart.

### What would be improved with more time
- Real ML models for blur/screenshot/tampering (even a small classifier)
  instead of hand-tuned heuristics - the heuristics are honest,
  explainable, and dependency-light, but a labeled dataset would let a
  simple classifier beat threshold-tuning quickly.
- A dedicated `Check` table (see Data Model above) once per-check analytics
  or historical threshold-tuning becomes a real requirement.
- Signed/pre-authenticated upload URLs directly to object storage instead of
  proxying the file through the API process.
- A lightweight plate detector (even a classical CV bounding-box heuristic)
  to crop before OCR - would meaningfully improve OCR accuracy and speed.
- Rate limiting on the upload endpoint (noted below - not implemented).

### Scalability concerns
- API and worker are already separate processes/containers, so horizontal
  scaling is `docker compose up --scale worker=N` for CPU-bound analysis
  work, and a load balancer + multiple API replicas for upload throughput -
  no code changes needed for either.
- Tesseract.js OCR is the most expensive single check; worker concurrency is
  deliberately conservative (`QUEUE_CONCURRENCY=2` default) to avoid
  contending for CPU. At real scale, OCR would likely move to its own
  queue/worker pool so a burst of uploads doesn't starve the faster checks
  (blur/brightness/dimensions) behind slow OCR jobs.
- Local disk storage does not scale past a single machine/volume - this is
  the first thing to swap for object storage in a multi-instance deployment.
- Duplicate detection's O(N) comparison is the clearest algorithmic
  bottleneck as data grows (see above).

### Failure-handling concerns
- Retries (3 attempts, exponential backoff) handle transient failures
  (DB hiccup, OCR worker init race) but a check that is *deterministically*
  wrong (e.g. a corrupt file that always throws) will still burn all 3
  attempts before landing on `failed` - there's no fast-fail path for
  "this will never succeed" errors vs. "try again in a bit" errors.
  A production version would classify errors (retryable vs. terminal) and
  skip straight to `failed` for the latter.
- No rate limiting on `/api/images` yet - a burst of uploads is bounded only
  by `MAX_UPLOAD_SIZE_BYTES` per request and worker concurrency, not request
  rate. Would add `express-rate-limit` (or an API gateway) before exposing
  this publicly.
- `attempts`/`failureReason` are stored on `Image`, so a caller polling
  `/status` can see *why* something failed without digging through worker
  logs - but there's currently no operator-facing dashboard/alerting on
  failure rate; that would be the next reliability investment.

---

## 6. Assumptions Made

- "Indian vehicle number format" was interpreted as the standard
  `SS DD LL NNNN` pattern (2 state letters, 1-2 RTO digits, 1-3 series
  letters, 4 digits) - the most common civilian format. BH-series and other
  newer formats are not covered.
- Accepted upload types: JPEG, PNG, WebP, HEIC/HEIF. Anything else is
  rejected at the API boundary with a `400`.
- "Duplicate" is scoped to the entire dataset (any image ever uploaded),
  not per-user/per-session, since the assignment doesn't describe a
  multi-tenant/user model.
- A single `image` field name is expected in the multipart form.

---

## 7. Project Structure

```
src/
  index.ts                 API process entry point
  config/env.ts             central env/threshold config
  controllers/               request handlers
  routes/                    Express route wiring
  middleware/                 upload (multer) + error handling
  db/prisma.ts               Prisma client singleton
  queue/                     BullMQ queue + worker
  services/
    storage.service.ts        local disk storage (swappable interface)
    analysis/                 the 8 checks + orchestrator
  types/analysis.ts          shared CheckResult / AnalysisReport contracts
  utils/logger.ts            pino structured logging
prisma/                      schema + hand-authored initial migration
scripts/seed.ts               generates + uploads synthetic sample images
tests/                        vitest unit tests (pure logic, no infra needed)
docs/sample-requests.md       example API requests/responses
```
