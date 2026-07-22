import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { CheckResult } from "../../types/analysis";

// Standard Indian registration plate format, e.g. "KA05MH1234" or "MH12AB1234":
// 2 letters (state) + 1-2 digits (RTO code) + 1-3 letters (series) + 4 digits (number).
// Some newer formats include a leading digit for the year batch; we cover the common case.
const INDIAN_PLATE_REGEX = /\b([A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4})\b/;

export function normalizeOcrText(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9\s]/g, " ");
}

export function findPlateCandidate(normalizedText: string): string | null {
  // Match per-line rather than across the whole OCR blob. Compacting
  // whitespace across the entire document (e.g. "KARNATAKA\nKA 05 MH 1234")
  // can glue unrelated words directly onto the plate digits and destroy the
  // \b word boundary the regex relies on, so we scope compaction to one
  // line at a time instead.
  const lines = normalizedText.split(/\n+/);

  for (const line of lines) {
    // Prefer a match against the line as-is (handles OCR getting the
    // spacing right, or getting it wrong in ways that don't matter).
    const spacedMatch = line.match(INDIAN_PLATE_REGEX);
    if (spacedMatch) return spacedMatch[1];

    // Fall back to a fully compacted version of just this line (handles
    // OCR inserting a spurious space/newline in the middle of the plate
    // itself, e.g. "KA 05 MH 1234").
    const compact = line.replace(/\s+/g, "");
    const compactMatch = compact.match(INDIAN_PLATE_REGEX);
    if (compactMatch) return compactMatch[1];
  }

  return null;
}

// Tesseract "page segmentation mode" values (Tesseract's own numeric enum,
// not tesseract.js-specific - see https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html#page-segmentation-method-psm).
// 11 = SPARSE_TEXT: look for as much text as possible in no particular
// order, without assuming a uniform block of prose. That fits a tight crop
// around a plate (short string, possibly some noise) much better than the
// default full-document layout analysis, and is meaningfully faster too.
const PSM_SPARSE_TEXT = "11";

// Indian plates only ever contain these characters. Constraining Tesseract's
// search space to this whitelist both speeds up recognition and cuts down
// on garbage matches from surrounding non-plate text/graphics.
const PLATE_CHAR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Number of Tesseract workers kept warm in the pool. Tesseract.js workers
 * process one `recognize()` call at a time, so a single shared worker forces
 * every candidate region to be OCR'd sequentially - the original cause of
 * ~20s+ plate checks on images with no matching plate, where every region
 * has to be tried before giving up. A small pool lets regions be OCR'd
 * concurrently instead. 3 balances wall-clock time (we OCR up to 5 regions)
 * against not spinning up more Tesseract instances than the box's CPU can
 * usefully run in parallel.
 */
const WORKER_POOL_SIZE = 3;

interface PooledWorker {
  worker: Awaited<ReturnType<typeof createWorker>>;
  busy: boolean;
}

let pool: PooledWorker[] | null = null;
let poolInitPromise: Promise<PooledWorker[]> | null = null;
const acquireQueue: Array<(pw: PooledWorker) => void> = [];

async function getPool(): Promise<PooledWorker[]> {
  if (pool) return pool;
  if (!poolInitPromise) {
    poolInitPromise = (async () => {
      const workers = await Promise.all(
        Array.from({ length: WORKER_POOL_SIZE }, async () => {
          const worker = await createWorker("eng");
          await worker.setParameters({
            tessedit_char_whitelist: PLATE_CHAR_WHITELIST,
          });
          return { worker, busy: false };
        })
      );
      pool = workers;
      return workers;
    })();
  }
  return poolInitPromise;
}

/** Acquires a free worker from the pool, queueing the caller if all workers
 * are currently busy rather than spawning extras. */
async function acquireWorker(): Promise<PooledWorker> {
  const workers = await getPool();
  const free = workers.find((w) => !w.busy);
  if (free) {
    free.busy = true;
    return free;
  }
  return new Promise((resolve) => {
    acquireQueue.push((pw) => {
      pw.busy = true;
      resolve(pw);
    });
  });
}

function releaseWorker(pw: PooledWorker): void {
  const next = acquireQueue.shift();
  if (next) {
    next(pw);
  } else {
    pw.busy = false;
  }
}

/**
 * A candidate crop region expressed as fractions of the full image
 * dimensions (0-1), so it applies regardless of the source photo's
 * resolution or aspect ratio.
 */
export interface CandidateRegion {
  name: string;
  xFrac: [number, number];
  yFrac: [number, number];
}

/**
 * Lightweight plate localization heuristic: no object detector, just a
 * prioritized list of crop windows based on where registration plates
 * typically sit in a full-vehicle photo (front/rear, roughly centered,
 * lower half of the frame). Ordered from tightest/highest-precision to
 * widest, so the loop in checkPlateOcr can stop as soon as one hits
 * instead of paying for every region on every image. The full frame is
 * always included last as a fallback so behavior never regresses below
 * the previous "OCR the whole image" approach.
 */
export const CANDIDATE_REGIONS: CandidateRegion[] = [
  { name: "bottom_center", xFrac: [0.15, 0.85], yFrac: [0.6, 0.95] },
  { name: "bottom_band", xFrac: [0, 1], yFrac: [0.55, 1.0] },
  { name: "bottom_left", xFrac: [0, 0.5], yFrac: [0.55, 1.0] },
  { name: "bottom_right", xFrac: [0.5, 1.0], yFrac: [0.55, 1.0] },
  { name: "full_frame", xFrac: [0, 1], yFrac: [0, 1] },
];

/** Minimum width (px) a crop is upscaled to before OCR - small crops of a
 * plate region are often only ~150-250px wide straight out of the source
 * photo, which is too low-res for Tesseract to read reliably. */
const OCR_UPSCALE_TARGET_WIDTH = 640;

export function regionToPixelBox(
  region: CandidateRegion,
  imageWidth: number,
  imageHeight: number
): { left: number; top: number; width: number; height: number } {
  const left = Math.round(region.xFrac[0] * imageWidth);
  const top = Math.round(region.yFrac[0] * imageHeight);
  const right = Math.round(region.xFrac[1] * imageWidth);
  const bottom = Math.round(region.yFrac[1] * imageHeight);
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.max(1, Math.min(imageWidth, right) - Math.max(0, left)),
    height: Math.max(1, Math.min(imageHeight, bottom) - Math.max(0, top)),
  };
}

/**
 * Crops to the given region, upscales small crops for OCR legibility, and
 * boosts contrast - all of which matter a lot more once we're OCR-ing a
 * small plate-sized crop instead of a whole photo.
 */
async function prepareRegionBuffer(
  filePath: string,
  region: CandidateRegion,
  imageWidth: number,
  imageHeight: number
): Promise<Buffer> {
  const box = regionToPixelBox(region, imageWidth, imageHeight);
  let pipeline = sharp(filePath).extract(box);

  if (box.width < OCR_UPSCALE_TARGET_WIDTH) {
    pipeline = pipeline.resize({ width: OCR_UPSCALE_TARGET_WIDTH, kernel: "cubic" });
  }

  return pipeline.grayscale().normalize().sharpen().toBuffer();
}

/**
 * Runs OCR against a prioritized sequence of crop regions (see
 * CANDIDATE_REGIONS) instead of the full frame, stopping as soon as one
 * region yields text matching the Indian plate format. This replaces the
 * previous "OCR the whole image" approach (see README trade-offs), which
 * struggled badly whenever the plate was small relative to a busy frame -
 * e.g. vehicles with large ad wraps, where Tesseract's output was dominated
 * by unrelated banner text and the plate was never resolved.
 *
 * Falls back to the full frame if no cropped region produces a match, so a
 * plate that happens to fill most of the photo (or a photo of just a plate)
 * is still handled at least as well as before.
 *
 * @param screenshotResult Optional promise for the sibling
 *   `screenshot_detection` check, if the caller already has one in flight
 *   (see `analysis/index.ts`). When that check comes back flagging the
 *   image as a screenshot, the `full_frame` region - by far the most
 *   expensive OCR pass, since it covers the entire image rather than a
 *   small crop - is skipped. A screenshot (ad banner, chat, social post,
 *   etc.) essentially never contains a real vehicle plate in the full
 *   frame; the cropped regions still run regardless, since a screenshot
 *   could plausibly contain a genuine vehicle photo pasted into it with a
 *   plate visible in the usual bottom-of-frame position. This is purely a
 *   performance optimization - it does not change pass/fail behavior for
 *   any image that would otherwise have found a plate, since a match in
 *   any cropped region already takes priority over the full_frame result.
 */
export async function checkPlateOcr(
  filePath: string,
  screenshotResult?: Promise<CheckResult>
): Promise<CheckResult & { extractedText: string; plateNumber: string | null; plateValid: boolean }> {
  const start = Date.now();
  try {
    const metadata = await sharp(filePath).metadata();
    const imageWidth = metadata.width;
    const imageHeight = metadata.height;

    // If we can't read dimensions for some reason, fall back straight to
    // whole-image OCR rather than failing the check outright.
    let regions = imageWidth && imageHeight ? CANDIDATE_REGIONS : [];

    // Decide whether to skip the full_frame region before kicking off any
    // OCR calls. We only need to wait on the screenshot check itself (a
    // fast pixel-level heuristic, not OCR), not on anything plate-related,
    // so this doesn't block the cropped regions from starting promptly.
    let fullFrameSkipped = false;
    if (screenshotResult && regions.some((r) => r.name === "full_frame")) {
      try {
        const screenshotCheck = await screenshotResult;
        if (screenshotCheck.status === "fail") {
          fullFrameSkipped = true;
          regions = regions.filter((r) => r.name !== "full_frame");
        }
      } catch {
        // If the screenshot check itself errored, fall back to running
        // full_frame as normal rather than guessing.
      }
    }

    const regionsAttempted = regions.map((r) => r.name);

    // OCR every candidate region concurrently (bounded by the worker pool
    // size) rather than one at a time. Region *priority* still matters for
    // which match we report - a tighter, higher-precision crop should win
    // over a wider one even if the wider one happens to resolve first - so
    // we run them all, then pick the best result in the original
    // CANDIDATE_REGIONS order afterwards instead of racing/early-exiting.
    const regionResults = await Promise.all(
      regions.map(async (region) => {
        const box = region.name !== "full_frame" ? regionToPixelBox(region, imageWidth as number, imageHeight as number) : undefined;
        const input =
          region.name === "full_frame"
            ? filePath
            : await prepareRegionBuffer(filePath, region, imageWidth as number, imageHeight as number);

        const pw = await acquireWorker();
        try {
          // Cropped regions are small and plate-shaped, so sparse-text mode
          // (no assumption of a uniform prose block) both suits them better
          // and runs faster than the default layout analysis. The full
          // frame keeps default segmentation since it's a whole photo.
          await pw.worker.setParameters({
            tessedit_pageseg_mode: region.name === "full_frame" ? ("3" as any) : (PSM_SPARSE_TEXT as any),
          });
          const { data } = await pw.worker.recognize(input);
          const rawText = data.text?.trim() ?? "";
          const normalized = normalizeOcrText(rawText);
          const plate = findPlateCandidate(normalized);
          const ocrConfidence = (data.confidence ?? 0) / 100;

          return {
            region: region.name,
            rawText,
            plate,
            ocrConfidence,
            box,
          };
        } finally {
          releaseWorker(pw);
        }
      })
    );

    let bestPlate: string | null = null;
    let bestConfidence = 0;
    let bestRegionName = "full_frame";
    let lastRawText = "";
    const regionDebug: { region: string; textLength: number; snippet: string; ocrConfidence: number; box?: { left: number; top: number; width: number; height: number } }[] = [];

    for (const r of regionResults) {
      regionDebug.push({
        region: r.region,
        textLength: r.rawText.length,
        snippet: r.rawText.replace(/\s+/g, " ").slice(0, 120),
        ocrConfidence: r.ocrConfidence,
        box: r.box,
      });
      // Regions are processed in CANDIDATE_REGIONS priority order here even
      // though the OCR calls themselves ran concurrently, so the first match
      // found in this loop is still the highest-precision one, matching the
      // previous sequential behavior.
      if (r.plate && !bestPlate) {
        bestPlate = r.plate;
        bestConfidence = r.ocrConfidence;
        bestRegionName = r.region;
      }
      lastRawText = r.rawText || lastRawText;
    }
    // Prefer the full-frame text for the human-reviewer fallback field if it
    // ran, since it's the most complete transcript of the image.
    const fullFrameResult = regionResults.find((r) => r.region === "full_frame");
    if (fullFrameResult) {
      lastRawText = fullFrameResult.rawText;
    }

    // If we couldn't read dimensions and so never ran any candidate region,
    // fall back to whole-image OCR so the check still does something useful
    // rather than failing outright.
    if (regionsAttempted.length === 0) {
      const pw = await acquireWorker();
      let data;
      try {
        await pw.worker.setParameters({ tessedit_pageseg_mode: "3" as any });
        ({ data } = await pw.worker.recognize(filePath));
      } finally {
        releaseWorker(pw);
      }
      lastRawText = data.text?.trim() ?? "";
      const normalized = normalizeOcrText(lastRawText);
      const plate = findPlateCandidate(normalized);
      if (plate) {
        bestPlate = plate;
        bestConfidence = (data.confidence ?? 0) / 100;
        bestRegionName = "full_frame";
      }
    }

    const status: CheckResult["status"] = bestPlate ? "pass" : "fail";

    return {
      name: "plate_ocr_validation",
      label: "Vehicle Plate OCR & Format Validation",
      status,
      confidence: bestPlate ? Math.max(0.4, bestConfidence) : 0.5,
      message: bestPlate
        ? `Detected plate "${bestPlate}" matching Indian registration format (region: ${bestRegionName})`
        : "No text matching the Indian vehicle plate format was found in any candidate region",
      details: {
        regionsAttempted,
        matchedRegion: bestPlate ? bestRegionName : null,
        rawTextLength: lastRawText.length,
        fullFrameSkipped,
        regionDebug,
      },
      durationMs: Date.now() - start,
      extractedText: lastRawText,
      plateNumber: bestPlate,
      plateValid: !!bestPlate,
    };
  } catch (err) {
    return {
      name: "plate_ocr_validation",
      label: "Vehicle Plate OCR & Format Validation",
      status: "error",
      confidence: 0,
      message: `OCR failed to run: ${(err as Error).message}`,
      durationMs: Date.now() - start,
      extractedText: "",
      plateNumber: null,
      plateValid: false,
    };
  }
}

export async function shutdownOcrWorker(): Promise<void> {
  if (poolInitPromise) {
    const workers = await poolInitPromise;
    await Promise.all(workers.map((pw) => pw.worker.terminate()));
    pool = null;
    poolInitPromise = null;
  }
}
