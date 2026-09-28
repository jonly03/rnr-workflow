import type { GlassCatalogProvider } from "./glass-catalog.js";
import type { CaseStore } from "./store.js";
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
  }
};

/** Glass types for which a paid VIN lookup is ever legal. */
const VIN_ELIGIBLE: ReadonlySet<string> = new Set(["WINDSHIELD", "BACK_GLASS"]);

export type IdentificationErrorCode =
  | "INVALID_TRANSITION"
  | "VIN_NOT_ELIGIBLE"
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
 * Runs YMM-first identification. Automatic after valid intake; also the
 * handler for the staff `start_identification` / `retry_identification`
 * actions. The mock provider is synchronous-fast; a live provider would move
 * this to background processing without changing the contract.
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
 * Staff-confirmed paid VIN lookup. Guardrails (all backend-enforced):
 * - only from VIN_LOOKUP_REQUIRED,
 * - only for WINDSHIELD / BACK_GLASS (never Door/Quarter/Vent),
 * - a saved successful VIN result is reused instead of repurchasing.
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
  if (vehicle.vin.trim().length !== 17) {
    throw new IdentificationError(
      "VIN_NOT_ELIGIBLE",
      "A 17-character VIN is required for VIN lookup.",
      422
    );
  }

  // Duplicate-charge prevention: reuse a saved successful result.
  const cached = await store.findVinLookup(vehicle.vin);
  if (cached?.success) {
    await store.appendEvent({
      caseId,
      eventType: "USE_SAVED_VIN_RESULT",
      actor,
      nextState: transition(caseRecord, "USE_SAVED_VIN_RESULT"),
      payload: { vin: vehicle.vin, cached: true, charged: false }
    });
    const result = cached.result as { candidates?: GlassCandidate[] };
    await evaluateVinResult(store, caseId, glassRequest, result.candidates ?? [], provider.name, actor, false);
    return;
  }

  await store.appendEvent({
    caseId,
    eventType: "START_VIN_LOOKUP",
    actor,
    nextState: transition(caseRecord, "START_VIN_LOOKUP"),
    payload: { vin: vehicle.vin, charged: true, provider: provider.name }
  });

  try {
    const lookup = await provider.lookupVin(vehicle.vin);
    await store.saveVinLookup({ vin: vehicle.vin, success: true, result: lookup as unknown as Record<string, unknown> });
    await store.appendEvent({
      caseId,
      eventType: "VIN_RESULT_RETURNED",
      actor: SYSTEM,
      nextState: transition({ ...caseRecord, current_state: "VIN_LOOKUP_IN_PROGRESS" }, "VIN_RESULT_RETURNED"),
      payload: { vin: vehicle.vin, charged: true, provider: provider.name, candidate_count: lookup.candidates.length }
    });
    await evaluateVinResult(store, caseId, glassRequest, lookup.candidates, provider.name, SYSTEM, true);
  } catch (error) {
    await store.saveVinLookup({
      vin: vehicle.vin,
      success: false,
      result: { error: error instanceof Error ? error.message : "Unknown error" }
    });
    await store.appendEvent({
      caseId,
      eventType: "VIN_LOOKUP_FAILED",
      actor: SYSTEM,
      nextState: "SYSTEM_ATTENTION_REQUIRED",
      payload: { vin: vehicle.vin, error: error instanceof Error ? error.message : "Unknown error" }
    });
  }
}

async function evaluateVinResult(
  store: CaseStore,
  caseId: string,
  glassRequest: GlassRequest,
  candidates: GlassCandidate[],
  providerName: string,
  actor: Actor,
  charged: boolean
): Promise<void> {
  await store.saveGlassIdentification({
    caseId,
    glassRequestId: glassRequest.id,
    method: "VIN",
    status: candidates.length === 1 ? "RESOLVED" : "AMBIGUOUS",
    provider: providerName,
    candidates,
    selectedCandidate: candidates.length === 1 ? candidates[0] : null
  });

  // The case is in GLASS_MATCH_EVALUATION after the VIN result event.
  const at = (event: string) =>
    transition({ current_state: "GLASS_MATCH_EVALUATION" } as CaseRecord, event);

  if (candidates.length === 1) {
    await store.appendEvent({
      caseId, eventType: "GLASS_RESOLVED", actor,
      nextState: at("GLASS_RESOLVED"),
      payload: { method: "VIN", charged, part_number: candidates[0].part_number }
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
