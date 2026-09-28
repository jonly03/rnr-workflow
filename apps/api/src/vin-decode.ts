/**
 * NHTSA vPIC VIN decoder — free public API, no key required.
 * https://vpic.nhtsa.dot.gov/api/
 *
 * Decodes a 17-character VIN into Year/Make/Model/Trim. This is the
 * free VIN→YMM lookup, distinct from the paid MyGrant VIN→glass-part
 * lookup (which is restricted to unresolved Windshield/Back Glass
 * ambiguity by the VIN guardrails).
 */

export interface NhtsaDecodedVehicle {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  bodyClass: string;
}

export class VinDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VinDecodeError";
  }
}

const NHTSA_API = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevin";

interface NhtsaResult {
  Variable: string;
  Value: string | null;
}

/**
 * Decodes a VIN via the NHTSA vPIC API.
 * Throws VinDecodeError on invalid VIN, network failure, or no decode results.
 */
export async function decodeVinNhtsa(vin: string): Promise<NhtsaDecodedVehicle> {
  const normalized = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(normalized)) {
    throw new VinDecodeError(
      "VIN must be 17 characters (letters A-Z except I, O, Q, and digits)."
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${NHTSA_API}/${encodeURIComponent(normalized)}?format=json`
    );
  } catch (error) {
    throw new VinDecodeError(
      `NHTSA VIN decode failed: ${error instanceof Error ? error.message : "network error"}`
    );
  }

  if (!response.ok) {
    throw new VinDecodeError(
      `NHTSA VIN decode failed with HTTP ${response.status}.`
    );
  }

  const data = (await response.json()) as { Results?: NhtsaResult[] };
  const results = data.Results ?? [];
  const valueOf = (variable: string): string => {
    const entry = results.find(r => r.Variable === variable);
    const value = entry?.Value?.trim() ?? "";
    return value;
  };

  const yearRaw = valueOf("Model Year");
  const make = valueOf("Make");
  const model = valueOf("Model");

  const year = Number(yearRaw);
  if (!Number.isInteger(year) || year < 1980 || year > 2100 || !make || !model) {
    throw new VinDecodeError(
      `NHTSA could not decode VIN ${normalized} to a valid Year/Make/Model.`
    );
  }

  return {
    vin: normalized,
    year,
    make,
    model,
    trim: valueOf("Trim"),
    bodyClass: valueOf("Body Class")
  };
}
