/**
 * ISO 3779 VIN validation — the single server-side gate for VINs.
 *
 * Typed VINs (POST /api/v1/vin/decode), photographed VINs (the OCR
 * candidate is confirmed through /vin/decode), VINs at case creation
 * (POST /api/v1/cases), and VINs at paid-lookup time (requestVinLookup)
 * all pass through assertValidVin. One function, one rule, everywhere.
 *
 * The gate checks:
 * 1. Exactly 17 characters from the VIN alphabet (A-Z except I, O, Q,
 *    plus digits 0-9).
 * 2. The ISO 3779 check digit: position 9 must equal the weighted
 *    transliteration sum mod 11 (10 represented as 'X').
 *
 * Note: the check digit is mandated for North American VINs; a small
 * number of legitimate non-NA VINs do not encode it. This product
 * serves the US market, so the gate enforces it.
 */

export class VinValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VinValidationError";
  }
}

/** ISO 3779 transliteration of VIN letters to numbers. */
const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};

/** ISO 3779 position weights. Position 9 (the check digit) has weight 0. */
const POSITION_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const VIN_FORMAT = /^[A-HJ-NPR-Z0-9]{17}$/;

/** The expected check digit for a format-valid 17-character VIN. */
export function expectedCheckDigit(normalizedVin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = normalizedVin[i];
    const value = c >= "0" && c <= "9" ? Number(c) : TRANSLITERATION[c];
    sum += value * POSITION_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

/**
 * Validates a VIN and returns the normalized (trimmed, uppercased) form.
 * Throws VinValidationError describing the first problem found.
 */
export function assertValidVin(vin: string): string {
  const normalized = vin.trim().toUpperCase();
  if (!VIN_FORMAT.test(normalized)) {
    throw new VinValidationError(
      "VIN must be 17 characters: letters A-Z (except I, O, Q) and digits."
    );
  }
  const expected = expectedCheckDigit(normalized);
  if (normalized[8] !== expected) {
    throw new VinValidationError(
      `VIN check digit is invalid: position 9 is '${normalized[8]}' but should be '${expected}'.`
    );
  }
  return normalized;
}

/** Non-throwing form, for use in zod refinements and UI pre-checks. */
export function isValidVin(vin: string): boolean {
  try {
    assertValidVin(vin);
    return true;
  } catch {
    return false;
  }
}
