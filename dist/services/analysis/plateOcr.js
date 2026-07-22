"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANDIDATE_REGIONS = void 0;
exports.normalizeOcrText = normalizeOcrText;
exports.findPlateCandidate = findPlateCandidate;
exports.regionToPixelBox = regionToPixelBox;
exports.checkPlateOcr = checkPlateOcr;
exports.shutdownOcrWorker = shutdownOcrWorker;
const sharp_1 = __importDefault(require("sharp"));
const tesseract_js_1 = require("tesseract.js");
// Standard Indian registration plate format, e.g. "KA05MH1234" or "MH12AB1234":
// 2 letters (state) + 1-2 digits (RTO code) + 1-3 letters (series) + 4 digits (number).
// Some newer formats include a leading digit for the year batch; we cover the common case.
const INDIAN_PLATE_REGEX = /\b([A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4})\b/;
function normalizeOcrText(raw) {
    return raw.toUpperCase().replace(/[^A-Z0-9\s]/g, " ");
}
function findPlateCandidate(normalizedText) {
    // Match per-line rather than across the whole OCR blob. Compacting
    // whitespace across the entire document (e.g. "KARNATAKA\nKA 05 MH 1234")
    // can glue unrelated words directly onto the plate digits and destroy the
    // \b word boundary the regex relies on, so we scope compaction to one
    // line at a time instead.
    const lines = normalizedText.split(/\n+/);
    for (const line of lines) {
        // Prefer a match against the line as-is (handles OCR getting the
        // spacing right, or getting it wrong in ways that don't matter).
        const spacedMatch = line.match(INDIAN_PLATE_REGEX);
        if (spacedMatch)
            return spacedMatch[1];
        // Fall back to a fully compacted version of just this line (handles
        // OCR inserting a spurious space/newline in the middle of the plate
        // itself, e.g. "KA 05 MH 1234").
        const compact = line.replace(/\s+/g, "");
        const compactMatch = compact.match(INDIAN_PLATE_REGEX);
        if (compactMatch)
            return compactMatch[1];
    }
    return null;
}
let workerPromise = null;
async function getWorker() {
    if (!workerPromise) {
        workerPromise = (0, tesseract_js_1.createWorker)("eng");
    }
    return workerPromise;
}
/**
 * Lightweight plate localization heuristic: no object detector, just a
 * prioritized list of crop windows based on where registration plates
 * typically sit in a full-vehicle photo (front/rear, roughly centered,
 * lower half of the frame). Ordered from tightest/highest-precision to
 * widest, so the loop in checkPlateOcr can stop as soon as one hits
 * instead of paying for every region on every image. The full frame is
 * always included last as a fallback so behavior never regresses below
 * the previous "OCR the whole image" approach.
 */
exports.CANDIDATE_REGIONS = [
    { name: "bottom_center", xFrac: [0.15, 0.85], yFrac: [0.6, 0.95] },
    { name: "bottom_band", xFrac: [0, 1], yFrac: [0.55, 1.0] },
    { name: "bottom_left", xFrac: [0, 0.5], yFrac: [0.55, 1.0] },
    { name: "bottom_right", xFrac: [0.5, 1.0], yFrac: [0.55, 1.0] },
    { name: "full_frame", xFrac: [0, 1], yFrac: [0, 1] },
];
/** Minimum width (px) a crop is upscaled to before OCR - small crops of a
 * plate region are often only ~150-250px wide straight out of the source
 * photo, which is too low-res for Tesseract to read reliably. */
const OCR_UPSCALE_TARGET_WIDTH = 640;
function regionToPixelBox(region, imageWidth, imageHeight) {
    const left = Math.round(region.xFrac[0] * imageWidth);
    const top = Math.round(region.yFrac[0] * imageHeight);
    const right = Math.round(region.xFrac[1] * imageWidth);
    const bottom = Math.round(region.yFrac[1] * imageHeight);
    return {
        left: Math.max(0, left),
        top: Math.max(0, top),
        width: Math.max(1, Math.min(imageWidth, right) - Math.max(0, left)),
        height: Math.max(1, Math.min(imageHeight, bottom) - Math.max(0, top)),
    };
}
/**
 * Crops to the given region, upscales small crops for OCR legibility, and
 * boosts contrast - all of which matter a lot more once we're OCR-ing a
 * small plate-sized crop instead of a whole photo.
 */
async function prepareRegionBuffer(filePath, region, imageWidth, imageHeight) {
    const box = regionToPixelBox(region, imageWidth, imageHeight);
    let pipeline = (0, sharp_1.default)(filePath).extract(box);
    if (box.width < OCR_UPSCALE_TARGET_WIDTH) {
        pipeline = pipeline.resize({ width: OCR_UPSCALE_TARGET_WIDTH, kernel: "cubic" });
    }
    return pipeline.grayscale().normalize().sharpen().toBuffer();
}
/**
 * Runs OCR against a prioritized sequence of crop regions (see
 * CANDIDATE_REGIONS) instead of the full frame, stopping as soon as one
 * region yields text matching the Indian plate format. This replaces the
 * previous "OCR the whole image" approach (see README trade-offs), which
 * struggled badly whenever the plate was small relative to a busy frame -
 * e.g. vehicles with large ad wraps, where Tesseract's output was dominated
 * by unrelated banner text and the plate was never resolved.
 *
 * Falls back to the full frame if no cropped region produces a match, so a
 * plate that happens to fill most of the photo (or a photo of just a plate)
 * is still handled at least as well as before.
 */
async function checkPlateOcr(filePath) {
    const start = Date.now();
    try {
        const worker = await getWorker();
        const metadata = await (0, sharp_1.default)(filePath).metadata();
        const imageWidth = metadata.width;
        const imageHeight = metadata.height;
        // If we can't read dimensions for some reason, fall back straight to
        // whole-image OCR rather than failing the check outright.
        const regions = imageWidth && imageHeight ? exports.CANDIDATE_REGIONS : [];
        let bestPlate = null;
        let bestConfidence = 0;
        let bestRegionName = "full_frame";
        let lastRawText = "";
        const regionsAttempted = [];
        // TEMPORARY DIAGNOSTIC - per-region OCR output, so we can see what each
        // candidate crop actually extracted (not just whichever region ran
        // last). Remove once the region geometry / preprocessing is tuned.
        const regionDebug = [];
        for (const region of regions) {
            regionsAttempted.push(region.name);
            const box = region.name !== "full_frame" && imageWidth && imageHeight ? regionToPixelBox(region, imageWidth, imageHeight) : undefined;
            const input = region.name === "full_frame"
                ? filePath
                : await prepareRegionBuffer(filePath, region, imageWidth, imageHeight);
            const { data } = await worker.recognize(input);
            const rawText = data.text?.trim() ?? "";
            lastRawText = rawText;
            const normalized = normalizeOcrText(rawText);
            const plate = findPlateCandidate(normalized);
            const ocrConfidence = (data.confidence ?? 0) / 100;
            regionDebug.push({
                region: region.name,
                textLength: rawText.length,
                snippet: rawText.replace(/\s+/g, " ").slice(0, 120),
                ocrConfidence,
                box,
            });
            if (plate) {
                bestPlate = plate;
                bestConfidence = ocrConfidence;
                bestRegionName = region.name;
                break; // good match found - skip remaining (wider/lower-precision) regions
            }
        }
        // If nothing in the loop above ran (e.g. missing metadata) or no crop
        // matched, make sure we always have at least the full-frame OCR text on
        // hand for the human-reviewer fallback.
        if (regionsAttempted.length === 0 || (!bestPlate && !regionsAttempted.includes("full_frame"))) {
            const { data } = await worker.recognize(filePath);
            lastRawText = data.text?.trim() ?? "";
            const normalized = normalizeOcrText(lastRawText);
            const plate = findPlateCandidate(normalized);
            if (plate) {
                bestPlate = plate;
                bestConfidence = (data.confidence ?? 0) / 100;
                bestRegionName = "full_frame";
            }
        }
        const status = bestPlate ? "pass" : "fail";
        return {
            name: "plate_ocr_validation",
            label: "Vehicle Plate OCR & Format Validation",
            status,
            confidence: bestPlate ? Math.max(0.4, bestConfidence) : 0.5,
            message: bestPlate
                ? `Detected plate "${bestPlate}" matching Indian registration format (region: ${bestRegionName})`
                : "No text matching the Indian vehicle plate format was found in any candidate region",
            details: {
                regionsAttempted,
                matchedRegion: bestPlate ? bestRegionName : null,
                rawTextLength: lastRawText.length,
                regionDebug,
            },
            durationMs: Date.now() - start,
            extractedText: lastRawText,
            plateNumber: bestPlate,
            plateValid: !!bestPlate,
        };
    }
    catch (err) {
        return {
            name: "plate_ocr_validation",
            label: "Vehicle Plate OCR & Format Validation",
            status: "error",
            confidence: 0,
            message: `OCR failed to run: ${err.message}`,
            durationMs: Date.now() - start,
            extractedText: "",
            plateNumber: null,
            plateValid: false,
        };
    }
}
async function shutdownOcrWorker() {
    if (workerPromise) {
        const worker = await workerPromise;
        await worker.terminate();
        workerPromise = null;
    }
}
//# sourceMappingURL=plateOcr.js.map