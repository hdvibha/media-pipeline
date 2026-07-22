"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAnalysisPipeline = runAnalysisPipeline;
const dimensions_1 = require("./dimensions");
const brightness_1 = require("./brightness");
const blur_1 = require("./blur");
const duplicate_1 = require("./duplicate");
const screenshot_1 = require("./screenshot");
const photoOfPhoto_1 = require("./photoOfPhoto");
const tampering_1 = require("./tampering");
const plateOcr_1 = require("./plateOcr");
const logger_1 = require("../../utils/logger");
/**
 * Maps a check's machine name + status to a stable "issue code" surfaced in
 * the API response. Only fail/warning statuses become issues; "pass",
 * "skipped" and "error" (logged separately) do not.
 */
const ISSUE_CODE_MAP = {
    blur_detection: "blurry",
    brightness_analysis: "low_light_or_overexposed",
    duplicate_detection: "duplicate_image",
    screenshot_detection: "screenshot_detected",
    photo_of_photo_detection: "photo_of_photo_suspected",
    tampering_heuristics: "possible_editing_detected",
    plate_ocr_validation: "invalid_or_missing_plate",
    dimension_validation: "resolution_too_low",
};
async function runAnalysisPipeline(ctx) {
    const checks = [];
    // Independent, side-effect-free checks run concurrently for throughput.
    const [dimensionsResult, brightnessResult, blurResult, screenshotResult, photoOfPhotoResult, tamperingResult, plateResult] = await Promise.all([
        safeRun(() => (0, dimensions_1.checkDimensions)(ctx.filePath), "dimension_validation"),
        safeRun(() => (0, brightness_1.checkBrightness)(ctx.filePath), "brightness_analysis"),
        safeRun(() => (0, blur_1.checkBlur)(ctx.filePath), "blur_detection"),
        safeRun(() => (0, screenshot_1.checkScreenshot)(ctx.filePath), "screenshot_detection"),
        safeRun(() => (0, photoOfPhoto_1.checkPhotoOfPhoto)(ctx.filePath), "photo_of_photo_detection"),
        safeRun(() => (0, tampering_1.checkTampering)(ctx.filePath), "tampering_heuristics"),
        safeRun(() => (0, plateOcr_1.checkPlateOcr)(ctx.filePath), "plate_ocr_validation"),
    ]);
    checks.push(dimensionsResult, brightnessResult, blurResult, screenshotResult, photoOfPhotoResult, tamperingResult, plateResult);
    // Duplicate detection reads from the DB (needs other rows to compare
    // against) so it runs after / separately rather than in the batch above -
    // keeps the concurrency model simple and avoids a race where two images
    // uploaded in the same instant don't see each other's hash yet.
    const { result: duplicateResult, hash } = await (0, duplicate_1.checkDuplicate)(ctx.filePath, ctx.imageId);
    checks.push(duplicateResult);
    const issues = checks
        .filter((c) => c.status === "fail" || c.status === "warning")
        .map((c) => ISSUE_CODE_MAP[c.name] ?? c.name);
    const hasHardFailure = checks.some((c) => c.status === "fail");
    const hasWarning = checks.some((c) => c.status === "warning");
    const overallVerdict = hasHardFailure || hasWarning ? "flagged" : "clean";
    const plateCheck = plateResult;
    const report = {
        imageId: ctx.imageId,
        checks,
        issues,
        overallVerdict,
        extractedText: plateCheck.extractedText,
        plateNumber: plateCheck.plateNumber ?? null,
        plateValid: plateCheck.plateValid ?? null,
        generatedAt: new Date().toISOString(),
    };
    return { report, perceptualHash: hash };
}
async function safeRun(fn, name) {
    try {
        return await fn();
    }
    catch (err) {
        logger_1.logger.error({ err, check: name }, "analysis check threw unexpectedly");
        return {
            name,
            label: name,
            status: "error",
            confidence: 0,
            message: `Check crashed: ${err.message}`,
        };
    }
}
//# sourceMappingURL=index.js.map