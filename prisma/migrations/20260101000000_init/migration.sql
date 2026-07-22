-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "OverallVerdict" AS ENUM ('clean', 'flagged', 'unknown');

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "perceptualHash" TEXT,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processingStartedAt" TIMESTAMP(3),
    "processingCompletedAt" TIMESTAMP(3),

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "overallVerdict" "OverallVerdict" NOT NULL DEFAULT 'unknown',
    "issues" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "extractedText" TEXT,
    "plateNumber" TEXT,
    "plateValid" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Image_status_idx" ON "Image"("status");

-- CreateIndex
CREATE INDEX "Image_perceptualHash_idx" ON "Image"("perceptualHash");

-- CreateIndex
CREATE INDEX "Image_createdAt_idx" ON "Image"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisResult_imageId_key" ON "AnalysisResult"("imageId");

-- CreateIndex
CREATE INDEX "AnalysisResult_overallVerdict_idx" ON "AnalysisResult"("overallVerdict");

-- AddForeignKey
ALTER TABLE "AnalysisResult" ADD CONSTRAINT "AnalysisResult_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
