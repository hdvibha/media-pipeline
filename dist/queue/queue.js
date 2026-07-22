"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analysisQueue = exports.connection = void 0;
exports.enqueueAnalysisJob = enqueueAnalysisJob;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("../config/env");
exports.connection = new ioredis_1.default({
    host: env_1.env.redisHost,
    port: env_1.env.redisPort,
    maxRetriesPerRequest: null, // required by BullMQ for blocking connections
});
exports.analysisQueue = new bullmq_1.Queue(env_1.env.queueName, {
    connection: exports.connection,
    defaultJobOptions: {
        attempts: env_1.env.maxJobAttempts,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // keep 24h / last 1000 for debugging
        removeOnFail: { age: 60 * 60 * 24 * 7 }, // keep failed jobs a week for investigation
    },
});
async function enqueueAnalysisJob(imageId) {
    await exports.analysisQueue.add("analyze-image", { imageId }, { jobId: imageId });
}
//# sourceMappingURL=queue.js.map