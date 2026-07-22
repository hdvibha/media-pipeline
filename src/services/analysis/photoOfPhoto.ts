import sharp from "sharp";
import { CheckResult } from "../../types/analysis";

/**
 * Heuristic detector for "photo of a photo/screen" (re-photographing a
 * printed picture or another display instead of the actual vehicle).
 * Signals used:
 *  - a uniform-colored border/frame around the image edges (photo print
 *    borders, phone/monitor bezels, or the dark surrounding area typical
 *    when someone photographs a screen or printed photo on a table)
 *  - unusually low colour variety for a real-world outdoor/indoor photo
 * Like screenshot detection, this is heuristic and best-effort - flagged
 * clearly as such in the response rather than presented as certain.
 */
export async function checkPhotoOfPhoto(filePath: string): Promise<CheckResult> {
  const start = Date.now();
  const img = sharp(filePath);
  const metadata = await img.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  let score = 0;
  const signals: string[] = [];

  if (width > 0 && height > 0) {
    const borderThickness = Math.max(2, Math.round(Math.min(width, height) * 0.02));

    try {
      const regions = await Promise.all([
        img.clone().extract({ left: 0, top: 0, width, height: borderThickness }).raw().toBuffer(), // top
        img.clone().extract({ left: 0, top: Math.max(0, height - borderThickness), width, height: borderThickness }).raw().toBuffer(), // bottom
        img.clone().extract({ left: 0, top: 0, width: borderThickness, height }).raw().toBuffer(), // left
        img.clone().extract({ left: Math.max(0, width - borderThickness), top: 0, width: borderThickness, height }).raw().toBuffer(), // right
      ]);

      const stdevs = regions.map((buf) => stdev(buf));
      const avgBorderStdev = stdevs.reduce((a, b) => a + b, 0) / stdevs.length;

      if (avgBorderStdev < 12) {
        score += 0.45;
        signals.push("uniform_border_frame");
      }
    } catch {
      // small/odd-shaped images may fail extraction; skip this signal
    }
  }

  // Overall colour variety: photographing a screen/photo often reduces
  // dynamic range and colour variety compared to a real outdoor scene.
  const { channels } = await img.clone().stats();
  const avgStdev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;
  if (avgStdev < 35) {
    score += 0.3;
    signals.push("low_overall_color_variance");
  }

  const isPhotoOfPhoto = score >= 0.45;

  return {
    name: "photo_of_photo_detection",
    label: "Photo-of-Photo Detection",
    status: isPhotoOfPhoto ? "warning" : "pass", // warning, not hard fail: this heuristic has a higher false-positive rate
    confidence: Math.min(0.75, score), // capped lower than other checks - this is our weakest heuristic
    message: isPhotoOfPhoto
      ? `Image may be a photo of a photo/screen (signals: ${signals.join(", ") || "none"})`
      : "No strong photo-of-photo signals detected",
    details: { score, signals, avgBorderStdev: signals.includes("uniform_border_frame") ? undefined : null, avgColorStdev: avgStdev },
    durationMs: Date.now() - start,
  };
}

function stdev(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let mean = 0;
  for (let i = 0; i < buf.length; i++) mean += buf[i];
  mean /= buf.length;
  let variance = 0;
  for (let i = 0; i < buf.length; i++) variance += (buf[i] - mean) ** 2;
  variance /= buf.length;
  return Math.sqrt(variance);
}
