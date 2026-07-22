import sharp from "sharp";
import { env } from "../../config/env";
import { CheckResult } from "../../types/analysis";

/**
 * Estimates overall brightness via mean luminance of the greyscale image
 * (0 = black, 255 = white). Flags images that are likely low-light or
 * blown-out/overexposed.
 */
export async function checkBrightness(filePath: string): Promise<CheckResult> {
  const start = Date.now();
  const { channels } = await sharp(filePath).greyscale().stats();
  const meanLuminance = channels[0].mean;

  let status: CheckResult["status"] = "pass";
  let message = `Mean luminance ${meanLuminance.toFixed(1)} is within a normal range`;

  if (meanLuminance < env.brightness.lowThreshold) {
    status = "fail";
    message = `Image appears low-light (mean luminance ${meanLuminance.toFixed(1)} < ${env.brightness.lowThreshold})`;
  } else if (meanLuminance > env.brightness.highThreshold) {
    status = "warning";
    message = `Image appears overexposed (mean luminance ${meanLuminance.toFixed(1)} > ${env.brightness.highThreshold})`;
  }

  // Confidence scales with distance from thresholds - a value right at the
  // boundary is a weaker signal than one deep in low-light territory.
  const distance = status === "fail"
    ? (env.brightness.lowThreshold - meanLuminance) / env.brightness.lowThreshold
    : status === "warning"
      ? (meanLuminance - env.brightness.highThreshold) / (255 - env.brightness.highThreshold)
      : 0;
  const confidence = status === "pass" ? 0.9 : Math.min(0.95, 0.6 + Math.max(0, distance) * 0.4);

  return {
    name: "brightness_analysis",
    label: "Brightness Analysis",
    status,
    confidence,
    message,
    details: { meanLuminance, lowThreshold: env.brightness.lowThreshold, highThreshold: env.brightness.highThreshold },
    durationMs: Date.now() - start,
  };
}
