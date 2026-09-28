import type { GlassCandidate, GlassType } from "./types.js";

export interface YmmSearchInput {
  year: number;
  make: string;
  model: string;
  glassType: GlassType;
}

export interface VinLookupResult {
  vin: string;
  decoded: {
    year: number;
    make: string;
    model: string;
    trim: string;
  };
  /** Disambiguated candidates: the VIN pins down the exact option set. */
  candidates: GlassCandidate[];
}

/**
 * Glass catalog provider. The mock below stands in for the live MyGrant
 * integration: same interface, deterministic behavior, zero network calls.
 * Swapping providers must not change the identification service or API.
 */
export interface GlassCatalogProvider {
  readonly name: string;
  searchYmm(input: YmmSearchInput): Promise<GlassCandidate[]>;
  /** Paid VIN lookup. Callers must check the VIN cache first. */
  lookupVin(vin: string): Promise<VinLookupResult>;
}

const GLASS_LABEL: Record<GlassType, string> = {
  WINDSHIELD: "Windshield",
  BACK_GLASS: "Back Glass",
  DOOR_GLASS: "Door Glass",
  QUARTER_GLASS: "Quarter Glass",
  VENT_GLASS: "Vent Glass"
};

function partNumber(year: number, make: string, model: string, glassType: GlassType, suffix: string) {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "XXXXXX";
  return `${clean(make)}-${clean(model)}-${year}-${glassType.slice(0, 2)}-${suffix}`;
}

function baseCandidate(
  year: number,
  make: string,
  model: string,
  glassType: GlassType,
  suffix: string,
  features: string[]
): GlassCandidate {
  return {
    part_number: partNumber(year, make, model, glassType, suffix),
    description: `${year} ${make} ${model} ${GLASS_LABEL[glassType]}${features.length ? ` (${features.join(", ")})` : ""}`,
    features,
    position: glassType,
    list_price_cents: 45000 + suffix.charCodeAt(0) * 137
  };
}

export class MockGlassCatalogProvider implements GlassCatalogProvider {
  readonly name = "mock-catalog";
  /** Call counters so tests can prove the VIN cache prevents repeat charges. */
  ymmSearches = 0;
  vinLookups = 0;

  async searchYmm(input: YmmSearchInput): Promise<GlassCandidate[]> {
    this.ymmSearches++;
    const { year, make, model, glassType } = input;
    const mk = make.trim().toLowerCase();
    const md = model.trim().toLowerCase();

    // No catalog coverage at all.
    if (mk === "unknown" || md === "unknown" || mk === "" || md === "") {
      return [];
    }

    // YMM cannot distinguish the option set: staff or VIN must resolve it.
    // ("Ambiguous" in the model is the deterministic test hook.)
    if (md.includes("ambiguous")) {
      return [
        baseCandidate(year, make, model, glassType, "A1", ["rain-sensor"]),
        baseCandidate(year, make, model, glassType, "B2", ["rain-sensor", "heads-up-display"]),
        baseCandidate(year, make, model, glassType, "C3", ["acoustic", "heated"])
      ];
    }

    return [baseCandidate(year, make, model, glassType, "S1", [])];
  }

  async lookupVin(vin: string): Promise<VinLookupResult> {
    this.vinLookups++;
    const normalized = vin.trim().toUpperCase();
    if (normalized.length !== 17) {
      throw new Error("VIN must be 17 characters for lookup.");
    }
    // The VIN pins the exact factory option set, so ambiguity collapses to
    // the single correct part. The trim is derived deterministically from the
    // VIN so repeat lookups of the same VIN return the same result.
    const trimCodes = ["LX", "EX", "Touring", "Sport"];
    const trim = trimCodes[normalized.charCodeAt(8) % trimCodes.length];
    return {
      vin: normalized,
      decoded: { year: 2020, make: "Honda", model: "Accord", trim },
      candidates: [
        {
          part_number: `VIN-${normalized.slice(0, 8)}-WS`,
          description: `VIN-decoded Windshield (${trim} trim)`,
          features: ["rain-sensor", "acoustic"],
          position: "WINDSHIELD",
          list_price_cents: 52000
        }
      ]
    };
  }
}
