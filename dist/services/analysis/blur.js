"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBlur = checkBlur;
const sharp_1 = __importDefault(require("sharp"));
const env_1 = require("../../config/env");
const LAPLACIAN_KERNEL = [0, 1, 0, 1, -4, 1, 0, 1, 0];
/**
 * Classic "variance of Laplacian" blur metric (same idea OpenCV tutorials
 * use): convolve a greyscale image with a Laplacian kernel and look at the
 * variance of the result. Sharp images have lots of high-frequency edge
 * content -> high variance. Blurry images are smooth -> low variance.
 *
 * We downscale to a fixed width first for two reasons: (1) performance -
 * this is a hand-rolled convolution in JS, not vectorized, and (2) so the
 * threshold is comparable across images of different resolutions (variance
 * naturally scales with image detail density).
 */
async function laplacianVariance(filePath) {
    const targetWidth = 400;
    const { data, info } = await (0, sharp_1.default)(filePath)
        .resize({ width: targetWidth, withoutEnlargement: true })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const laplacianValues = new Float64Array((width - 2) * (height - 2));
    let idx = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let sum = 0;
            let k = 0;
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    sum += data[(y + ky) * width + (x + kx)] * LAPLACIAN_KERNEL[k];
                    k++;
                }
            }
            laplacianValues[idx++] = sum;
        }
    }
    let mean = 0;
    for (let i = 0; i < laplacianValues.length; i++)
        mean += laplacianValues[i];
    mean /= laplacianValues.length;
    let variance = 0;
    for (let i = 0; i < laplacianValues.length; i++) {
        const d = laplacianValues[i] - mean;
        variance += d * d;
    }
    variance /= laplacianValues.length;
    return { variance, width, height };
}
async function checkBlur(filePath) {
    const start = Date.now();
    try {
        const { variance } = await laplacianVariance(filePath);
        const threshold = env_1.env.blur.varianceThreshold;
        const isBlurry = variance < threshold;
        // Distance from threshold, normalized, gives a rough confidence signal.
        // This is NOT a calibrated probability - see README trade-offs.
        const confidence = Math.min(0.95, 0.5 + Math.abs(variance - threshold) / (threshold * 2));
        return {
            name: "blur_detection",
            label: "Blur Detection",
            status: isBlurry ? "fail" : "pass",
            confidence,
            message: isBlurry
                ? `Image appears blurry (Laplacian variance ${variance.toFixed(1)} < threshold ${threshold})`
                : `Image appears sharp (Laplacian variance ${variance.toFixed(1)} >= threshold ${threshold})`,
            details: { laplacianVariance: variance, threshold },
            durationMs: Date.now() - start,
        };
    }
    catch (err) {
        return {
            name: "blur_detection",
            label: "Blur Detection",
            status: "error",
            confidence: 0,
            message: `Blur check failed to run: ${err.message}`,
            durationMs: Date.now() - start,
        };
    }
}
//# sourceMappingURL=blur.js.map