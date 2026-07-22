/**
 * Shared contract for the analysis pipeline. Every check module returns a
 * CheckResult, and the orchestrator (services/analysis/index.ts) combines
 * them into an AnalysisReport that gets persisted as JSON on AnalysisResult.
 */

export type CheckStatus = "pass" | "fail" | "warning" | "error" | "skipped";

export interface CheckResult {
  /** stable machine-readable identifier, e.g. "blur_detection" */
  name: string;
  /** human readable label for UI/logs */
  label: string;
  status: CheckStatus;
  /** 0-1 confidence in this specific check's verdict */
  confidence: number;
  /** short human-readable explanation */
  message: string;
  /** arbitrary structured data useful for debugging / audit (raw metrics) */
  details?: Record<string, unknown>;
  /** milliseconds taken to run this check */
  durationMs?: number;
}

export interface AnalysisReport {
  imageId: string;
  checks: CheckResult[];
  /** issue codes surfaced to consumers, derived from failed/warning checks */
  issues: string[];
  overallVerdict: "clean" | "flagged" | "unknown";
  extractedText?: string;
  plateNumber?: string | null;
  plateValid?: boolean | null;
  generatedAt: string;
}

export interface ImageContext {
  imageId: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
}
