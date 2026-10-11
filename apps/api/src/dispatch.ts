import { hashPassword } from "./auth.js";
import type { Appointment, AppointmentStatus, StaffUser } from "./types.js";
import type { CaseStore } from "./store.js";

/**
 * Phase 4b install tracking: one status stream drives the technician view,
 * the dispatcher map monitor, and the client tracker.
 *
 * Forward-compat assumptions (for the install slice integration later):
 * - schedule_install will create these appointment rows for real (address
 *   captured at schedule time, geocoded via Nominatim). Seeded demo rows
 *   use the same shape, so the views don't care which created them.
 * - These actions currently leave case.current_state untouched (install
 *   states don't exist yet). When they land, tech_en_route should also
 *   move the case (e.g. INSTALL_IN_PROGRESS).
 * - No continuous GPS: the tech's map pin is the address of their latest
 *   EN_ROUTE/ARRIVED appointment (status-driven, v1).
 */

export class DispatchError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "DispatchError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/** Legal per-appointment transitions. Everything else is a 409. */
export const APPOINTMENT_TRANSITIONS: Record<
  AppointmentStatus,
  { action: string; eventType: string; next: AppointmentStatus }
> = {
  SCHEDULED: { action: "tech_en_route", eventType: "TECH_EN_ROUTE", next: "EN_ROUTE" },
  EN_ROUTE: { action: "tech_arrived", eventType: "TECH_ARRIVED", next: "ARRIVED" },
  ARRIVED: { action: "tech_complete", eventType: "JOB_COMPLETE", next: "COMPLETE" },
  COMPLETE: { action: "", eventType: "", next: "COMPLETE" }
};

export const TRACKING_ACTIONS = ["tech_en_route", "tech_arrived", "tech_complete"] as const;
export type TrackingAction = (typeof TRACKING_ACTIONS)[number];

export function isTrackingAction(action: string): action is TrackingAction {
  return (TRACKING_ACTIONS as readonly string[]).includes(action);
}

/** YYYY-MM-DD for "today" (server local time; demo-grade). */
export function todayDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Advances one appointment's tracking status. Throws DispatchError on
 * missing appointment (404), illegal transition (409), or a technician
 * touching someone else's job (403). Staff/dispatchers may advance on a
 * tech's behalf.
 */
export async function advanceTracking(
  store: CaseStore,
  caseId: string,
  action: TrackingAction,
  staff: StaffUser | undefined
): Promise<Appointment> {
  const appointment = await store.getAppointmentByCaseId(caseId);
  if (!appointment) {
    throw new DispatchError(
      404,
      "APPOINTMENT_NOT_FOUND",
      "This case has no install appointment yet."
    );
  }
  const transition = APPOINTMENT_TRANSITIONS[appointment.status];
  if (!transition.action || transition.action !== action) {
    throw new DispatchError(
      409,
      "ILLEGAL_TRACKING_TRANSITION",
      `Cannot ${action} from ${appointment.status}.`
    );
  }
  if (
    staff?.role === "technician" &&
    appointment.technician_id &&
    appointment.technician_id !== staff.id
  ) {
    throw new DispatchError(
      403,
      "NOT_YOUR_JOB",
      "Technicians can only update their own assigned jobs."
    );
  }

  const actor = { type: "RNR_STAFF", id: staff?.id ?? null };
  await store.appendEvent({
    caseId,
    eventType: transition.eventType,
    actor,
    payload: {
      appointment_id: appointment.id,
      from_status: appointment.status,
      to_status: transition.next,
      technician_id: appointment.technician_id,
      technician_name: appointment.technician_name
    }
    // NOTE: case.current_state is intentionally untouched — install states
    // don't exist yet (Phase 4 core). See module doc.
  });
  const updated = await store.updateAppointmentStatus(appointment.id, transition.next);
  if (!updated) {
    throw new DispatchError(500, "APPOINTMENT_UPDATE_FAILED", "Could not update the appointment.");
  }
  return updated;
}

// --- Demo seed -----------------------------------------------------------

/**
 * Demo technician account for Lou's independent test of the tech view.
 * Demo branch only — never production. Documented in the plan doc.
 */
export const DEMO_TECH_EMAIL = "tech@rnr.demo";
export const DEMO_TECH_PASSWORD = "demo-tech-1234";

interface DemoJob {
  seedKey: string;
  year: number;
  make: string;
  model: string;
  vin: string;
  glassType: "WINDSHIELD" | "BACK_GLASS";
  customerName: string;
  serviceAddress: string;
  lat: number;
  lng: number;
  timeWindow: string;
}

/** Fixed pins (Worcester MA area). Real geocoding via Nominatim comes later. */
const DEMO_JOBS: DemoJob[] = [
  {
    seedKey: "dispatch-demo-1",
    year: 2020, make: "Honda", model: "Accord",
    vin: "1HGCM82633A004352",
    glassType: "WINDSHIELD",
    customerName: "Sarah M.",
    serviceAddress: "100 Front St, Worcester, MA 01608",
    lat: 42.2626, lng: -71.8023,
    timeWindow: "9:00\u201311:00 AM"
  },
  {
    seedKey: "dispatch-demo-2",
    year: 2018, make: "Jeep", model: "Wrangler",
    vin: "1C4HJXEG3JW224862",
    glassType: "BACK_GLASS",
    customerName: "James T.",
    serviceAddress: "120 Green St, Worcester, MA 01604",
    lat: 42.2650, lng: -71.7950,
    timeWindow: "11:30 AM\u20131:30 PM"
  },
  {
    seedKey: "dispatch-demo-3",
    year: 2022, make: "Ford", model: "F-150",
    vin: "1FTFW1E54NFA00042",
    glassType: "WINDSHIELD",
    customerName: "Priya R.",
    serviceAddress: "50 Main St, Shrewsbury, MA 01545",
    lat: 42.2950, lng: -71.7120,
    timeWindow: "2:00\u20134:00 PM"
  }
];

/**
 * Idempotent demo seed: creates the demo technician (once) and one case +
 * appointment per demo job (case creation reuses idempotency keys; existing
 * appointments are never duplicated). Runs lazily from the dispatch routes
 * so it works on serverless without a boot hook. Disable with
 * DISPATCH_DEMO_SEED=false.
 */
export async function ensureDispatchDemoSeed(store: CaseStore): Promise<void> {
  if (process.env.DISPATCH_DEMO_SEED === "false") return;

  let tech = await store.findStaffByEmail(DEMO_TECH_EMAIL);
  if (!tech) {
    try {
      await store.createStaffUser({
        email: DEMO_TECH_EMAIL,
        name: "Demo Tech",
        role: "technician",
        passwordHash: await hashPassword(DEMO_TECH_PASSWORD)
      });
    } catch {
      // Raced with another instance — fall through to the re-read.
    }
    tech = await store.findStaffByEmail(DEMO_TECH_EMAIL);
  }
  if (!tech) return;

  const scheduledDate = todayDate();
  for (const job of DEMO_JOBS) {
    const { caseRecord } = await store.createCase({
      channel: "DIRECT",
      customer_id: null,
      vehicle: { year: job.year, make: job.make, model: job.model, vin: job.vin },
      glass_type: job.glassType,
      idempotencyKey: job.seedKey,
      actor: { type: "SYSTEM", id: null }
    });
    const existing = await store.getAppointmentByCaseId(caseRecord.id);
    if (existing) continue;
    await store.createAppointment({
      caseId: caseRecord.id,
      technicianId: tech.id,
      technicianName: tech.name,
      serviceAddress: job.serviceAddress,
      lat: job.lat,
      lng: job.lng,
      scheduledDate,
      timeWindow: job.timeWindow,
      customerName: job.customerName
    });
  }
}
