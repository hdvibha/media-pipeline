import { describe, it, expect } from "vitest";
import { hammingDistanceHex } from "../src/services/analysis/phash";

describe("hammingDistanceHex", () => {
  it("returns 0 for identical hashes", () => {
    expect(hammingDistanceHex("abcd1234abcd1234", "abcd1234abcd1234")).toBe(0);
  });

  it("returns 64 for maximally different hashes", () => {
    // f = 1111, 0 = 0000 -> every bit differs across 16 hex chars (64 bits)
    expect(hammingDistanceHex("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("counts differing bits correctly for a partial difference", () => {
    // 'f' vs '7' -> 1111 vs 0111 -> 1 bit differs
    expect(hammingDistanceHex("f000000000000000", "7000000000000000")).toBe(1);
  });

  it("treats mismatched lengths as maximally different", () => {
    expect(hammingDistanceHex("ab", "abcd")).toBeGreaterThan(0);
  });
});
