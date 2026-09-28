/**
 * VIN OCR — extracts a 17-character VIN from a photo (dashboard plate,
 * registration document, etc.) using Tesseract.
 *
 * The OCR result is a *candidate*: the caller must show it to staff for
 * confirmation before decoding, because OCR can misread characters
 * (e.g. 0/O, 1/I). The VIN character set excludes I, O, Q precisely
 * to reduce this ambiguity, and we exploit that in extraction.
 */

export interface OcrVinResult {
  /** The best VIN candidate found, or null if none. */
  vin: string | null;
  /** Raw OCR text, for debugging and staff review. */
  rawText: string;
}

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrError";
  }
}

/**
 * Scans OCR text for a 17-character VIN. VINs use A-Z except I, O, Q
 * plus digits. Common OCR confusions (0↔O, 1↔I) are normalized before
 * matching: O→0 and I/Q→1 are NOT valid VIN chars, so any O in a
 * candidate is almost certainly a misread 0.
 */
export function extractVinCandidate(text: string): string | null {
  // Normalize: uppercase, then fix the classic OCR confusions.
  // O is never valid in a VIN → treat as 0. I and Q are never valid → treat as 1.
  const normalized = text
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IQ]/g, "1");
  const match = normalized.match(/[A-HJ-NPR-Z0-9]{17}/);
  return match ? match[0] : null;
}

type RecognizeFn = (image: Buffer) => Promise<{ text: string }>;

/**
 * Runs OCR on an image buffer and returns the VIN candidate.
 * `recognize` is injectable so tests can stub Tesseract.
 */
export async function ocrVinFromImage(
  image: Buffer,
  recognize?: RecognizeFn
): Promise<OcrVinResult> {
  if (!image || image.length === 0) {
    throw new OcrError("No image data provided.");
  }
  // 10MB cap — dashboard/registration photos don't need more.
  if (image.length > 10 * 1024 * 1024) {
    throw new OcrError("Image too large (max 10MB).");
  }

  const doRecognize: RecognizeFn =
    recognize ??
    (async buf => {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      try {
        // VIN plates are single-line-ish; treat image as a uniform text block.
        const { data } = await worker.recognize(buf);
        return { text: data.text };
      } finally {
        await worker.terminate();
      }
    });

  let text: string;
  try {
    const result = await doRecognize(image);
    text = result.text ?? "";
  } catch (error) {
    throw new OcrError(
      `OCR failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  return { vin: extractVinCandidate(text), rawText: text };
}
