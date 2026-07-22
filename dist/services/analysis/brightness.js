"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBrightness = checkBrightness;
const sharp_1 = __importDefault(require("sharp"));
const env_1 = require("../../config/env");
/**
 * Estimates overall brightness via mean luminance of the greyscale image
 * (0 = black, 255 = white). Flags images that are likely low-light or
 * blown-out/overexposed.
 */
async function checkBrightness(filePath) {
    const start = Date.now();
    const { channels } = await (0, sharp_1.default)(filePath).greyscale().stats();
    const meanLuminance = channels[0].mean;
    let status = "pass";
    let message = `Mean luminance ${meanLuminance.toFixed(1)} is within a normal range`;
    if (meanLuminance < env_1.env.brightness.lowThreshold) {
        status = "fail";
        message = `Image appears low-light (mean luminance ${meanLuminance.toFixed(1)} < ${env_1.env.brightness.lowThreshold})`;
    }
    else if (meanLuminance > env_1.env.brightness.highThreshold) {
        status = "warning";
        message = `Image appears overexposed (mean luminance ${meanLuminance.toFixed(1)} > ${env_1.env.brightness.highThreshold})`;
    }
    // Confidence scales with distance from thresholds - a value right at the
    // boundary is a weaker signal than one deep in low-light territory.
    const distance = status === "fail"
        ? (env_1.env.brightness.lowThreshold - meanLuminance) / env_1.env.brightness.lowThreshold
        : status === "warning"
            ? (meanLuminance - env_1.env.brightness.highThreshold) / (255 - env_1.env.brightness.highThreshold)
            : 0;
    const confidence = status === "pass" ? 0.9 : Math.min(0.95, 0.6 + Math.max(0, distance) * 0.4);
    return {
        name: "brightness_analysis",
        label: "Brightness Analysis",
        status,
        confidence,
        message,
        details: { meanLuminance, lowThreshold: env_1.env.brightness.lowThreshold, highThreshold: env_1.env.brightness.highThreshold },
        durationMs: Date.now() - start,
    };
}
//# sourceMappingURL=brightness.js.map