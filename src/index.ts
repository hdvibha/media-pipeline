import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { imagesRouter } from "./routes/images.routes";
import { errorHandler } from "./middleware/errorHandler";
import { prisma } from "./db/prisma";
import { connection as redisConnection } from "./queue/queue";

const app = express();
app.use(express.static(path.resolve("public")));
app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public", "index.html"));
});
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get("/health", async (_req, res) => {
  const checks: Record<string, "ok" | "error"> = { database: "ok", redis: "ok" };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.database = "error";
  }
  try {
    await redisConnection.ping();
  } catch {
    checks.redis = "error";
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});

app.use("/api/images", imagesRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

const server = app.listen(env.port, () => {
  logger.info(`API server listening on port ${env.port}`);
});

async function shutdown() {
  logger.info("shutting down API server...");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
