import sharp from "sharp";
import { env } from "../../config/env";
import { CheckResult } from "../../types/analysis";

/**
 * Validates that the image meets a minimum usable resolution. Images below
 * this size are unlikely to be useful for downstream tasks like plate OCR.
 */
export async function checkDimensions(filePath: string): Promise<CheckResult> {
  const start = Date.now();
  const metadata = await sharp(filePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const tooSmall = width < env.dimensions.minWidth || height < env.dimensions.minHeight;

  return {
    name: "dimension_validation",
    label: "Dimension Validation",
    status: tooSmall ? "fail" : "pass",
    confidence: 1, // deterministic check, not a probabilistic heuristic
    message: tooSmall
      ? `Image is ${width}x${height}, below the minimum ${env.dimensions.minWidth}x${env.dimensions.minHeight}`
      : `Image resolution ${width}x${height} is acceptable`,
    details: { width, height, format: metadata.format, minWidth: env.dimensions.minWidth, minHeight: env.dimensions.minHeight },
    durationMs: Date.now() - start,
  };
}
