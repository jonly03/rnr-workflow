import type { CaseStore } from "./store.js";
import type { CaseRecord } from "./types.js";

/**
 * Fulfillment lifecycle (customer tracking): what happens to a job AFTER
 * the signed quote has become an invoice.
 *
 *   INVOICED --order_parts--> PARTS_ORDERED
 *   PARTS_ORDERED --schedule_installation--> INSTALLATION_SCHEDULED
 *   INSTALLATION_SCHEDULED --dispatch_technician--> TECH_DISPATCHED
 *   TECH_DISPATCHED --start_service--> INSTALLATION_IN_PROGRESS
 *   INSTALLATION_IN_PROGRESS --complete_service--> SERVICE_COMPLETED
 *   SERVICE_COMPLETED --close_case--> CLOSED   (closeCase, in quoting.ts)
 *
 * Every step is a staff action that appends an event; the customer's
 * tracking page projects those events into milestones. TECH_DISPATCHED is
 * a real state (not just an event) because "the tech is on the way" is a
 * distinct operational moment R&R coordinates around — and the moment the
 * customer most wants to see.
 */

export interface LifecycleStep {
  /** Staff action name accepted by POST /cases/:id/actions. */
  action: string;
  from: string;
  to: string;
  eventType: string;
}

export const LIFECYCLE_STEPS: Record<string, LifecycleStep> = {
  order_parts: {
    action: "order_parts",
    from: "INVOICED",
    to: "PARTS_ORDERED",
    eventType: "PARTS_ORDERED"
  },
  schedule_installation: {
    action: "schedule_installation",
    from: "PARTS_ORDERED",
    to: "INSTALLATION_SCHEDULED",
    eventType: "INSTALLATION_SCHEDULED"
  },
  dispatch_technician: {
    action: "dispatch_technician",
    from: "INSTALLATION_SCHEDULED",
    to: "TECH_DISPATCHED",
    eventType: "TECH_DISPATCHED"
  },
  start_service: {
    action: "start_service",
    from: "TECH_DISPATCHED",
    to: "INSTALLATION_IN_PROGRESS",
    eventType: "SERVICE_STARTED"
  },
  complete_service: {
    action: "complete_service",
    from: "INSTALLATION_IN_PROGRESS",
    to: "SERVICE_COMPLETED",
    eventType: "SERVICE_COMPLETED"
  }
};

/** Ordered list of fulfillment states, for projections and staff UI. */
export const FULFILLMENT_STATES = [
  "INVOICED",
  "PARTS_ORDERED",
  "INSTALLATION_SCHEDULED",
  "TECH_DISPATCHED",
  "INSTALLATION_IN_PROGRESS",
  "SERVICE_COMPLETED"
] as const;

export type LifecycleErrorCode = "INVALID_TRANSITION";

export class LifecycleError extends Error {
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface Actor {
  type: string;
  id: string | null;
}

/**
 * Advances one fulfillment step. Only the step's safe payload fields are
 * recorded on the event (scheduled_at, technician_name, note) — the event
 * payload is projected to the customer tracking page, so nothing internal
 * may ride along here.
 */
export async function advanceLifecycle(
  store: CaseStore,
  caseId: string,
  action: string,
  actor: Actor,
  payload: Record<string, unknown> = {}
): Promise<CaseRecord> {
  const step = LIFECYCLE_STEPS[action];
  if (!step) {
    throw new LifecycleError(
      "INVALID_TRANSITION",
      `Action ${action} is not a fulfillment step.`,
      409
    );
  }
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  if (caseRecord.current_state !== step.from) {
    throw new LifecycleError(
      "INVALID_TRANSITION",
      `Action ${action} is not available from state ${caseRecord.current_state}.`,
      409
    );
  }
  const safePayload: Record<string, unknown> = {};
  for (const field of ["scheduled_at", "technician_name", "note"] as const) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      safePayload[field] = value.trim();
    }
  }
  await store.appendEvent({
    caseId,
    eventType: step.eventType,
    actor: { type: actor.type, id: actor.id },
    nextState: step.to,
    payload: safePayload
  });
  const updated = await store.getCase(caseId);
  if (!updated) throw new Error("Case not found.");
  return updated;
}
