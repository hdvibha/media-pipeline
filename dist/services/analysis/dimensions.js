"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkDimensions = checkDimensions;
const sharp_1 = __importDefault(require("sharp"));
const env_1 = require("../../config/env");
/**
 * Validates that the image meets a minimum usable resolution. Images below
 * this size are unlikely to be useful for downstream tasks like plate OCR.
 */
async function checkDimensions(filePath) {
    const start = Date.now();
    const metadata = await (0, sharp_1.default)(filePath).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const tooSmall = width < env_1.env.dimensions.minWidth || height < env_1.env.dimensions.minHeight;
    return {
        name: "dimension_validation",
        label: "Dimension Validation",
        status: tooSmall ? "fail" : "pass",
        confidence: 1, // deterministic check, not a probabilistic heuristic
        message: tooSmall
            ? `Image is ${width}x${height}, below the minimum ${env_1.env.dimensions.minWidth}x${env_1.env.dimensions.minHeight}`
            : `Image resolution ${width}x${height} is acceptable`,
        details: { width, height, format: metadata.format, minWidth: env_1.env.dimensions.minWidth, minHeight: env_1.env.dimensions.minHeight },
        durationMs: Date.now() - start,
    };
}
//# sourceMappingURL=dimensions.js.map