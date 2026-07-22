import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "3000", 10),

  databaseUrl: required("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/media_pipeline"),

  redisHost: process.env.REDIS_HOST ?? "localhost",
  redisPort: parseInt(process.env.REDIS_PORT ?? "6379", 10),

  storageDir: process.env.STORAGE_DIR ?? "storage/uploads",
  maxUploadSizeBytes: parseInt(process.env.MAX_UPLOAD_SIZE_BYTES ?? String(15 * 1024 * 1024), 10), // 15MB default

  // Analysis thresholds - tunable without redeploying the analysis logic.
  blur: {
    // Laplacian variance below this is considered blurry. Empirically tuned;
    // see README "Trade-offs" for why this is a heuristic, not a calibrated model.
    varianceThreshold: parseFloat(process.env.BLUR_VARIANCE_THRESHOLD ?? "100"),
  },
  brightness: {
    lowThreshold: parseFloat(process.env.BRIGHTNESS_LOW_THRESHOLD ?? "60"), // 0-255 scale
    highThreshold: parseFloat(process.env.BRIGHTNESS_HIGH_THRESHOLD ?? "235"),
  },
  duplicate: {
    // Hamming distance between perceptual hashes below which two images are
    // considered duplicates/near-duplicates.
    hammingDistanceThreshold: parseInt(process.env.DUPLICATE_HAMMING_THRESHOLD ?? "6", 10),
  },
  dimensions: {
    minWidth: parseInt(process.env.MIN_WIDTH ?? "480", 10),
    minHeight: parseInt(process.env.MIN_HEIGHT ?? "360", 10),
  },

  queueName: "image-analysis",
  queueConcurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? "2", 10),
  maxJobAttempts: parseInt(process.env.MAX_JOB_ATTEMPTS ?? "3", 10),

  logLevel: process.env.LOG_LEVEL ?? "info",
};
