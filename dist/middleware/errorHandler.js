"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = void 0;
exports.errorHandler = errorHandler;
const multer_1 = require("multer");
const logger_1 = require("../utils/logger");
class ApiError extends Error {
    statusCode;
    details;
    constructor(statusCode, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
    }
}
exports.ApiError = ApiError;
function errorHandler(err, req, res, _next) {
    if (err instanceof ApiError) {
        res.status(err.statusCode).json({ error: err.message, details: err.details });
        return;
    }
    if (err instanceof multer_1.MulterError) {
        res.status(400).json({ error: `Upload error: ${err.message}` });
        return;
    }
    if (err instanceof Error && err.message.startsWith("Unsupported file type")) {
        res.status(400).json({ error: err.message });
        return;
    }
    logger_1.logger.error({ err, path: req.path }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
}
//# sourceMappingURL=errorHandler.js.map