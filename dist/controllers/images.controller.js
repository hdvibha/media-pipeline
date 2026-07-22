"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadImage = uploadImage;
exports.getStatus = getStatus;
exports.getResults = getResults;
exports.listImages = listImages;
exports.getImage = getImage;
const sharp_1 = __importDefault(require("sharp"));
const prisma_1 = require("../db/prisma");
const storage_service_1 = require("../services/storage.service");
const queue_1 = require("../queue/queue");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
/**
 * POST /api/images
 * Accepts a single image, persists it + a metadata row synchronously, then
 * hands off analysis to the queue and returns immediately with a processing
 * ID. This is the "accept fast, process later" contract the assignment asks
 * for - the client never waits on analysis to get a response.
 */
async function uploadImage(req, res) {
    const file = req.file;
    if (!file) {
        throw new errorHandler_1.ApiError(400, "No image file provided. Send multipart/form-data with field name 'image'.");
    }
    // Validate it's actually a decodable image (protects against files that
    // pass the mimetype sniff but are corrupt/not really images) and capture
    // dimensions up front for the metadata row.
    let width;
    let height;
    try {
        const metadata = await (0, sharp_1.default)(file.buffer).metadata();
        width = metadata.width;
        height = metadata.height;
    }
    catch {
        throw new errorHandler_1.ApiError(400, "Uploaded file could not be decoded as an image.");
    }
    const { storagePath } = await storage_service_1.storageService.save(file.originalname, file.buffer);
    const image = await prisma_1.prisma.image.create({
        data: {
            originalFilename: file.originalname,
            storagePath,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            width,
            height,
            status: "pending",
        },
    });
    await (0, queue_1.enqueueAnalysisJob)(image.id);
    logger_1.logger.info({ imageId: image.id }, "image uploaded and queued for analysis");
    res.status(202).json({
        id: image.id,
        status: image.status,
        createdAt: image.createdAt,
        statusUrl: `/api/images/${image.id}/status`,
        resultsUrl: `/api/images/${image.id}/results`,
    });
}
/** GET /api/images/:id/status */
async function getStatus(req, res) {
    const image = await prisma_1.prisma.image.findUnique({
        where: { id: req.params.id },
        select: {
            id: true,
            status: true,
            failureReason: true,
            attempts: true,
            createdAt: true,
            processingStartedAt: true,
            processingCompletedAt: true,
        },
    });
    if (!image)
        throw new errorHandler_1.ApiError(404, "Image not found");
    res.json(image);
}
/** GET /api/images/:id/results */
async function getResults(req, res) {
    const image = await prisma_1.prisma.image.findUnique({
        where: { id: req.params.id },
        include: { analysis: true },
    });
    if (!image)
        throw new errorHandler_1.ApiError(404, "Image not found");
    if (image.status !== "completed") {
        res.status(409).json({
            id: image.id,
            status: image.status,
            failureReason: image.failureReason,
            message: image.status === "failed"
                ? "Analysis failed - see failureReason. You may re-upload the image to retry."
                : "Analysis is not complete yet. Poll GET /api/images/:id/status until status is 'completed'.",
        });
        return;
    }
    if (!image.analysis) {
        // Shouldn't happen if status === completed, but guard defensively.
        throw new errorHandler_1.ApiError(500, "Image marked completed but analysis result is missing");
    }
    res.json({
        id: image.id,
        status: image.status,
        overallVerdict: image.analysis.overallVerdict,
        issues: image.analysis.issues,
        checks: image.analysis.checks,
        plateNumber: image.analysis.plateNumber,
        plateValid: image.analysis.plateValid,
        extractedText: image.analysis.extractedText,
        completedAt: image.processingCompletedAt,
    });
}
/** GET /api/images - lightweight listing/pagination, useful for a dashboard or debugging */
async function listImages(req, res) {
    const limit = Math.min(100, parseInt(String(req.query.limit ?? "20"), 10) || 20);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const images = await prisma_1.prisma.image.findMany({
        take: limit,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        where: statusFilter ? { status: statusFilter } : undefined,
        orderBy: { createdAt: "desc" },
        include: { analysis: { select: { overallVerdict: true, issues: true } } },
    });
    res.json({
        items: images,
        nextCursor: images.length === limit ? images[images.length - 1].id : null,
    });
}
/** GET /api/images/:id - full metadata for a single image */
async function getImage(req, res) {
    const image = await prisma_1.prisma.image.findUnique({
        where: { id: req.params.id },
        include: { analysis: true },
    });
    if (!image)
        throw new errorHandler_1.ApiError(404, "Image not found");
    res.json(image);
}
//# sourceMappingURL=images.controller.js.map