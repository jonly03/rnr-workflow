import type { GlassCatalogProvider } from "./glass-catalog.js";
import type { CaseStore } from "./store.js";
import { assertValidVin, VinValidationError } from "./vin-validation.js";
import { getVinSpendCapCents, MyGrantError } from "./mygrant.js";
import type {
  CaseRecord,
  GlassCandidate,
  GlassRequest,
  Vehicle
} from "./types.js";

/**
 * Glass Identification state machine (workflow-spec §4, Glass Identification).
 * Keys are current states, values map initiating events to next states.
 * This table is the single source of truth for legal identification
 * transitions; the API maps these errors to HTTP 409.
 */
export const IDENTIFICATION_TRANSITIONS: Record<string, Record<string, string>> = {
  REQUEST_RECEIVED: {
    START_IDENTIFICATION: "YMM_SEARCH_IN_PROGRESS"
  },
  YMM_SEARCH_IN_PROGRESS: {
    YMM_RESULTS_RETURNED: "YMM_RESULTS_FOUND",
    YMM_SEARCH_FAILED: "SYSTEM_ATTENTION_REQUIRED"
  },
  YMM_RESULTS_FOUND: {
    EVALUATE_GLASS_MATCHES: "GLASS_MATCH_EVALUATION"
  },
  GLASS_MATCH_EVALUATION: {
    GLASS_RESOLVED: "GLASS_IDENTIFIED",
    VIN_NEEDED: "VIN_LOOKUP_REQUIRED",
    HUMAN_REVIEW_NEEDED: "HUMAN_GLASS_REVIEW_REQUIRED",
    NO_VALID_GLASS: "GLASS_NOT_IDENTIFIED"
  },
  VIN_LOOKUP_REQUIRED: {
    START_VIN_LOOKUP: "VIN_LOOKUP_IN_PROGRESS",
    USE_SAVED_VIN_RESULT: "GLASS_MATCH_EVALUATION"
  },
  VIN_LOOKUP_IN_PROGRESS: {
    VIN_RESULT_RETURNED: "GLASS_MATCH_EVALUATION",
    VIN_LOOKUP_FAILED: "SYSTEM_ATTENTION_REQUIRED"
  },
  HUMAN_GLASS_REVIEW_REQUIRED: {
    HUMAN_GLASS_SELECTED: "GLASS_IDENTIFIED",
    HUMAN_CANNOT_IDENTIFY: "GLASS_NOT_IDENTIFIED"
  },
  // Deviation from the spec table (which routes retry through
  // REQUEST_VALIDATION_IN_PROGRESS): a retry re-runs identification against
  // the current intake data, so it re-enters the search directly.
  GLASS_NOT_IDENTIFIED: {
    RETRY_IDENTIFICATION: "YMM_SEARCH_IN_PROGRESS"
  },
  // Staff can retry after a YMM transport/parser failure without starting
  // a new case. YMM searches are free, so a retry spends no money.
  SYSTEM_ATTENTION_REQUIRED: {
    RETRY_IDENTIFICATION: "YMM_SEARCH_IN_PROGRESS"
  }
};

/** Glass types for which a paid VIN lookup is ever legal. */
const VIN_ELIGIBLE: ReadonlySet<string> = new Set(["WINDSHIELD", "BACK_GLASS"]);

export type IdentificationErrorCode =
  | "INVALID_TRANSITION"
  | "VIN_NOT_ELIGIBLE"
  | "VIN_LOOKUP_IN_PROGRESS"
  | "VIN_SPEND_CAP_EXCEEDED"
  | "INVALID_CANDIDATE"
  | "IDENTIFICATION_NOT_FOUND";

export class IdentificationError extends Error {
  constructor(
    readonly code: IdentificationErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "IdentificationError";
  }
}

export interface Actor {
  type: string;
  id: string | null;
}

const SYSTEM: Actor = { type: "SYSTEM", id: null };

function transition(caseRecord: CaseRecord, event: string): string {
  const next = IDENTIFICATION_TRANSITIONS[caseRecord.current_state]?.[event];
  if (!next) {
    throw new IdentificationError(
      "INVALID_TRANSITION",
      `Event ${event} is not legal from state ${caseRecord.current_state}.`,
      409
    );
  }
  return next;
}

async function loadCaseContext(store: CaseStore, caseId: string) {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const [vehicle, glassRequest] = await Promise.all([
    store.getVehicle(caseRecord.vehicle_id),
    store.getGlassRequest(caseRecord.glass_request_id)
  ]);
  if (!vehicle || !glassRequest) throw new Error("Case is missing vehicle or glass request.");
  return { caseRecord, vehicle, glassRequest };
}

/**
 * Runs YMM-first identification. Started by the client via the awaited
 * `start_identification` action right after intake; also the handler for
 * the staff `retry_identification` action. The whole run (identification +
 * the sourcing/pricing chain via advanceWorkflow) executes inside the
 * action's request lifecycle, so serverless platforms cannot freeze it
 * mid-processing — this is what replaced the old fire-and-forget
 * background chain on case creation.
 */
export async function runIdentification(
  store: CaseStore,
  provider: GlassCatalogProvider,
  caseId: string,
  initiatingEvent: "START_IDENTIFICATION" | "RETRY_IDENTIFICATION" = "START_IDENTIFICATION",
  actor: Actor = SYSTEM
): Promise<void> {
  const { caseRecord, vehicle, glassRequest } = await loadCaseContext(store, caseId);

  await store.appendEvent({
    caseId,
    eventType: initiatingEvent,
    actor,
    nextState: transition(caseRecord, initiatingEvent),
    payload: { provider: provider.name }
  });

  let candidates: GlassCandidate[];
  try {
    candidates = await provider.searchYmm({
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      glassType: glassRequest.glass_type
    });
  } catch (error) {
    await store.appendEvent({
      caseId,
      eventType: "YMM_SEARCH_FAILED",
      actor: SYSTEM,
      nextState: "SYSTEM_ATTENTION_REQUIRED",
      payload: { provider: provider.name, error: error instanceof Error ? error.message : "Unknown error" }
    });
    return;
  }

  await store.appendEvent({
    caseId,
    eventType: "YMM_RESULTS_RETURNED",
    actor: SYSTEM,
    nextState: transition({ ...caseRecord, current_state: "YMM_SEARCH_IN_PROGRESS" }, "YMM_RESULTS_RETURNED"),
    payload: { provider: provider.name, candidate_count: candidates.length }
  });
  await store.saveGlassIdentification({
    caseId,
    glassRequestId: glassRequest.id,
    method: "YMM",
    status: candidates.length ? "CANDIDATES_FOUND" : "FAILED",
    provider: provider.name,
    candidates
  });

  await store.appendEvent({
    caseId,
    eventType: "EVALUATE_GLASS_MATCHES",
    actor: SYSTEM,
    nextState: "GLASS_MATCH_EVALUATION",
    payload: { candidate_count: candidates.length }
  });

  await evaluateCandidates(store, caseId, glassRequest, candidates, provider.name, SYSTEM);
}

async function evaluateCandidates(
  store: CaseStore,
  caseId: string,
  glassRequest: GlassRequest,
  candidates: GlassCandidate[],
  providerName: string,
  actor: Actor
): Promise<void> {
  const distinctParts = new Set(candidates.map(c => c.part_number));
  // At this point the case is in GLASS_MATCH_EVALUATION (see runIdentification).
  const at = (event: string) =>
    transition({ current_state: "GLASS_MATCH_EVALUATION" } as CaseRecord, event);

  if (candidates.length === 0) {
    await store.appendEvent({
      caseId, eventType: "NO_VALID_GLASS", actor,
      nextState: at("NO_VALID_GLASS"),
      payload: { provider: providerName }
    });
    return;
  }

  // One candidate, or several equivalent ones (same part), resolves automatically.
  if (distinctParts.size === 1) {
    const selected = candidates[0];
    await store.saveGlassIdentification({
      caseId,
      glassRequestId: glassRequest.id,
      method: "YMM",
      status: "RESOLVED",
      provider: providerName,
      candidates,
      selectedCandidate: selected
    });
    await store.appendEvent({
      caseId, eventType: "GLASS_RESOLVED", actor,
      nextState: at("GLASS_RESOLVED"),
      payload: { provider: providerName, part_number: selected.part_number }
    });
    return;
  }

  // Material ambiguity remains.
  await store.saveGlassIdentification({
    caseId,
    glassRequestId: glassRequest.id,
    method: "YMM",
    status: "AMBIGUOUS",
    provider: providerName,
    candidates
  });

  if (VIN_ELIGIBLE.has(glassRequest.glass_type)) {
    await store.appendEvent({
      caseId, eventType: "VIN_NEEDED", actor,
      nextState: at("VIN_NEEDED"),
      payload: {
        provider: providerName,
        candidate_count: candidates.length,
        reason: "YMM results are materially ambiguous; VIN lookup is eligible."
      }
    });
  } else {
    // VIN is prohibited for Door/Quarter/Vent: a human must resolve it.
    await store.appendEvent({
      caseId, eventType: "HUMAN_REVIEW_NEEDED", actor,
      nextState: at("HUMAN_REVIEW_NEEDED"),
      payload: {
        provider: providerName,
        candidate_count: candidates.length,
        reason: `YMM results are ambiguous and VIN lookup is not eligible for ${glassRequest.glass_type}.`
      }
    });
  }
}

/**
 * How long a caller that lost the single-flight claim waits for the
 * winner's result before giving up with a retryable 409.
 */
const VIN_LOOKUP_WAIT_MS = 10_000;
const VIN_LOOKUP_POLL_MS = 250;

/** ISO timestamp for 00:00:00 UTC today: the spend-cap window is a UTC day. */
function startOfTodayUtcIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Reserves one paid lookup against the daily cap BEFORE submitting it.
 * Throws VIN_SPEND_CAP_EXCEEDED (loud, 402) when the reservation would
 * exceed today's cap — no lookup is submitted and no charge is incurred.
 * The reservation is the spend record: it stands on success and on failures
 * that may have been charged; the caller releases it on proven pre-submission
 * failures via releaseVinLookupSpend.
 */
async function reserveVinSpendOrThrow(
  store: CaseStore,
  vin: string,
  glassType: GlassRequest["glass_type"],
  costCents: number,
  providerName: string
): Promise<string> {
  const capCents = getVinSpendCapCents();
  const sinceIso = startOfTodayUtcIso();
  const reservation = await store.reserveVinLookupSpend({
    vin,
    glassType,
    costCents,
    provider: providerName,
    capCents,
    sinceIso
  });
  if (!reservation.reserved || !reservation.spendId) {
    const spentCents = await store.getVinLookupSpendCentsSince(sinceIso);
    throw new IdentificationError(
      "VIN_SPEND_CAP_EXCEEDED",
      `Daily paid VIN lookup spend cap reached ($${(spentCents / 100).toFixed(2)} of ` +
        `$${(capCents / 100).toFixed(2)} spent today). No lookup was submitted and no ` +
        `charge was incurred. Raise MYGRANT_DAILY_SPEND_CAP_USD to continue.`,
      402
    );
  }
  return reservation.spendId;
}

/**
 * Conservative charge accounting: assume a paid lookup was charged unless
 * the error proves it was never submitted. Our own pre-submission gates
 * (IdentificationError: spend cap, transitions) never charge; MyGrantError
 * carries an exact charged flag; unknown errors from a paid provider
 * default to charged.
 */
function lookupMayHaveBeenCharged(error: unknown): boolean {
  if (error instanceof IdentificationError) return false;
  if (error instanceof MyGrantError) return error.charged;
  return true;
}

async function waitForVinLookupResult(
  store: CaseStore,
  vin: string,
  glassType: GlassRequest["glass_type"]
) {
  const deadline = Date.now() + VIN_LOOKUP_WAIT_MS;
  for (;;) {
    const result = await store.findVinLookup(vin, glassType);
    if (result?.success) return result;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, VIN_LOOKUP_POLL_MS));
  }
}

/**
 * Staff-confirmed paid VIN lookup. Guardrails (all backend-enforced):
 * - only from VIN_LOOKUP_REQUIRED,
 * - only for WINDSHIELD / BACK_GLASS (never Door/Quarter/Vent),
 * - the VIN passes the shared ISO 3779 gate (format + check digit),
 * - a saved successful result for this (VIN, glass type) is reused
 *   instead of repurchased; results are never shared across glass types,
 * - concurrent requests for the same (VIN, glass type) single-flight on
 *   a store-backed claim so the paid call happens at most once.
 */
export async function requestVinLookup(
  store: CaseStore,
  provider: GlassCatalogProvider,
  caseId: string,
  actor: Actor
): Promise<void> {
  const { caseRecord, vehicle, glassRequest } = await loadCaseContext(store, caseId);

  if (caseRecord.current_state !== "VIN_LOOKUP_REQUIRED") {
    throw new IdentificationError(
      "VIN_NOT_ELIGIBLE",
      `VIN lookup is not available from state ${caseRecord.current_state}.`,
      409
    );
  }
  if (!VIN_ELIGIBLE.has(glassRequest.glass_type)) {
    throw new IdentificationError(
      "VIN_NOT_ELIGIBLE",
      `VIN lookup is never eligible for ${glassRequest.glass_type}.`,
      409
    );
  }
  let vin: string;
  try {
    vin = assertValidVin(vehicle.vin);
  } catch (error) {
    throw new IdentificationError(
      "VIN_NOT_ELIGIBLE",
      error instanceof VinValidationError
        ? error.message
        : "A valid 17-character VIN is required for VIN lookup.",
      422
    );
  }

  // Sequential duplicate-charge prevention: reuse this glass type's
  // saved successful result. One VIN entry holds per-glass-type results,
  // so a Windshield lookup is never served to a Back Glass case.
  const cached = await store.findVinLookup(vin, glassRequest.glass_type);
  if (cached?.success) {
    await store.appendEvent({
      caseId,
      eventType: "USE_SAVED_VIN_RESULT",
      actor,
      nextState: transition(caseRecord, "USE_SAVED_VIN_RESULT"),
      payload: { vin, cached: true, charged: false }
    });
    await evaluateVinResult(store, caseId, glassRequest, cached.candidates, provider.name, actor, false, cached.interchangePartNumbers);
    return;
  }

  // Concurrent duplicate-charge prevention: only the claim winner pays
  // for the lookup. Losers wait briefly for the winner's cached result.
  const wonClaim = await store.claimVinLookup(vin, glassRequest.glass_type);
  if (!wonClaim) {
    const winnerResult = await waitForVinLookupResult(store, vin, glassRequest.glass_type);
    if (winnerResult?.success) {
      await store.appendEvent({
        caseId,
        eventType: "USE_SAVED_VIN_RESULT",
        actor,
        nextState: transition(caseRecord, "USE_SAVED_VIN_RESULT"),
        payload: { vin, cached: true, charged: false, shared_lookup: true }
      });
      await evaluateVinResult(store, caseId, glassRequest, winnerResult.candidates, provider.name, actor, false, winnerResult.interchangePartNumbers);
      return;
    }
    throw new IdentificationError(
      "VIN_LOOKUP_IN_PROGRESS",
      "A VIN lookup for this vehicle and glass type is already in progress. Please retry shortly.",
      409
    );
  }

  // Provenance for the spend reservation: declared outside try so the catch
  // block can release it on proven-no-charge failures.
  let spendId: string | null = null;
  try {
    // Paid-provider guardrails: cache and single-flight already guarantee
    // this lookup is genuinely new, so a nonzero cost means real money is
    // about to be spent. Reserve the charge against the daily cap atomically
    // BEFORE submitting — the cap check and the ledger insert are one step,
    // so concurrent paid lookups cannot race under the cap.
    const costCents = provider.vinLookupCostCents ?? 0;
    const paidLookup = costCents > 0;
    if (paidLookup) {
      spendId = await reserveVinSpendOrThrow(store, vin, glassRequest.glass_type, costCents, provider.name);
    }

    await store.appendEvent({
      caseId,
      eventType: "START_VIN_LOOKUP",
      actor,
      nextState: transition(caseRecord, "START_VIN_LOOKUP"),
      payload: { vin, charged: paidLookup, provider: provider.name }
    });

    const lookup = await provider.lookupVin(vin, glassRequest.glass_type);
    // The reservation above is already the spend record: success needs no
    // second insert, and neither does a failure that may have been charged.
    await store.saveVinLookup({
      vin,
      glassType: glassRequest.glass_type,
      result: {
        success: true,
        decoded: lookup.decoded,
        candidates: lookup.candidates,
        interchangePartNumbers: lookup.interchangePartNumbers,
        oemPartNumbers: lookup.oemPartNumbers
      }
    });
    await store.appendEvent({
      caseId,
      eventType: "VIN_RESULT_RETURNED",
      actor: SYSTEM,
      nextState: transition({ ...caseRecord, current_state: "VIN_LOOKUP_IN_PROGRESS" }, "VIN_RESULT_RETURNED"),
      payload: { vin, charged: paidLookup, provider: provider.name, candidate_count: lookup.candidates.length }
    });
    await evaluateVinResult(store, caseId, glassRequest, lookup.candidates, provider.name, SYSTEM, paidLookup, lookup.interchangePartNumbers);
  } catch (error) {
    // A failure after submission may still have consumed the $1 credit
    // (MyGrantError.charged): the reservation stands as the conservative
    // record, keeping the cap honest about real money. A proven
    // pre-submission failure releases the reservation instead.
    if (spendId && !lookupMayHaveBeenCharged(error)) {
      await store.releaseVinLookupSpend(spendId);
    }
    await store.saveVinLookup({
      vin,
      glassType: glassRequest.glass_type,
      result: {
        success: false,
        candidates: [],
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    await store.appendEvent({
      caseId,
      eventType: "VIN_LOOKUP_FAILED",
      actor: SYSTEM,
      nextState: "SYSTEM_ATTENTION_REQUIRED",
      payload: { vin, error: error instanceof Error ? error.message : "Unknown error" }
    });
  } finally {
    await store.releaseVinLookup(vin, glassRequest.glass_type);
  }
}

async function evaluateVinResult(
  store: CaseStore,
  caseId: string,
  glassRequest: GlassRequest,
  candidates: GlassCandidate[],
  providerName: string,
  actor: Actor,
  charged: boolean,
  interchangePartNumbers?: string[]
): Promise<void> {
  await store.saveGlassIdentification({
    caseId,
    glassRequestId: glassRequest.id,
    method: "VIN",
    status: candidates.length === 1 ? "RESOLVED" : "AMBIGUOUS",
    provider: providerName,
    candidates,
    selectedCandidate: candidates.length === 1 ? candidates[0] : null,
    interchangePartNumbers
  });

  // The case is in GLASS_MATCH_EVALUATION after the VIN result event.
  const at = (event: string) =>
    transition({ current_state: "GLASS_MATCH_EVALUATION" } as CaseRecord, event);

  if (candidates.length === 1) {
    await store.appendEvent({
      caseId, eventType: "GLASS_RESOLVED", actor,
      nextState: at("GLASS_RESOLVED"),
      payload: { method: "VIN", charged, part_number: candidates[0].part_number, interchange_count: interchangePartNumbers?.length ?? 0 }
    });
  } else {
    await store.appendEvent({
      caseId, eventType: "HUMAN_REVIEW_NEEDED", actor,
      nextState: at("HUMAN_REVIEW_NEEDED"),
      payload: { method: "VIN", charged, candidate_count: candidates.length }
    });
  }
}

/** Staff resolves human review by picking one of the persisted candidates. */
export async function selectGlassCandidate(
  store: CaseStore,
  caseId: string,
  partNumber: string,
  actor: Actor
): Promise<void> {
  const { caseRecord, glassRequest } = await loadCaseContext(store, caseId);

  if (caseRecord.current_state !== "HUMAN_GLASS_REVIEW_REQUIRED") {
    throw new IdentificationError(
      "INVALID_TRANSITION",
      `Candidate selection is not available from state ${caseRecord.current_state}.`,
      409
    );
  }

  const identification = await store.getLatestGlassIdentification(glassRequest.id);
  if (!identification) {
    throw new IdentificationError(
      "IDENTIFICATION_NOT_FOUND",
      "No glass identification has been run for this case.",
      409
    );
  }
  const candidate = identification.candidates.find(c => c.part_number === partNumber);
  if (!candidate) {
    throw new IdentificationError(
      "INVALID_CANDIDATE",
      "The selected part number is not one of the identified candidates.",
      422
    );
  }

  await store.saveGlassIdentification({
    caseId,
    glassRequestId: glassRequest.id,
    method: identification.method,
    status: "RESOLVED",
    provider: identification.provider,
    candidates: identification.candidates,
    selectedCandidate: candidate
  });
  await store.appendEvent({
    caseId,
    eventType: "HUMAN_GLASS_SELECTED",
    actor,
    nextState: transition(caseRecord, "HUMAN_GLASS_SELECTED"),
    payload: { part_number: candidate.part_number, basis: "staff-selection" }
  });
}

/** Staff records that the glass cannot be identified from available data. */
export async function markGlassUnidentifiable(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<void> {
  const { caseRecord } = await loadCaseContext(store, caseId);
  await store.appendEvent({
    caseId,
    eventType: "HUMAN_CANNOT_IDENTIFY",
    actor,
    nextState: transition(caseRecord, "HUMAN_CANNOT_IDENTIFY")
  });
}

/**
 * Staff overrides the system-selected glass candidate after the case has
 * already advanced past identification. The override is an explicit,
 * audited action: it records the old and new part numbers, rewinds the
 * case to GLASS_IDENTIFIED, and the caller re-runs sourcing + pricing
 * for the new part via advanceWorkflow.
 *
 * The replacement must be one of the candidates from the latest
 * identification run — constrained choice, not free text.
 */
const OVERRIDE_ELIGIBLE_STATES = new Set([
  "GLASS_IDENTIFIED",
  "GLASS_SELECTED",
  "PRICE_CALCULATED",
  "PROFIT_REVIEW",
  "PRICE_APPROVED"
]);

export async function overrideGlassCandidate(
  store: CaseStore,
  caseId: string,
  partNumber: string,
  actor: Actor
): Promise<void> {
  const { caseRecord, glassRequest } = await loadCaseContext(store, caseId);

  if (!OVERRIDE_ELIGIBLE_STATES.has(caseRecord.current_state)) {
    throw new IdentificationError(
      "INVALID_TRANSITION",
      `Glass override is not available from state ${caseRecord.current_state}.`,
      409
    );
  }

  const identification = await store.getLatestGlassIdentification(glassRequest.id);
  if (!identification?.selected_candidate) {
    throw new IdentificationError(
      "IDENTIFICATION_NOT_FOUND",
      "No selected glass candidate to override.",
      409
    );
  }
  const candidate = identification.candidates.find(c => c.part_number === partNumber);
  if (!candidate) {
    throw new IdentificationError(
      "INVALID_CANDIDATE",
      "The override part number is not one of the identified candidates.",
      422
    );
  }
  if (candidate.part_number === identification.selected_candidate.part_number) {
    throw new IdentificationError(
      "INVALID_CANDIDATE",
      "The override part is already the selected candidate.",
      422
    );
  }

  const oldPartNumber = identification.selected_candidate.part_number;
  await store.saveGlassIdentification({
    caseId,
    glassRequestId: glassRequest.id,
    method: identification.method,
    status: "RESOLVED",
    provider: identification.provider,
    candidates: identification.candidates,
    selectedCandidate: candidate
  });
  await store.appendEvent({
    caseId,
    eventType: "GLASS_CANDIDATE_OVERRIDDEN",
    actor,
    nextState: "GLASS_IDENTIFIED",
    payload: {
      old_part_number: oldPartNumber,
      new_part_number: candidate.part_number,
      basis: "staff-override"
    }
  });
}
