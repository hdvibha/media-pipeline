import { AnalysisReport, CheckResult, ImageContext } from "../../types/analysis";
import { checkDimensions } from "./dimensions";
import { checkBrightness } from "./brightness";
import { checkBlur } from "./blur";
import { checkDuplicate } from "./duplicate";
import { checkScreenshot } from "./screenshot";
import { checkPhotoOfPhoto } from "./photoOfPhoto";
import { checkTampering } from "./tampering";
import { checkPlateOcr } from "./plateOcr";
import { logger } from "../../utils/logger";

/**
 * Maps a check's machine name + status to a stable "issue code" surfaced in
 * the API response. Only fail/warning statuses become issues; "pass",
 * "skipped" and "error" (logged separately) do not.
 */
const ISSUE_CODE_MAP: Record<string, string> = {
  blur_detection: "blurry",
  brightness_analysis: "low_light_or_overexposed",
  duplicate_detection: "duplicate_image",
  screenshot_detection: "screenshot_detected",
  photo_of_photo_detection: "photo_of_photo_suspected",
  tampering_heuristics: "possible_editing_detected",
  plate_ocr_validation: "invalid_or_missing_plate",
  dimension_validation: "resolution_too_low",
};

export async function runAnalysisPipeline(ctx: ImageContext): Promise<{ report: AnalysisReport; perceptualHash: string }> {
  const checks: CheckResult[] = [];

  // Kicked off separately (not just inline in the Promise.all below) so the
  // same in-flight promise can also be handed to checkPlateOcr, which uses
  // it to skip its most expensive OCR pass (full_frame) once an image is
  // already known to be a screenshot. This doesn't change the concurrency
  // model - it still runs alongside everything else - it just lets one
  // check's result inform another's without serializing them.
  const screenshotPromise = safeRun(() => checkScreenshot(ctx.filePath), "screenshot_detection");

  // Independent, side-effect-free checks run concurrently for throughput.
  const [dimensionsResult, brightnessResult, blurResult, screenshotResult, photoOfPhotoResult, tamperingResult, plateResult] =
    await Promise.all([
      safeRun(() => checkDimensions(ctx.filePath), "dimension_validation"),
      safeRun(() => checkBrightness(ctx.filePath), "brightness_analysis"),
      safeRun(() => checkBlur(ctx.filePath), "blur_detection"),
      screenshotPromise,
      safeRun(() => checkPhotoOfPhoto(ctx.filePath), "photo_of_photo_detection"),
      safeRun(() => checkTampering(ctx.filePath), "tampering_heuristics"),
      safeRun(() => checkPlateOcr(ctx.filePath, screenshotPromise), "plate_ocr_validation"),
    ]);

  checks.push(dimensionsResult, brightnessResult, blurResult, screenshotResult, photoOfPhotoResult, tamperingResult, plateResult);

  // Duplicate detection reads from the DB (needs other rows to compare
  // against) so it runs after / separately rather than in the batch above -
  // keeps the concurrency model simple and avoids a race where two images
  // uploaded in the same instant don't see each other's hash yet.
  const { result: duplicateResult, hash } = await checkDuplicate(ctx.filePath, ctx.imageId);
  checks.push(duplicateResult);

  const issues = checks
    .filter((c) => c.status === "fail" || c.status === "warning")
    .map((c) => ISSUE_CODE_MAP[c.name] ?? c.name);

  const hasHardFailure = checks.some((c) => c.status === "fail");
  const hasWarning = checks.some((c) => c.status === "warning");
  const overallVerdict: AnalysisReport["overallVerdict"] = hasHardFailure || hasWarning ? "flagged" : "clean";

  const plateCheck = plateResult as CheckResult & { extractedText?: string; plateNumber?: string | null; plateValid?: boolean };

  const report: AnalysisReport = {
    imageId: ctx.imageId,
    checks,
    issues,
    overallVerdict,
    extractedText: plateCheck.extractedText,
    plateNumber: plateCheck.plateNumber ?? null,
    plateValid: plateCheck.plateValid ?? null,
    generatedAt: new Date().toISOString(),
  };

  return { report, perceptualHash: hash };
}

async function safeRun<T extends CheckResult>(fn: () => Promise<T>, name: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, check: name }, "analysis check threw unexpectedly");
    return {
      name,
      label: name,
      status: "error",
      confidence: 0,
      message: `Check crashed: ${(err as Error).message}`,
    } as T;
  }
}
