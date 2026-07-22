import sharp from "sharp";
import { CheckResult } from "../../types/analysis";

const SOFTWARE_SIGNATURES = ["photoshop", "gimp", "lightroom", "snapseed", "picsart", "facetune"];

/**
 * Two complementary tampering signals:
 *
 * 1. Error Level Analysis (ELA): re-encode the image as JPEG at a fixed
 *    quality and diff it against the original at the pixel level. Regions
 *    that were edited/pasted in usually have a different compression
 *    history than the rest of the photo, so they show up as anomalously
 *    high-error blocks relative to the image's own average. We grid the
 *    image and flag if any block's error is a statistical outlier vs the
 *    other blocks (localized inconsistency), not just a high global error
 *    (which just means "low quality photo").
 *
 * 2. EXIF software tag scan: a crude byte-level search for known editor
 *    signatures (Photoshop, GIMP, etc.) in the raw EXIF blob. This is a
 *    weak but essentially free signal when present.
 */
export async function checkTampering(filePath: string): Promise<CheckResult> {
  const start = Date.now();
  const signals: string[] = [];
  let score = 0;
  const details: Record<string, unknown> = {};

  // --- Signal 1: ELA ---
  try {
    const targetWidth = 512;
    const original = await sharp(filePath)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const recompressedBuf = await sharp(filePath)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const recompressed = await sharp(recompressedBuf).raw().toBuffer({ resolveWithObject: true });

    const { data: origData, info } = original;
    const { data: reData } = recompressed;
    const { width, height, channels } = info;

    const blockSize = 16;
    const blockErrors: number[] = [];

    for (let by = 0; by < height; by += blockSize) {
      for (let bx = 0; bx < width; bx += blockSize) {
        let sum = 0;
        let count = 0;
        const maxY = Math.min(by + blockSize, height);
        const maxX = Math.min(bx + blockSize, width);
        for (let y = by; y < maxY; y++) {
          for (let x = bx; x < maxX; x++) {
            const idx = (y * width + x) * channels;
            for (let c = 0; c < channels; c++) {
              sum += Math.abs(origData[idx + c] - reData[idx + c]);
              count++;
            }
          }
        }
        if (count > 0) blockErrors.push(sum / count);
      }
    }

    const mean = blockErrors.reduce((a, b) => a + b, 0) / blockErrors.length;
    const variance = blockErrors.reduce((a, b) => a + (b - mean) ** 2, 0) / blockErrors.length;
    const std = Math.sqrt(variance);
    const outlierThreshold = mean + 3 * std;
    const outlierBlocks = blockErrors.filter((e) => e > outlierThreshold && e > 8).length;
    const outlierRatio = outlierBlocks / blockErrors.length;

    details.ela = { meanBlockError: mean, stdBlockError: std, outlierBlocks, totalBlocks: blockErrors.length, outlierRatio };

    // A handful of localized outlier blocks (not too many, not zero) is the
    // classic signature of a pasted-in / retouched region. If a large
    // fraction of blocks are outliers, that's more consistent with generic
    // heavy compression than a localized edit, so we don't flag it as strongly.
    if (outlierBlocks >= 3 && outlierRatio < 0.35) {
      score += 0.5;
      signals.push("localized_compression_inconsistency");
    }
  } catch (err) {
    details.elaError = (err as Error).message;
  }

  // --- Signal 2: EXIF software tag ---
  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata.exif) {
      const text = metadata.exif.toString("latin1").toLowerCase();
      const found = SOFTWARE_SIGNATURES.filter((sig) => text.includes(sig));
      if (found.length > 0) {
        score += 0.4;
        signals.push(`exif_software_tag:${found.join(",")}`);
      }
    }
  } catch {
    // metadata read failure isn't fatal to this check
  }

  const isSuspicious = score >= 0.4;

  return {
    name: "tampering_heuristics",
    label: "Editing/Tampering Heuristics",
    status: isSuspicious ? "warning" : "pass", // warning: heuristic, not proof of tampering
    confidence: Math.min(0.7, 0.3 + score * 0.4), // deliberately capped - ELA is suggestive, not conclusive
    message: isSuspicious
      ? `Possible signs of editing detected (signals: ${signals.join(", ")})`
      : "No strong tampering signals detected",
    details: { ...details, signals, score },
    durationMs: Date.now() - start,
  };
}
