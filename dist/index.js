"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const pino_http_1 = __importDefault(require("pino-http"));
const env_1 = require("./config/env");
const logger_1 = require("./utils/logger");
const images_routes_1 = require("./routes/images.routes");
const errorHandler_1 = require("./middleware/errorHandler");
const prisma_1 = require("./db/prisma");
const queue_1 = require("./queue/queue");
const app = (0, express_1.default)();
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, pino_http_1.default)({ logger: logger_1.logger }));
app.get("/health", async (_req, res) => {
    const checks = { database: "ok", redis: "ok" };
    try {
        await prisma_1.prisma.$queryRaw `SELECT 1`;
    }
    catch {
        checks.database = "error";
    }
    try {
        await queue_1.connection.ping();
    }
    catch {
        checks.redis = "error";
    }
    const healthy = Object.values(checks).every((v) => v === "ok");
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});
app.use("/api/images", images_routes_1.imagesRouter);
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});
app.use(errorHandler_1.errorHandler);
const server = app.listen(env_1.env.port, () => {
    logger_1.logger.info(`API server listening on port ${env_1.env.port}`);
});
async function shutdown() {
    logger_1.logger.info("shutting down API server...");
    server.close();
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
//# sourceMappingURL=index.js.map