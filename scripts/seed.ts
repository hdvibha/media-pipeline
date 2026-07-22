/**
 * Generates a handful of synthetic images (no external test-image
 * dependency needed) and uploads them through the real HTTP API so you can
 * see the full pipeline run end-to-end right after `docker compose up`.
 *
 * Usage: npm run seed  (expects the API to be running on API_URL, default
 * http://localhost:3000)
 */
import sharp from "sharp";
import path from "path";
import fs from "fs";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const TMP_DIR = path.join(__dirname, "..", "tmp-seed");

async function makeSharpImage(): Promise<Buffer> {
  // A busy, high-contrast noise pattern -> should pass blur detection.
  const width = 800;
  const height = 600;
  const buffer = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buffer.length; i++) buffer[i] = Math.floor(Math.random() * 256);
  return sharp(buffer, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function makeBlurryImage(): Promise<Buffer> {
  const sharpBuf = await makeSharpImage();
  return sharp(sharpBuf).blur(20).jpeg({ quality: 90 }).toBuffer();
}

async function makeDarkImage(): Promise<Buffer> {
  const width = 800;
  const height = 600;
  const buffer = Buffer.alloc(width * height * 3, 10); // near-black
  return sharp(buffer, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function makeSmallImage(): Promise<Buffer> {
  const width = 100;
  const height = 80;
  const buffer = Buffer.alloc(width * height * 3, 128);
  return sharp(buffer, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function uploadFile(filePath: string): Promise<any> {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append("image", new Blob([buf]), path.basename(filePath));

  const res = await fetch(`${API_URL}/api/images`, { method: "POST", body: form as any });
  const json = await res.json();
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const samples: Array<{ name: string; make: () => Promise<Buffer> }> = [
    { name: "sharp-sample.jpg", make: makeSharpImage },
    { name: "sharp-sample-duplicate.jpg", make: makeSharpImage }, // note: freshly random, won't actually dupe - see README
    { name: "blurry-sample.jpg", make: makeBlurryImage },
    { name: "dark-sample.jpg", make: makeDarkImage },
    { name: "tiny-sample.jpg", make: makeSmallImage },
  ];

  console.log(`Seeding ${samples.length} sample images against ${API_URL} ...`);

  for (const sample of samples) {
    const buf = await sample.make();
    const filePath = path.join(TMP_DIR, sample.name);
    fs.writeFileSync(filePath, buf);
    try {
      const result = await uploadFile(filePath);
      console.log(`  uploaded ${sample.name} -> id=${result.id}`);
    } catch (err) {
      console.error(`  FAILED to upload ${sample.name}:`, (err as Error).message);
    }
  }

  console.log("\nDone. Poll GET /api/images/:id/status or GET /api/images to watch them process.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
