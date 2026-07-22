# Sample API Requests / Responses

Base URL assumed: `http://localhost:3000`

---

## Upload an image

```bash
curl -X POST http://localhost:3000/api/images \
  -F "image=@./vehicle-front.jpg"
```

**Response `202 Accepted`:**

```json
{
  "id": "b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab",
  "status": "pending",
  "createdAt": "2026-07-21T04:10:00.000Z",
  "statusUrl": "/api/images/b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab/status",
  "resultsUrl": "/api/images/b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab/results"
}
```

Validation error (unsupported type / no file / corrupt image) returns `400`:

```json
{ "error": "Unsupported file type: text/plain. Allowed: image/jpeg, image/png, image/webp, image/heic, image/heif" }
```

---

## Poll processing status

```bash
curl http://localhost:3000/api/images/b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab/status
```

**While in progress:**

```json
{
  "id": "b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab",
  "status": "processing",
  "failureReason": null,
  "attempts": 1,
  "createdAt": "2026-07-21T04:10:00.000Z",
  "processingStartedAt": "2026-07-21T04:10:01.200Z",
  "processingCompletedAt": null
}
```

**Not found:** `404 { "error": "Image not found" }`

---

## Fetch results

```bash
curl http://localhost:3000/api/images/b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab/results
```

**If not completed yet — `409 Conflict`:**

```json
{
  "id": "b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab",
  "status": "processing",
  "failureReason": null,
  "message": "Analysis is not complete yet. Poll GET /api/images/:id/status until status is 'completed'."
}
```

**Once completed — `200 OK`:**

```json
{
  "id": "b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab",
  "status": "completed",
  "overallVerdict": "flagged",
  "issues": ["blurry", "invalid_or_missing_plate"],
  "plateNumber": null,
  "plateValid": false,
  "extractedText": "SOME PARTIAL OCR TEXT FROM THE FRAME",
  "completedAt": "2026-07-21T04:10:04.812Z",
  "checks": [
    {
      "name": "dimension_validation",
      "label": "Dimension Validation",
      "status": "pass",
      "confidence": 1,
      "message": "Image resolution 1920x1080 is acceptable",
      "details": { "width": 1920, "height": 1080, "format": "jpeg", "minWidth": 480, "minHeight": 360 },
      "durationMs": 4
    },
    {
      "name": "brightness_analysis",
      "label": "Brightness Analysis",
      "status": "pass",
      "confidence": 0.9,
      "message": "Mean luminance 132.4 is within a normal range",
      "details": { "meanLuminance": 132.4, "lowThreshold": 60, "highThreshold": 235 },
      "durationMs": 9
    },
    {
      "name": "blur_detection",
      "label": "Blur Detection",
      "status": "fail",
      "confidence": 0.81,
      "message": "Image appears blurry (Laplacian variance 42.7 < threshold 100)",
      "details": { "laplacianVariance": 42.7, "threshold": 100 },
      "durationMs": 38
    },
    {
      "name": "screenshot_detection",
      "label": "Screenshot Detection",
      "status": "pass",
      "confidence": 0.25,
      "message": "No strong screenshot signals detected",
      "details": { "score": 0.25, "signals": ["no_exif_data"], "width": 1920, "height": 1080, "format": "jpeg" },
      "durationMs": 6
    },
    {
      "name": "photo_of_photo_detection",
      "label": "Photo-of-Photo Detection",
      "status": "pass",
      "confidence": 0.1,
      "message": "No strong photo-of-photo signals detected",
      "details": { "score": 0.1, "signals": [], "avgColorStdev": 48.2 },
      "durationMs": 11
    },
    {
      "name": "tampering_heuristics",
      "label": "Editing/Tampering Heuristics",
      "status": "pass",
      "confidence": 0.3,
      "message": "No strong tampering signals detected",
      "details": { "signals": [], "score": 0 },
      "durationMs": 54
    },
    {
      "name": "plate_ocr_validation",
      "label": "Vehicle Plate OCR & Format Validation",
      "status": "fail",
      "confidence": 0.55,
      "message": "No text matching the Indian vehicle plate format was found",
      "details": { "ocrConfidence": 44.2, "rawTextLength": 37 },
      "durationMs": 812
    },
    {
      "name": "duplicate_detection",
      "label": "Duplicate Detection",
      "status": "pass",
      "confidence": 0.8,
      "message": "No duplicate found (closest match hamming distance 22)",
      "details": {
        "perceptualHash": "a1b2c3d4e5f60718",
        "threshold": 6,
        "closestMatch": { "id": "9d0e1f2a-...", "filename": "other.jpg", "distance": 22 },
        "candidatesCompared": 14
      },
      "durationMs": 21
    }
  ]
}
```

**On analysis failure — `409 Conflict`:**

```json
{
  "id": "b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab",
  "status": "failed",
  "failureReason": "Input file contains unsupported image format",
  "message": "Analysis failed - see failureReason. You may re-upload the image to retry."
}
```

---

## List images (bonus - dashboard/debugging)

```bash
curl "http://localhost:3000/api/images?limit=10&status=completed"
```

```json
{
  "items": [
    {
      "id": "b3f1c2a4-6e9d-4b3e-9b0a-1234567890ab",
      "originalFilename": "vehicle-front.jpg",
      "status": "completed",
      "createdAt": "2026-07-21T04:10:00.000Z",
      "analysis": { "overallVerdict": "flagged", "issues": ["blurry", "invalid_or_missing_plate"] }
    }
  ],
  "nextCursor": null
}
```

---

## Health check

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "checks": { "database": "ok", "redis": "ok" } }
```
