"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.worker = void 0;
const bullmq_1 = require("bullmq");
const queue_1 = require("./queue");
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
const storage_service_1 = require("../services/storage.service");
const analysis_1 = require("../services/analysis");
const logger_1 = require("../utils/logger");
const plateOcr_1 = require("../services/analysis/plateOcr");
/**
 * Processes one image analysis job end to end:
 *   pending -> processing -> (completed | failed)
 *
 * Status transitions are written to Postgres so the API layer can answer
 * status/result queries without touching the queue at all - the queue is an
 * implementation detail of "how work gets scheduled", not the source of
 * truth for state.
 */
async function processJob(job) {
    const { imageId } = job.data;
    const log = logger_1.logger.child({ imageId, jobId: job.id, attempt: job.attemptsMade + 1 });
    const image = await prisma_1.prisma.image.findUnique({ where: { id: imageId } });
    if (!image) {
        log.error("image record not found - dropping job");
        return; // no point retrying, the row doesn't exist
    }
    await prisma_1.prisma.image.update({
        where: { id: imageId },
        data: { status: "processing", processingStartedAt: new Date(), attempts: { increment: 1 } },
    });
    log.info("processing started");
    try {
        const filePath = storage_service_1.storageService.resolvePath(image.storagePath);
        const { report, perceptualHash } = await (0, analysis_1.runAnalysisPipeline)({
            imageId,
            filePath,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
        });
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.image.update({
                where: { id: imageId },
                data: {
                    status: "completed",
                    perceptualHash,
                    processingCompletedAt: new Date(),
                    failureReason: null,
                },
            }),
            prisma_1.prisma.analysisResult.upsert({
                where: { imageId },
                create: {
                    imageId,
                    overallVerdict: report.overallVerdict,
                    issues: report.issues,
                    checks: report.checks,
                    extractedText: report.extractedText,
                    plateNumber: report.plateNumber,
                    plateValid: report.plateValid,
                },
                update: {
                    overallVerdict: report.overallVerdict,
                    issues: report.issues,
                    checks: report.checks,
                    extractedText: report.extractedText,
                    plateNumber: report.plateNumber,
                    plateValid: report.plateValid,
                },
            }),
        ]);
        log.info({ verdict: report.overallVerdict, issues: report.issues }, "processing completed");
    }
    catch (err) {
        const message = err.message;
        log.error({ err }, "processing failed");
        const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? env_1.env.maxJobAttempts);
        if (isFinalAttempt) {
            await prisma_1.prisma.image.update({
                where: { id: imageId },
                data: { status: "failed", failureReason: message, processingCompletedAt: new Date() },
            });
        }
        // Re-throw so BullMQ registers the failure and applies backoff/retry.
        throw err;
    }
}
exports.worker = new bullmq_1.Worker(env_1.env.queueName, processJob, {
    connection: queue_1.connection,
    concurrency: env_1.env.queueConcurrency,
});
exports.worker.on("failed", (job, err) => {
    logger_1.logger.warn({ jobId: job?.id, err: err.message, attemptsMade: job?.attemptsMade }, "job failed");
});
exports.worker.on("completed", (job) => {
    logger_1.logger.debug({ jobId: job.id }, "job completed");
});
logger_1.logger.info({ concurrency: env_1.env.queueConcurrency }, "analysis worker started");
async function shutdown() {
    logger_1.logger.info("shutting down worker...");
    await exports.worker.close();
    await (0, plateOcr_1.shutdownOcrWorker)();
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
//# sourceMappingURL=worker.js.map