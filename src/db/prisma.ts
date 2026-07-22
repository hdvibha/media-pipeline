import { PrismaClient } from "@prisma/client";

// Simple singleton so we don't exhaust Postgres connections across
// hot-reloads in dev or across the API + worker processes sharing this module.
export const prisma = new PrismaClient();
