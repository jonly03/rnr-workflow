import type { CaseStore } from "./store.js";
import type { CaseRecord, PriceCalculation } from "./types.js";

/**
 * Pricing configuration. All values are configuration-driven (env vars with
 * sensible defaults); nothing client-facing is hard-coded.
 *
 * - labor_cents: flat labor charge per job ($125).
 * - target_profit_cents: target profit per job ($250, per owner policy —
 *   applies regardless of glass cost).
 * - tax_rate: sales tax rate applied to the glass cost (6.25%).
 */
export interface PricingConfig {
  labor_cents: number;
  target_profit_cents: number;
  tax_rate: number;
}

export function loadPricingConfig(env: NodeJS.ProcessEnv = process.env): PricingConfig {
  const int = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Invalid ${key}: must be a non-negative integer (cents).`);
    }
    return parsed;
  };
  const float = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid ${key}: must be a non-negative number.`);
    }
    return parsed;
  };
  return {
    labor_cents: int("PRICING_LABOR_CENTS", 12500),
    target_profit_cents: int("PRICING_TARGET_PROFIT_CENTS", 25000),
    tax_rate: float("PRICING_TAX_RATE", 0.0625)
  };
}

/**
 * Pricing state machine (workflow-spec §4, Pricing).
 */
export const PRICING_TRANSITIONS: Record<string, Record<string, string>> = {
  GLASS_SELECTED: {
    START_PRICING: "PRICING_IN_PROGRESS"
  },
  PRICING_IN_PROGRESS: {
    STANDARD_PRICE_CALCULATED: "PRICE_APPROVED",
    PRICING_EXCEPTION_DETECTED: "PROFIT_REVIEW_REQUIRED",
    PRICING_FAILED: "SYSTEM_ATTENTION_REQUIRED"
  },
  PROFIT_REVIEW_REQUIRED: {
    PRICE_APPROVED_BY_RNR: "PRICE_APPROVED",
    PRICE_REJECTED_BY_RNR: "CANCELLATION_REQUESTED"
  },
  PRICE_APPROVED: {
    GENERATE_QUOTE: "QUOTE_GENERATING"
  }
};

export type PricingErrorCode =
  | "INVALID_TRANSITION"
  | "NO_SELECTED_OFFER"
  | "INVALID_PROFIT";

export class PricingError extends Error {
  constructor(
    readonly code: PricingErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "PricingError";
  }
}

export interface Actor {
  type: string;
  id: string | null;
}

const SYSTEM: Actor = { type: "SYSTEM", id: null };

function transition(caseRecord: CaseRecord, event: string): string {
  const next = PRICING_TRANSITIONS[caseRecord.current_state]?.[event];
  if (!next) {
    throw new PricingError(
      "INVALID_TRANSITION",
      `Event ${event} is not legal from state ${caseRecord.current_state}.`,
      409
    );
  }
  return next;
}

export interface PriceInputs {
  glass_cost_cents: number;
  labor_cents: number;
  profit_cents: number;
  tax_rate: number;
}

export interface PriceResult {
  glass_cost_cents: number;
  labor_cents: number;
  profit_cents: number;
  tax_cents: number;
  sell_price_cents: number;
}

/**
 * Calculates the client sell price from the pricing inputs.
 * sell_price = glass_cost + labor + profit + tax, where
 * tax = round(glass_cost * tax_rate).
 *
 * All amounts are integer cents; rounding is to the nearest cent.
 */
export function calculatePrice(inputs: PriceInputs): PriceResult {
  for (const [key, value] of Object.entries(inputs)) {
    if (key === "tax_rate") continue;
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new PricingError(
        "INVALID_PROFIT",
        `Invalid pricing input ${key}: must be a non-negative integer.`,
        422
      );
    }
  }
  if (!Number.isFinite(inputs.tax_rate) || inputs.tax_rate < 0) {
    throw new PricingError(
      "INVALID_PROFIT",
      "Invalid tax_rate: must be a non-negative number.",
      422
    );
  }
  const tax_cents = Math.round(inputs.glass_cost_cents * inputs.tax_rate);
  const sell_price_cents =
    inputs.glass_cost_cents + inputs.labor_cents + inputs.profit_cents + tax_cents;
  return {
    glass_cost_cents: inputs.glass_cost_cents,
    labor_cents: inputs.labor_cents,
    profit_cents: inputs.profit_cents,
    tax_cents,
    sell_price_cents
  };
}

/**
 * Runs pricing. Automatic after GLASS_SELECTED.
 *
 * The price is always calculated from the configured labor ($125), target
 * profit ($250), and tax (6.25% of glass cost), then auto-approved. Per owner
 * policy, the $250 target profit applies regardless of glass cost — cheap
 * glass does not route to manual review.
 */
export async function runPricing(
  store: CaseStore,
  config: PricingConfig,
  caseId: string,
  actor: Actor = SYSTEM
): Promise<PriceCalculation> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  if (!glassRequest) throw new Error("Case is missing glass request.");

  const offers = await store.listSupplierOffers(glassRequest.id);
  const selected = offers.find(o => o.selected);
  if (!selected) {
    throw new PricingError(
      "NO_SELECTED_OFFER",
      "Pricing requires a selected supplier offer.",
      409
    );
  }

  await store.appendEvent({
    caseId,
    eventType: "START_PRICING",
    actor,
    nextState: transition(caseRecord, "START_PRICING"),
    payload: {
      selected_offer_id: selected.id,
      glass_cost_cents: selected.price_cents
    }
  });

  const pricingConfig = {
    labor_cents: config.labor_cents,
    target_profit_cents: config.target_profit_cents,
    tax_rate: config.tax_rate
  };

  // Standard case: calculate and auto-approve. The $250 target profit
  // applies regardless of glass cost (owner policy).
  const price = calculatePrice({
    glass_cost_cents: selected.price_cents,
    labor_cents: config.labor_cents,
    profit_cents: config.target_profit_cents,
    tax_rate: config.tax_rate
  });
  const calculation = await store.savePriceCalculation({
    caseId,
    glassRequestId: glassRequest.id,
    selectedOfferId: selected.id,
    glassCostCents: price.glass_cost_cents,
    laborCents: price.labor_cents,
    profitCents: price.profit_cents,
    taxCents: price.tax_cents,
    sellPriceCents: price.sell_price_cents,
    pricingConfig,
    status: "APPROVED"
  });
  await store.appendEvent({
    caseId,
    eventType: "STANDARD_PRICE_CALCULATED",
    actor: SYSTEM,
    nextState: transition({ ...caseRecord, current_state: "PRICING_IN_PROGRESS" }, "STANDARD_PRICE_CALCULATED"),
    payload: {
      price_calculation_id: calculation.id,
      sell_price_cents: price.sell_price_cents,
      glass_cost_cents: price.glass_cost_cents,
      labor_cents: price.labor_cents,
      profit_cents: price.profit_cents,
      tax_cents: price.tax_cents
    }
  });
  return calculation;
}

/**
 * R&R approves the price from profit review, optionally with an adjusted
 * profit. The sell price is recalculated from the snapshot inputs so it
 * stays reproducible.
 */
export async function approvePrice(
  store: CaseStore,
  config: PricingConfig,
  caseId: string,
  profitCentsOverride: number | null,
  actor: Actor
): Promise<PriceCalculation> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  if (caseRecord.current_state !== "PROFIT_REVIEW_REQUIRED") {
    throw new PricingError(
      "INVALID_TRANSITION",
      `Price approval is not available from state ${caseRecord.current_state}.`,
      409
    );
  }
  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  if (!glassRequest) throw new Error("Case is missing glass request.");

  const latest = await store.getLatestPriceCalculation(glassRequest.id);
  if (!latest || latest.status !== "PROFIT_REVIEW") {
    throw new PricingError(
      "INVALID_TRANSITION",
      "No pending profit review found for this case.",
      409
    );
  }

  const profit_cents = profitCentsOverride ?? latest.profit_cents;
  if (!Number.isInteger(profit_cents) || profit_cents < 0) {
    throw new PricingError(
      "INVALID_PROFIT",
      "Profit must be a non-negative integer (cents).",
      422
    );
  }

  const price = calculatePrice({
    glass_cost_cents: latest.glass_cost_cents,
    labor_cents: latest.labor_cents,
    profit_cents,
    tax_rate: config.tax_rate
  });

  const calculation = await store.savePriceCalculation({
    caseId,
    glassRequestId: glassRequest.id,
    selectedOfferId: latest.selected_offer_id,
    glassCostCents: price.glass_cost_cents,
    laborCents: price.labor_cents,
    profitCents: price.profit_cents,
    taxCents: price.tax_cents,
    sellPriceCents: price.sell_price_cents,
    pricingConfig: {
      ...((latest.pricing_config as Record<string, unknown>) ?? {}),
      profit_override_cents: profitCentsOverride,
      approved_by: actor.id
    },
    status: "APPROVED"
  });

  await store.appendEvent({
    caseId,
    eventType: "PRICE_APPROVED_BY_RNR",
    actor,
    nextState: transition(caseRecord, "PRICE_APPROVED_BY_RNR"),
    payload: {
      price_calculation_id: calculation.id,
      sell_price_cents: price.sell_price_cents,
      profit_cents: price.profit_cents,
      profit_overridden: profitCentsOverride !== null
    }
  });
  return calculation;
}

/**
 * R&R rejects the price from profit review. The case moves to cancellation.
 */
export async function rejectPrice(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<void> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");

  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  if (glassRequest) {
    const latest = await store.getLatestPriceCalculation(glassRequest.id);
    if (latest && latest.status === "PROFIT_REVIEW") {
      await store.savePriceCalculation({
        caseId,
        glassRequestId: glassRequest.id,
        selectedOfferId: latest.selected_offer_id,
        glassCostCents: latest.glass_cost_cents,
        laborCents: latest.labor_cents,
        profitCents: latest.profit_cents,
        taxCents: latest.tax_cents,
        sellPriceCents: latest.sell_price_cents,
        pricingConfig: (latest.pricing_config as Record<string, unknown>) ?? {},
        status: "REJECTED"
      });
    }
  }

  await store.appendEvent({
    caseId,
    eventType: "PRICE_REJECTED_BY_RNR",
    actor,
    nextState: transition(caseRecord, "PRICE_REJECTED_BY_RNR"),
    payload: { reason: "R&R declined to proceed at an acceptable price." }
  });
}
