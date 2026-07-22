import { Worker, Job } from "bullmq";
import { connection, AnalysisJobData } from "./queue";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { storageService } from "../services/storage.service";
import { runAnalysisPipeline } from "../services/analysis";
import { logger } from "../utils/logger";
import { shutdownOcrWorker } from "../services/analysis/plateOcr";

/**
 * Processes one image analysis job end to end:
 *   pending -> processing -> (completed | failed)
 *
 * Status transitions are written to Postgres so the API layer can answer
 * status/result queries without touching the queue at all - the queue is an
 * implementation detail of "how work gets scheduled", not the source of
 * truth for state.
 */
async function processJob(job: Job<AnalysisJobData>): Promise<void> {
  const { imageId } = job.data;
  const log = logger.child({ imageId, jobId: job.id, attempt: job.attemptsMade + 1 });

  const image = await prisma.image.findUnique({ where: { id: imageId } });
  if (!image) {
    log.error("image record not found - dropping job");
    return; // no point retrying, the row doesn't exist
  }

  await prisma.image.update({
    where: { id: imageId },
    data: { status: "processing", processingStartedAt: new Date(), attempts: { increment: 1 } },
  });
  log.info("processing started");

  try {
    const filePath = storageService.resolvePath(image.storagePath);
    const { report, perceptualHash } = await runAnalysisPipeline({
      imageId,
      filePath,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    });

    await prisma.$transaction([
      prisma.image.update({
        where: { id: imageId },
        data: {
          status: "completed",
          perceptualHash,
          processingCompletedAt: new Date(),
          failureReason: null,
        },
      }),
      prisma.analysisResult.upsert({
        where: { imageId },
        create: {
          imageId,
          overallVerdict: report.overallVerdict,
          issues: report.issues,
          checks: report.checks as unknown as object,
          extractedText: report.extractedText,
          plateNumber: report.plateNumber,
          plateValid: report.plateValid,
        },
        update: {
          overallVerdict: report.overallVerdict,
          issues: report.issues,
          checks: report.checks as unknown as object,
          extractedText: report.extractedText,
          plateNumber: report.plateNumber,
          plateValid: report.plateValid,
        },
      }),
    ]);

    log.info({ verdict: report.overallVerdict, issues: report.issues }, "processing completed");
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err }, "processing failed");

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? env.maxJobAttempts);
    if (isFinalAttempt) {
      await prisma.image.update({
        where: { id: imageId },
        data: { status: "failed", failureReason: message, processingCompletedAt: new Date() },
      });
    }
    // Re-throw so BullMQ registers the failure and applies backoff/retry.
    throw err;
  }
}

export const worker = new Worker<AnalysisJobData>(env.queueName, processJob, {
  connection,
  concurrency: env.queueConcurrency,
});

worker.on("failed", (job, err) => {
  logger.warn({ jobId: job?.id, err: err.message, attemptsMade: job?.attemptsMade }, "job failed");
});

worker.on("completed", (job) => {
  logger.debug({ jobId: job.id }, "job completed");
});

logger.info({ concurrency: env.queueConcurrency }, "analysis worker started");

async function shutdown() {
  logger.info("shutting down worker...");
  await worker.close();
  await shutdownOcrWorker();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
