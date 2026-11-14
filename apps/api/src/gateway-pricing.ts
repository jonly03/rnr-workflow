import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Brain Gateway usage pricing — the SINGLE source of truth.
 *
 * Prices live in apps/api/config/brain-pricing.json (defaults: decode
 * $0.15, decode+glass $0.85, full vehicle $1.25, location addon $0.10).
 * Env vars override individual values for a deployment; code NEVER
 * contains a price literal. Every tool result's `price_usd_charged`
 * comes from this loader, and a failed lookup always charges $0.
 *
 * Pedro sets the prices; these are the approved draft defaults.
 */

export interface BrainPricing {
  decode: number;
  decodeGlass: number;
  fullVehicle: number;
  locationAddon: number;
}

export type BrainPriceKey = keyof BrainPricing;

const PRICE_KEYS: BrainPriceKey[] = ["decode", "decodeGlass", "fullVehicle", "locationAddon"];

const ENV_KEYS: Record<BrainPriceKey, string> = {
  decode: "BRAIN_PRICE_DECODE",
  decodeGlass: "BRAIN_PRICE_DECODE_GLASS",
  fullVehicle: "BRAIN_PRICE_FULL_VEHICLE",
  locationAddon: "BRAIN_PRICE_LOCATION_ADDON"
};

export function defaultPricingConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../config/brain-pricing.json");
}

function parsePrice(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid brain price ${label}: must be a non-negative number.`);
  }
  return value;
}

/**
 * Loads the gateway pricing. Reads the JSON config file (path from
 * BRAIN_PRICING_CONFIG, default config/brain-pricing.json), then applies
 * per-key env overrides. Throws on a missing file, bad JSON, or a
 * missing/invalid price — the gateway refuses to start mispriced.
 */
export function loadBrainPricing(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = env.BRAIN_PRICING_CONFIG ?? defaultPricingConfigPath()
): BrainPricing {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Brain pricing config not found: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Brain pricing config is not valid JSON: ${configPath}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Brain pricing config must be a JSON object: ${configPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const pricing = {} as BrainPricing;
  for (const key of PRICE_KEYS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Brain pricing config is missing a valid "${key}" price: ${configPath}`);
    }
    pricing[key] = value;
  }
  for (const key of PRICE_KEYS) {
    const override = env[ENV_KEYS[key]];
    if (override !== undefined && override.trim() !== "") {
      pricing[key] = parsePrice(override, `${ENV_KEYS[key]}`);
    }
  }
  return pricing;
}
