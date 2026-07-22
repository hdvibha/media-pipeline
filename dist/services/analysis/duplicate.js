"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkDuplicate = checkDuplicate;
const prisma_1 = require("../../db/prisma");
const env_1 = require("../../config/env");
const phash_1 = require("./phash");
/**
 * Duplicate detection compares this image's perceptual hash against all
 * other images' hashes already stored. This is O(N) per upload - fine at
 * the scale of a take-home / small deployment, but a real system would
 * bucket hashes (e.g. by hash prefix / LSH) or use a vector index once N
 * grows large. Documented under Trade-offs / scalability in the README.
 */
async function checkDuplicate(filePath, currentImageId) {
    const start = Date.now();
    const hash = await (0, phash_1.computeDHash)(filePath);
    const candidates = await prisma_1.prisma.image.findMany({
        where: {
            id: { not: currentImageId },
            perceptualHash: { not: null },
        },
        select: { id: true, perceptualHash: true, originalFilename: true },
    });
    let bestMatch = null;
    for (const candidate of candidates) {
        if (!candidate.perceptualHash)
            continue;
        const distance = (0, phash_1.hammingDistanceHex)(hash, candidate.perceptualHash);
        if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = { id: candidate.id, filename: candidate.originalFilename, distance };
        }
    }
    const isDuplicate = !!bestMatch && bestMatch.distance <= env_1.env.duplicate.hammingDistanceThreshold;
    const result = {
        name: "duplicate_detection",
        label: "Duplicate Detection",
        status: isDuplicate ? "fail" : "pass",
        confidence: isDuplicate
            ? Math.min(0.95, 1 - bestMatch.distance / (env_1.env.duplicate.hammingDistanceThreshold * 2))
            : 0.8,
        message: isDuplicate
            ? `Likely duplicate of image ${bestMatch.id} (hamming distance ${bestMatch.distance})`
            : bestMatch
                ? `No duplicate found (closest match hamming distance ${bestMatch.distance})`
                : "No duplicate found (no prior images to compare against)",
        details: {
            perceptualHash: hash,
            threshold: env_1.env.duplicate.hammingDistanceThreshold,
            closestMatch: bestMatch,
            candidatesCompared: candidates.length,
        },
        durationMs: Date.now() - start,
    };
    return { result, hash };
}
//# sourceMappingURL=duplicate.js.map