import { assertValidVin, VinValidationError } from "./vin-validation.js";

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
  /** vPIC "Drive Type", e.g. "AWD/All-Wheel Drive". */
  driveType: string;
  /** vPIC "Doors", e.g. "5". */
  doors: string;
  /** vPIC "Fuel Type - Primary", e.g. "Electric". */
  fuelType: string;
  /** vPIC "Electrification Level", e.g. "BEV (Battery Electric Vehicle)". */
  electrificationLevel: string;
  /** vPIC "Plant Country", e.g. "JAPAN". */
  plantCountry: string;
}

/**
 * Composes the customer-facing vehicle descriptor (Nelly, 2026-11-23)
 * from a VIN decode: the pertinent attributes that mirror the
 * customer's own vehicle back to them on the quote / invoice part
 * line — e.g. "Electric SUV · AWD · 5-door · built in Japan" for a
 * Toyota bZ4X. Only attributes the decode actually reports are
 * included, in a fixed order (powertrain, body, drive, doors, build
 * origin); anything unrecognized is omitted rather than guessed.
 * Returns "" when the decode carries nothing pertinent.
 */
export function composeVehicleDescriptor(decoded: {
  bodyClass?: string;
  driveType?: string;
  doors?: string;
  fuelType?: string;
  electrificationLevel?: string;
  plantCountry?: string;
}): string {
  const parts: string[] = [];

  const electrification = `${decoded.electrificationLevel ?? ""} ${decoded.fuelType ?? ""}`;
  if (/\bBEV\b|battery electric/i.test(electrification) || /^\s*electric\s*$/i.test(decoded.fuelType ?? "")) {
    parts.push("Electric");
  } else if (/hybrid/i.test(electrification)) {
    parts.push("Hybrid");
  }

  const body = decoded.bodyClass ?? "";
  const bodyLabel = /sport utility|\bSUV\b/i.test(body)
    ? "SUV"
    : /sedan/i.test(body)
      ? "Sedan"
      : /coupe/i.test(body)
        ? "Coupe"
        : /hatchback/i.test(body)
          ? "Hatchback"
          : /pickup/i.test(body)
            ? "Pickup truck"
            : /minivan/i.test(body)
              ? "Minivan"
              : /\bvan\b/i.test(body)
                ? "Van"
                : /convertible/i.test(body)
                  ? "Convertible"
                  : /wagon/i.test(body)
                    ? "Wagon"
                    : "";
  if (bodyLabel) parts.push(bodyLabel);

  const drive = decoded.driveType ?? "";
  const driveLabel = /\bAWD\b|all-wheel/i.test(drive)
    ? "AWD"
    : /\b4WD\b|4-wheel|four-wheel/i.test(drive)
      ? "4WD"
      : /\bFWD\b|front-wheel/i.test(drive)
        ? "FWD"
        : /\bRWD\b|rear-wheel/i.test(drive)
          ? "RWD"
          : "";
  if (driveLabel) parts.push(driveLabel);

  const doors = (decoded.doors ?? "").trim();
  if (/^[2-9]$/.test(doors)) parts.push(`${doors}-door`);

  const plant = (decoded.plantCountry ?? "").trim();
  if (plant) {
    const country = /united states|\bUSA\b/i.test(plant)
      ? "the USA"
      : plant
          .toLowerCase()
          .replace(/\b\w/g, c => c.toUpperCase());
    parts.push(`built in ${country}`);
  }

  return parts.join(" · ");
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
  let normalized: string;
  try {
    normalized = assertValidVin(vin);
  } catch (error) {
    throw new VinDecodeError(
      error instanceof VinValidationError
        ? error.message
        : "VIN must be 17 characters (letters A-Z except I, O, Q, and digits)."
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
    bodyClass: valueOf("Body Class"),
    driveType: valueOf("Drive Type"),
    doors: valueOf("Doors"),
    fuelType: valueOf("Fuel Type - Primary"),
    electrificationLevel: valueOf("Electrification Level"),
    plantCountry: valueOf("Plant Country")
  };
}

const GLASS_LINE_LABELS: Record<string, string> = {
  WINDSHIELD: "windshield",
  BACK_GLASS: "back glass",
  DOOR_GLASS: "door glass",
  QUARTER_GLASS: "quarter glass",
  VENT_GLASS: "vent glass",
  SUNROOF: "sunroof"
};

/**
 * The customer part line (Nelly, 2026-11-23): plain words that mirror
 * the customer's own vehicle back to them — glass, year/make/model,
 * and the VIN-decode descriptor when one was captured — e.g.
 * "Glass — windshield for your 2023 Toyota bZ4X · Electric SUV · AWD
 * · 5-door · built in Japan". NEVER in this line: the VIN itself, the
 * part number, supplier, raw cost, or profit. Shared by the public
 * quote projection and the invoice client view so both documents
 * describe the part identically.
 */
export function composeGlassLineDescription(input: {
  glassType: string;
  vehicle: { year: number; make: string; model: string };
  descriptor?: string | null;
}): string {
  const label =
    GLASS_LINE_LABELS[input.glassType] ??
    input.glassType.replaceAll("_", " ").toLowerCase();
  const base = `Glass — ${label} for your ${input.vehicle.year} ${input.vehicle.make} ${input.vehicle.model}`;
  const descriptor = (input.descriptor ?? "").trim();
  return descriptor ? `${base} · ${descriptor}` : base;
}
