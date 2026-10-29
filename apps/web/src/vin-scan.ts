/**
 * On-device VIN sticker decoding (barcode / QR) for the public intake.
 *
 * The door-jamb certification sticker prints the VIN as a barcode (most
 * cars) or a QR code (newer cars). ZXing's WASM reader decodes it
 * entirely on the device: the camera frame or photo passed in is never
 * uploaded, stored, or attached to the intake — this module only ever
 * returns the decoded TEXT. That keeps the standing boundaries: no
 * third-party OCR/vision services, no photo persistence for scanning,
 * and no paid lookup — a decoded VIN only fills the form's VIN field,
 * and only after the customer confirms it.
 *
 * The reader (and its .wasm binary, bundled by Vite as a same-origin
 * asset) loads lazily on first use, so opening the intake costs
 * nothing until a customer actually starts a scan.
 */

export interface StickerCode {
  text: string;
  format: string;
}

type ReaderModule = typeof import("zxing-wasm/reader");

let readerPromise: Promise<ReaderModule> | null = null;

function loadReader(): Promise<ReaderModule> {
  if (!readerPromise) {
    readerPromise = (async () => {
      const reader = await import("zxing-wasm/reader");
      const wasmAsset = await import("zxing-wasm/reader/zxing_reader.wasm?url");
      reader.setZXingModuleOverrides({
        locateFile: (path: string, prefix: string) =>
          path.endsWith(".wasm") ? wasmAsset.default : prefix + path
      });
      return reader;
    })();
  }
  return readerPromise;
}

/**
 * ISO 3779 VIN check — mirrors apps/api/src/vin-validation.ts so the
 * intake can gate a VIN exactly the way the server gates it. The
 * server stays the real gate; this is a UX pre-check only. (Moved here
 * from App.tsx so the sticker extraction below and the intake share
 * one implementation.)
 */
const VIN_TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};
const VIN_POSITION_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function isValidVin(vin: string): boolean {
  const v = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = v[i];
    sum += (c >= "0" && c <= "9" ? Number(c) : VIN_TRANSLITERATION[c]) * VIN_POSITION_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return v[8] === (remainder === 10 ? "X" : String(remainder));
}

const STICKER_FORMATS = ["Code39", "Code128", "QRCode", "DataMatrix", "PDF417"] as const;

/** Decode the first barcode/QR code in an image. Null when none is found. */
export async function decodeStickerCode(source: Blob): Promise<StickerCode | null> {
  const { readBarcodes } = await loadReader();
  const results = await readBarcodes(source, {
    formats: [...STICKER_FORMATS],
    tryHarder: true,
    maxNumberOfSymbols: 1
  });
  if (results.length === 0) return null;
  return { text: results[0].text, format: results[0].format };
}

/**
 * Pull the VIN candidate out of decoded sticker text. A plain
 * first-17-characters match is NOT enough: payloads that wrap the VIN
 * in other fields ("CERT LABEL 1C4H… GVWR 2400") glue into one long
 * alphanumeric string whose first 17 characters are junk that happens
 * to fit the VIN alphabet. So slide every 17-character window of the
 * cleaned string and return the first one that passes the ISO 3779
 * check digit — only the real VIN can. When nothing validates but the
 * whole text is exactly 17 VIN-alphabet characters (the standalone
 * barcode case), return it as-is: the caller then reports the check
 * digit failure against the actual read instead of claiming no VIN
 * was found. Anything else is not a VIN read at all — null.
 */
export function extractVinFromStickerText(text: string): string | null {
  if (!text) return null;
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 17) return null;
  for (let start = 0; start + 17 <= clean.length; start++) {
    const window = clean.slice(start, start + 17);
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(window) && isValidVin(window)) {
      return window;
    }
  }
  if (clean.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(clean)) {
    return clean;
  }
  return null;
}
