import { describe, it, expect } from "vitest";
import { normalizeOcrText, findPlateCandidate } from "../src/services/analysis/plateOcr";

describe("plate OCR text matching", () => {
  it("finds a clean plate number with no noise", () => {
    const text = normalizeOcrText("KA05MH1234");
    expect(findPlateCandidate(text)).toBe("KA05MH1234");
  });

  it("finds a plate number surrounded by other OCR noise", () => {
    const text = normalizeOcrText("Govt of Karnataka\nKA 05 MH 1234\nSome other text");
    expect(findPlateCandidate(text)).toBe("KA05MH1234");
  });

  it("returns null when no plate-like pattern exists", () => {
    const text = normalizeOcrText("just some random sign text with no plate");
    expect(findPlateCandidate(text)).toBeNull();
  });

  it("handles single-letter-series plates (e.g. MH12AB1234)", () => {
    const text = normalizeOcrText("MH12AB1234");
    expect(findPlateCandidate(text)).toBe("MH12AB1234");
  });

  it("rejects strings that are too short to be a plate", () => {
    const text = normalizeOcrText("KA05");
    expect(findPlateCandidate(text)).toBeNull();
  });
});
