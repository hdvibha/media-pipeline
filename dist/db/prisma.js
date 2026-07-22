"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
// Simple singleton so we don't exhaust Postgres connections across
// hot-reloads in dev or across the API + worker processes sharing this module.
exports.prisma = new client_1.PrismaClient();
//# sourceMappingURL=prisma.js.map