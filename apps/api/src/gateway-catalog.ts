import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whole-car parts catalog for the gateway's lookup_part tool.
 *
 * Data: apps/api/config/vehicle-parts-catalog.json — copied verbatim from
 * the Layer 2 VIN-to-Anything MVP (branch mvp/layer-2-vin-anything,
 * vin-api/catalog.json v0.2, 2026-11-13): 4 vehicles, 37 part rows from
 * R&R's own jobs + manufacturer specs. Price/availability are null
 * until supplier feeds exist; any null field is NOT verified and is
 * returned as null, never invented.
 *
 * The catalog is the ONLY source for part numbers here. A vehicle not
 * in the catalog returns variant_status "not_in_catalog" with follow-up
 * questions — the gateway NEVER guesses a part number or a variant.
 */

export type PartCategory = "exterior" | "interior" | "engine" | "mechanical";

export const PART_CATEGORIES: PartCategory[] = ["exterior", "interior", "engine", "mechanical"];

export interface CatalogPart {
  /** Dotted path inside its category, e.g. "glass.windshield" or "oil". */
  path: string;
  part_number: string | null;
  variant_status: string;
  source: string | null;
  note: string | null;
  variant_questions: string[];
  /** Any other verified fields from the catalog row (sizes, capacities...). */
  extra: Record<string, unknown>;
}

export interface CatalogVehicle {
  match: { year: number; make: string; model: string; engine?: string };
  range: string;
  categories: Record<string, unknown>;
}

export interface VehicleCatalog {
  version: string;
  vehicles: CatalogVehicle[];
}

export function defaultCatalogPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../config/vehicle-parts-catalog.json");
}

export function loadVehicleCatalog(
  catalogPath: string = process.env.BRAIN_CATALOG_PATH ?? defaultCatalogPath()
): VehicleCatalog {
  let raw: string;
  try {
    raw = fs.readFileSync(catalogPath, "utf-8");
  } catch {
    throw new Error(`Vehicle parts catalog not found: ${catalogPath}`);
  }
  const parsed = JSON.parse(raw) as VehicleCatalog;
  if (!parsed || !Array.isArray(parsed.vehicles)) {
    throw new Error(`Vehicle parts catalog is malformed: ${catalogPath}`);
  }
  return parsed;
}

function yearInRange(year: number, range: string): boolean {
  const trimmed = range.trim();
  const span = trimmed.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (span) {
    return year >= Number(span[1]) && year <= Number(span[2]);
  }
  return Number(trimmed) === year;
}

/**
 * Finds the catalog vehicle for a year/make/model. Make/model match
 * case-insensitively; the year must fall in the vehicle's range.
 * Returns null when the vehicle is not catalogued — never a near miss.
 */
export function findCatalogVehicle(
  catalog: VehicleCatalog,
  year: number,
  make: string,
  model: string
): CatalogVehicle | null {
  const mk = make.trim().toLowerCase();
  const md = model.trim().toLowerCase();
  for (const vehicle of catalog.vehicles) {
    if (
      vehicle.match.make.trim().toLowerCase() === mk &&
      vehicle.match.model.trim().toLowerCase() === md &&
      yearInRange(year, vehicle.range)
    ) {
      return vehicle;
    }
  }
  return null;
}

const VARIANT_RANK: Record<string, number> = {
  exact: 0,
  needs_confirmation: 1,
  variant_ambiguous: 2,
  licensed_required: 3,
  not_in_catalog: 4
};

/** Flattens one category object into part rows, skipping null entries. */
export function partsInCategory(vehicle: CatalogVehicle, category: PartCategory): CatalogPart[] {
  const out: CatalogPart[] = [];
  const root = vehicle.categories[category];
  if (!root || typeof root !== "object") return out;
  const walk = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // A part row carries a source or a part_number (or an explicit
    // variant_status); a sub-group carries neither and holds children.
    const isRow =
      typeof record.source === "string" ||
      typeof record.part_number === "string" ||
      record.part_number === null ||
      typeof record.variant_status === "string";
    if (isRow && prefix) {
      const { part_number, variant_status, source, note, variant_questions, ...rest } = record;
      out.push({
        path: prefix,
        part_number: typeof part_number === "string" ? part_number : null,
        variant_status:
          typeof variant_status === "string" ? variant_status : "exact",
        source: typeof source === "string" ? source : null,
        note: typeof note === "string" ? note : null,
        variant_questions: Array.isArray(variant_questions)
          ? variant_questions.filter((q): q is string => typeof q === "string")
          : [],
        extra: rest
      });
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (child !== null && typeof child === "object") {
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
    }
  };
  walk(root, "");
  return out;
}

/** Worst variant status across a part list (exact < needs_confirmation < ambiguous ...). */
export function worstVariantStatus(parts: CatalogPart[]): string {
  let worst = "exact";
  for (const part of parts) {
    if ((VARIANT_RANK[part.variant_status] ?? 99) > (VARIANT_RANK[worst] ?? 99)) {
      worst = part.variant_status;
    }
  }
  return worst;
}
