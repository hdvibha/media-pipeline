"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDHash = computeDHash;
exports.hammingDistanceHex = hammingDistanceHex;
const sharp_1 = __importDefault(require("sharp"));
/**
 * Difference hash (dHash): resize to 9x8 greyscale, compare each pixel to
 * its right neighbour, and pack the 64 booleans into a hex string.
 * Small, fast, and robust to resizing/re-compression - which is exactly the
 * kind of near-duplicate we expect from users re-uploading the same photo.
 * It is NOT robust to rotation/crop; see README trade-offs.
 */
async function computeDHash(filePath) {
    const { data } = await (0, sharp_1.default)(filePath)
        .resize(9, 8, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let bits = "";
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const left = data[row * 9 + col];
            const right = data[row * 9 + col + 1];
            bits += left > right ? "1" : "0";
        }
    }
    // pack 64 bits -> 16 hex chars
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
}
function hammingDistanceHex(a, b) {
    if (a.length !== b.length)
        return Math.max(a.length, b.length) * 4;
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        distance += xor.toString(2).split("1").length - 1;
    }
    return distance;
}
//# sourceMappingURL=phash.js.map