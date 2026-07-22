import sharp from "sharp";
import { CheckResult } from "../../types/analysis";

// Common device screen resolutions (portrait, w x h) that screenshots tend
// to exactly match. Not exhaustive - a heuristic signal, not ground truth.
const KNOWN_SCREEN_ASPECT_RATIOS = [
  9 / 16, 9 / 19.5, 9 / 18, 9 / 20, 3 / 4, 2 / 3, 1 / 1.777, 3 / 5,
];

function closestAspectRatioDistance(ratio: number): number {
  return Math.min(...KNOWN_SCREEN_ASPECT_RATIOS.map((r) => Math.abs(r - ratio)));
}

/**
 * Heuristic screenshot detector. Screenshots (as opposed to camera photos of
 * vehicles) tend to:
 *  - have no EXIF camera make/model (they were never captured by a camera sensor)
 *  - be PNG rather than JPEG (common on iOS/Android/desktop screenshot tools)
 *  - match a known device screen aspect ratio closely
 *  - have a very uniform top strip (status bar / notch area)
 * We score these signals and combine them rather than relying on any single
 * one, since each is individually weak/spoofable.
 */
export async function checkScreenshot(filePath: string): Promise<CheckResult> {
  const start = Date.now();
  const img = sharp(filePath);
  const metadata = await img.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  let score = 0;
  const signals: string[] = [];

  // Signal 1: no EXIF at all (crude - real EXIF parsing would check
  // Make/Model tags specifically; we don't pull in an extra dependency and
  // instead treat total EXIF absence as a lighter-weight proxy).
  if (!metadata.exif) {
    score += 0.3;
    signals.push("no_exif_data");
  }

  // Signal 2: PNG format (screenshots are very commonly PNG; vehicle photos
  // from a phone camera are almost always JPEG/HEIC).
  if (metadata.format === "png") {
    score += 0.25;
    signals.push("png_format");
  }

  // Signal 3: aspect ratio closely matches a known device screen ratio.
  if (width > 0 && height > 0) {
    const ratio = width > height ? height / width : width / height;
    const distance = closestAspectRatioDistance(ratio);
    if (distance < 0.02) {
      score += 0.3;
      signals.push("matches_device_screen_ratio");
    }
  }

  // Signal 4: very uniform top strip, characteristic of a status bar.
  try {
    const stripHeight = Math.max(4, Math.round(height * 0.03));
    if (stripHeight > 0 && width > 0) {
      const { channels } = await img
        .clone()
        .extract({ left: 0, top: 0, width, height: stripHeight })
        .greyscale()
        .stats();
      if (channels[0].stdev < 8) {
        score += 0.15;
        signals.push("uniform_top_strip");
      }
    }
  } catch {
    // extraction can fail on tiny/edge-case images - not fatal, just skip signal
  }

  const isScreenshot = score >= 0.5;

  return {
    name: "screenshot_detection",
    label: "Screenshot Detection",
    status: isScreenshot ? "fail" : "pass",
    confidence: Math.min(0.9, score),
    message: isScreenshot
      ? `Image looks like a screenshot (signals: ${signals.join(", ") || "none"})`
      : "No strong screenshot signals detected",
    details: { score, signals, width, height, format: metadata.format },
    durationMs: Date.now() - start,
  };
}
