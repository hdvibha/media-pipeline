import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

export const connection = new IORedis({
  host: env.redisHost,
  port: env.redisPort,
  maxRetriesPerRequest: null, // required by BullMQ for blocking connections
});

export interface AnalysisJobData {
  imageId: string;
}

export const analysisQueue = new Queue<AnalysisJobData>(env.queueName, {
  connection,
  defaultJobOptions: {
    attempts: env.maxJobAttempts,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // keep 24h / last 1000 for debugging
    removeOnFail: { age: 60 * 60 * 24 * 7 }, // keep failed jobs a week for investigation
  },
});

export async function enqueueAnalysisJob(imageId: string): Promise<void> {
  await analysisQueue.add("analyze-image", { imageId }, { jobId: imageId });
}
