import { prisma } from "../../db/prisma";
import { env } from "../../config/env";
import { CheckResult } from "../../types/analysis";
import { computeDHash, hammingDistanceHex } from "./phash";

/**
 * Duplicate detection compares this image's perceptual hash against all
 * other images' hashes already stored. This is O(N) per upload - fine at
 * the scale of a take-home / small deployment, but a real system would
 * bucket hashes (e.g. by hash prefix / LSH) or use a vector index once N
 * grows large. Documented under Trade-offs / scalability in the README.
 */
export async function checkDuplicate(
  filePath: string,
  currentImageId: string
): Promise<{ result: CheckResult; hash: string }> {
  const start = Date.now();
  const hash = await computeDHash(filePath);

  const candidates = await prisma.image.findMany({
    where: {
      id: { not: currentImageId },
      perceptualHash: { not: null },
    },
    select: { id: true, perceptualHash: true, originalFilename: true },
  });

  let bestMatch: { id: string; filename: string; distance: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.perceptualHash) continue;
    const distance = hammingDistanceHex(hash, candidate.perceptualHash);
    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { id: candidate.id, filename: candidate.originalFilename, distance };
    }
  }

  const isDuplicate = !!bestMatch && bestMatch.distance <= env.duplicate.hammingDistanceThreshold;

  const result: CheckResult = {
    name: "duplicate_detection",
    label: "Duplicate Detection",
    status: isDuplicate ? "fail" : "pass",
    confidence: isDuplicate
      ? Math.min(0.95, 1 - bestMatch!.distance / (env.duplicate.hammingDistanceThreshold * 2))
      : 0.8,
    message: isDuplicate
      ? `Likely duplicate of image ${bestMatch!.id} (hamming distance ${bestMatch!.distance})`
      : bestMatch
        ? `No duplicate found (closest match hamming distance ${bestMatch.distance})`
        : "No duplicate found (no prior images to compare against)",
    details: {
      perceptualHash: hash,
      threshold: env.duplicate.hammingDistanceThreshold,
      closestMatch: bestMatch,
      candidatesCompared: candidates.length,
    },
    durationMs: Date.now() - start,
  };

  return { result, hash };
}
