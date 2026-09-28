import type { SupplierType } from "./types.js";
import type { CaseStore } from "./store.js";
import type { CaseRecord } from "./types.js";

/** One raw offer from a supplier provider (before eligibility evaluation). */
export interface RawSupplierOffer {
  supplier_name: string;
  supplier_type: SupplierType;
  part_number: string;
  /** What R&R pays, in cents. Must be a non-negative integer. */
  price_cents: number;
  available: boolean;
  quantity: number;
  lead_time_days: number | null;
}

/**
 * Supplier sourcing provider. The mock below stands in for a live supplier
 * integration: same interface, deterministic behavior, zero network calls.
 * Swapping providers must not change the sourcing service or API.
 */
export interface SourcingProvider {
  readonly name: string;
  searchOffers(partNumber: string): Promise<RawSupplierOffer[]>;
}

/**
 * Deterministic mock supplier. Returns a mix of eligible and ineligible
 * offers so the eligibility rules are exercised:
 * - a cheapest eligible national offer (selected),
 * - a pricier eligible national offer,
 * - a cheaper REGIONAL offer (excluded: Regional never auto-quotes),
 * - an unavailable local offer (excluded: no stock).
 *
 * The "NOSTOCK" hook in the part number returns only ineligible offers,
 * driving the NO_ELIGIBLE_INVENTORY path.
 */
export class MockSourcingProvider implements SourcingProvider {
  readonly name = "mock-sourcing";
  /** Call counters so tests can prove sourcing runs deterministically. */
  offerSearches = 0;

  async searchOffers(partNumber: string): Promise<RawSupplierOffer[]> {
    this.offerSearches++;
    const pn = partNumber.trim().toUpperCase();

    if (pn.includes("NOSTOCK")) {
      return [
        {
          supplier_name: "Regional Glass Depot",
          supplier_type: "REGIONAL",
          part_number: pn,
          price_cents: 18000,
          available: true,
          quantity: 4,
          lead_time_days: 2
        },
        {
          supplier_name: "Local Auto Glass",
          supplier_type: "LOCAL",
          part_number: pn,
          price_cents: 22000,
          available: false,
          quantity: 0,
          lead_time_days: null
        }
      ];
    }

    // Base price derived deterministically from the part number so repeat
    // searches of the same part return the same offers.
    let hash = 0;
    for (let i = 0; i < pn.length; i++) hash = (hash * 31 + pn.charCodeAt(i)) >>> 0;
    const base = 20000 + (hash % 30000); // $200-$500

    return [
      {
        supplier_name: "National Glass Supply",
        supplier_type: "NATIONAL",
        part_number: pn,
        price_cents: base,
        available: true,
        quantity: 6,
        lead_time_days: 3
      },
      {
        supplier_name: "Allied Auto Glass",
        supplier_type: "NATIONAL",
        part_number: pn,
        price_cents: base + 2500,
        available: true,
        quantity: 3,
        lead_time_days: 2
      },
      {
        supplier_name: "Regional Glass Depot",
        supplier_type: "REGIONAL",
        part_number: pn,
        price_cents: base - 3000,
        available: true,
        quantity: 8,
        lead_time_days: 1
      },
      {
        supplier_name: "Local Auto Glass",
        supplier_type: "LOCAL",
        part_number: pn,
        price_cents: base + 1000,
        available: false,
        quantity: 0,
        lead_time_days: null
      }
    ];
  }
}

/**
 * Sourcing state machine (workflow-spec §4, Sourcing).
 * Keys are current states, values map initiating events to next states.
 */
export const SOURCING_TRANSITIONS: Record<string, Record<string, string>> = {
  GLASS_IDENTIFIED: {
    START_SOURCING: "SOURCING_IN_PROGRESS"
  },
  SOURCING_IN_PROGRESS: {
    SUPPLIER_OFFERS_RETURNED: "OFFERS_FOUND",
    SOURCING_FAILED: "SYSTEM_ATTENTION_REQUIRED"
  },
  OFFERS_FOUND: {
    EVALUATE_OFFERS: "OFFER_EVALUATION"
  },
  OFFER_EVALUATION: {
    ELIGIBLE_OFFER_SELECTED: "GLASS_SELECTED",
    NO_ELIGIBLE_OFFERS: "NO_ELIGIBLE_INVENTORY"
  },
  NO_ELIGIBLE_INVENTORY: {
    RETRY_SOURCING: "SOURCING_IN_PROGRESS"
  },
  GLASS_SELECTED: {
    START_PRICING: "PRICING_IN_PROGRESS"
  }
};

export type SourcingErrorCode =
  | "INVALID_TRANSITION"
  | "NO_IDENTIFIED_GLASS"
  | "INVALID_OFFER";

export class SourcingError extends Error {
  constructor(
    readonly code: SourcingErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "SourcingError";
  }
}

export interface Actor {
  type: string;
  id: string | null;
}

const SYSTEM: Actor = { type: "SYSTEM", id: null };

function transition(caseRecord: CaseRecord, event: string): string {
  const next = SOURCING_TRANSITIONS[caseRecord.current_state]?.[event];
  if (!next) {
    throw new SourcingError(
      "INVALID_TRANSITION",
      `Event ${event} is not legal from state ${caseRecord.current_state}.`,
      409
    );
  }
  return next;
}

/**
 * Evaluates a raw offer for auto-selection eligibility.
 * Returns the exclusion reason, or null if the offer is eligible.
 */
export function evaluateOfferEligibility(offer: RawSupplierOffer): string | null {
  if (offer.supplier_type === "REGIONAL") {
    return "Regional suppliers are excluded from automatic quoting.";
  }
  if (!offer.available || offer.quantity <= 0) {
    return "No available stock.";
  }
  if (!Number.isInteger(offer.price_cents) || offer.price_cents < 0) {
    return "Invalid or missing price.";
  }
  if (!offer.part_number.trim()) {
    return "Missing part number.";
  }
  return null;
}

/**
 * Runs supplier sourcing. Automatic after GLASS_IDENTIFIED; also the handler
 * for the staff `retry_sourcing` action from NO_ELIGIBLE_INVENTORY.
 *
 * Selects the cheapest eligible available non-Regional offer. If no eligible
 * offer exists, the case moves to NO_ELIGIBLE_INVENTORY for R&R review.
 */
export async function runSourcing(
  store: CaseStore,
  provider: SourcingProvider,
  caseId: string,
  initiatingEvent: "START_SOURCING" | "RETRY_SOURCING" = "START_SOURCING",
  actor: Actor = SYSTEM
): Promise<void> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  if (!glassRequest) throw new Error("Case is missing glass request.");

  const identification = await store.getLatestGlassIdentification(glassRequest.id);
  const partNumber = identification?.selected_candidate?.part_number;
  if (!partNumber) {
    throw new SourcingError(
      "NO_IDENTIFIED_GLASS",
      "Sourcing requires an identified glass part.",
      409
    );
  }

  await store.appendEvent({
    caseId,
    eventType: initiatingEvent,
    actor,
    nextState: transition(caseRecord, initiatingEvent),
    payload: { provider: provider.name, part_number: partNumber }
  });

  let rawOffers: RawSupplierOffer[];
  try {
    rawOffers = await provider.searchOffers(partNumber);
  } catch (error) {
    await store.appendEvent({
      caseId,
      eventType: "SOURCING_FAILED",
      actor: SYSTEM,
      nextState: transition({ ...caseRecord, current_state: "SOURCING_IN_PROGRESS" }, "SOURCING_FAILED"),
      payload: {
        provider: provider.name,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    return;
  }

  await store.appendEvent({
    caseId,
    eventType: "SUPPLIER_OFFERS_RETURNED",
    actor: SYSTEM,
    nextState: transition({ ...caseRecord, current_state: "SOURCING_IN_PROGRESS" }, "SUPPLIER_OFFERS_RETURNED"),
    payload: { provider: provider.name, offer_count: rawOffers.length }
  });

  // Persist all offers with eligibility evaluation.
  const evaluated = rawOffers.map(offer => ({
    offer,
    excludedReason: evaluateOfferEligibility(offer)
  }));
  for (const { offer, excludedReason } of evaluated) {
    await store.saveSupplierOffer({
      caseId,
      glassRequestId: glassRequest.id,
      supplierName: offer.supplier_name,
      supplierType: offer.supplier_type,
      partNumber: offer.part_number,
      priceCents: offer.price_cents,
      available: offer.available,
      quantity: offer.quantity,
      leadTimeDays: offer.lead_time_days,
      excludedReason,
      selected: false
    });
  }

  await store.appendEvent({
    caseId,
    eventType: "EVALUATE_OFFERS",
    actor: SYSTEM,
    nextState: transition({ ...caseRecord, current_state: "OFFERS_FOUND" }, "EVALUATE_OFFERS"),
    payload: {
      provider: provider.name,
      eligible_count: evaluated.filter(e => !e.excludedReason).length,
      excluded_count: evaluated.filter(e => e.excludedReason).length
    }
  });

  const eligible = evaluated.filter(e => !e.excludedReason);
  if (eligible.length === 0) {
    await store.appendEvent({
      caseId,
      eventType: "NO_ELIGIBLE_OFFERS",
      actor: SYSTEM,
      nextState: transition({ ...caseRecord, current_state: "OFFER_EVALUATION" }, "NO_ELIGIBLE_OFFERS"),
      payload: {
        provider: provider.name,
        reason: "No valid available non-Regional offer."
      }
    });
    return;
  }

  // Cheapest eligible offer wins. Deterministic tiebreak: supplier name.
  eligible.sort((a, b) =>
    a.offer.price_cents - b.offer.price_cents ||
    a.offer.supplier_name.localeCompare(b.offer.supplier_name)
  );
  const winner = eligible[0];

  // Mark the winner as selected (find the persisted record).
  const persisted = await store.listSupplierOffers(glassRequest.id);
  const winnerRecord = persisted.find(
    o => o.supplier_name === winner.offer.supplier_name &&
         o.price_cents === winner.offer.price_cents &&
         !o.excluded_reason
  );
  if (winnerRecord) {
    await store.selectSupplierOffer(winnerRecord.id);
  }

  await store.appendEvent({
    caseId,
    eventType: "ELIGIBLE_OFFER_SELECTED",
    actor: SYSTEM,
    nextState: transition({ ...caseRecord, current_state: "OFFER_EVALUATION" }, "ELIGIBLE_OFFER_SELECTED"),
    payload: {
      provider: provider.name,
      supplier_name: winner.offer.supplier_name,
      price_cents: winner.offer.price_cents,
      part_number: winner.offer.part_number
    }
  });
}
