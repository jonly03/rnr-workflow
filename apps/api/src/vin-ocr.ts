/**
 * VIN OCR — extracts a 17-character VIN from a photo (dashboard plate,
 * registration document, etc.) using Tesseract.
 *
 * The OCR result is a *candidate*: the caller must show it to staff for
 * confirmation before decoding, because OCR can misread characters
 * (e.g. 0/O, 1/I). The VIN character set excludes I, O, Q precisely
 * to reduce this ambiguity, and we exploit that in extraction.
 *
 * The English language model is bundled with the API
 * (apps/api/data/tessdata/eng.traineddata.gz) and loaded from disk, so
 * OCR never depends on a CDN download at request time. The whole
 * recognition is bounded by OCR_TIMEOUT_MS so a stuck worker fails fast
 * with a clear error instead of hanging the request.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Hard bound on a single OCR attempt (worker boot + recognition). */
export const OCR_TIMEOUT_MS = 30_000;

function tessdataDir(): string {
  // src/vin-ocr.ts -> <api>/data/tessdata (also correct if compiled to dist/).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "data", "tessdata");
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OcrError(
            `OCR timed out after ${Math.round(ms / 1000)}s. Try a clearer photo or type the VIN manually.`
          )
        ),
      ms
    );
  });
  // If the timeout wins the race, the task may reject later — don't let
  // that become an unhandled rejection.
  task.catch(() => {});
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

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
 * `timeoutMs` bounds the whole attempt; tests can shrink it.
 */
export async function ocrVinFromImage(
  image: Buffer,
  recognize?: RecognizeFn,
  timeoutMs: number = OCR_TIMEOUT_MS
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
      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", undefined, {
        langPath: tessdataDir()
      });
      try {
        // VIN plates/documents are uniform text blocks, not full pages.
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK
        });
        const { data } = await worker.recognize(buf);
        return { text: data.text };
      } finally {
        await worker.terminate();
      }
    });

  let text: string;
  try {
    const result = await withTimeout(doRecognize(image), timeoutMs);
    text = result.text ?? "";
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw new OcrError(
      `OCR failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  return { vin: extractVinCandidate(text), rawText: text };
}
