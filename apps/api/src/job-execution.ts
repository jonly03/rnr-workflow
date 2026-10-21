import type { CaseStore } from "./store.js";
import { advanceLifecycle } from "./lifecycle.js";
import { dayRangeUtc, operatorTimezone, todayKey } from "./scheduler.js";
import type { Job, JobStepEvent } from "./types.js";

/**
 * Job execution — Fulfillment Slice B (brief §3.3, §4).
 *
 * The tech works ONE job through a fixed checklist. Steps are
 * append-only events on the job (never on the case); the case state
 * stays coarse — the first step drives the case to
 * INSTALLATION_IN_PROGRESS via the existing lifecycle transitions and
 * FINISHED drives it to SERVICE_COMPLETED, so the staff dashboard and
 * the client tracker advance from the tech's taps alone.
 *
 * Law enforced here, server-side:
 *  - steps complete strictly IN ORDER (no skipping, no repeats);
 *  - only the job's ASSIGNED tech may advance it (staff are read-only
 *    on steps in v1 — they watch progress, they don't tap for the tech);
 *  - BEFORE_PHOTOS requires ≥1 confirmed before photo on the job;
 *    AFTER_PHOTOS requires ≥1 confirmed after photo;
 *  - CLIENT_CHECKIN records who confirmed the work on site.
 */

export const JOB_STEP_SEQUENCE = [
  "PICKUP",
  "PICKED_UP",
  "EN_ROUTE",
  "ARRIVED",
  "CHECKED_IN",
  "BEFORE_PHOTOS",
  "PREP_STARTED",
  "PREP_DONE",
  "INSTALL_STARTED",
  "INSTALL_DONE",
  "AFTER_PHOTOS",
  "CLIENT_CHECKIN",
  "FINISHED"
] as const;

export type JobStep = (typeof JOB_STEP_SEQUENCE)[number];

export const JOB_STEP_LABELS: Record<JobStep, string> = {
  PICKUP: "Go pick up the order",
  PICKED_UP: "Order picked up",
  EN_ROUTE: "Head to the client",
  ARRIVED: "Arrived at the client",
  CHECKED_IN: "Check in with the client",
  BEFORE_PHOTOS: "Upload before photos",
  PREP_STARTED: "Start prep",
  PREP_DONE: "Prep done",
  INSTALL_STARTED: "Start install (remove, clean, install)",
  INSTALL_DONE: "Install done",
  AFTER_PHOTOS: "Upload after photos",
  CLIENT_CHECKIN: "Client check-in",
  FINISHED: "Finish job"
};

export function isJobStep(value: unknown): value is JobStep {
  return (
    typeof value === "string" &&
    (JOB_STEP_SEQUENCE as readonly string[]).includes(value)
  );
}

export type JobExecutionErrorCode =
  | "JOB_NOT_FOUND"
  | "JOB_NOT_ASSIGNED_TO_TECH"
  | "INVALID_STATE"
  | "STEP_OUT_OF_ORDER"
  | "PHOTOS_REQUIRED"
  | "VALIDATION_ERROR";

export class JobExecutionError extends Error {
  constructor(
    readonly code: JobExecutionErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "JobExecutionError";
  }
}

/** step → its completion event, from a job's append-only step log. */
export function completedSteps(events: JobStepEvent[]): Map<JobStep, JobStepEvent> {
  const done = new Map<JobStep, JobStepEvent>();
  for (const event of events) {
    if (isJobStep(event.step) && !done.has(event.step)) {
      done.set(event.step, event);
    }
  }
  return done;
}

/** The next step the tech must complete, or null when the job is done. */
export function nextStep(events: JobStepEvent[]): JobStep | null {
  const done = completedSteps(events);
  for (const step of JOB_STEP_SEQUENCE) {
    if (!done.has(step)) return step;
  }
  return null;
}

async function readyPhotoCount(
  store: CaseStore,
  job: Job,
  kind: "BEFORE_PHOTO" | "AFTER_PHOTO"
): Promise<number> {
  const assets = await store.listCaseAssets(job.case_id);
  return assets.filter(
    a => a.job_id === job.id && a.kind === kind && a.status === "READY"
  ).length;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Advances one checklist step for the assigned tech. Throws
 * JobExecutionError on any law violation; returns the fresh job +
 * step log on success.
 */
export async function advanceJobStep(
  store: CaseStore,
  input: {
    jobId: string;
    step: string;
    actor: { type: string; id: string | null };
    payload?: Record<string, unknown>;
  }
): Promise<{ job: Job; steps: JobStepEvent[] }> {
  const job = await store.getJob(input.jobId);
  if (!job) {
    throw new JobExecutionError("JOB_NOT_FOUND", "Job not found.", 404);
  }
  if (input.actor.type !== "TECH" || !input.actor.id) {
    throw new JobExecutionError(
      "JOB_NOT_ASSIGNED_TO_TECH",
      "Only the assigned technician can work this job's checklist.",
      403
    );
  }
  if (job.assigned_tech_id !== input.actor.id) {
    throw new JobExecutionError(
      "JOB_NOT_ASSIGNED_TO_TECH",
      "This job is assigned to a different technician.",
      403
    );
  }
  if (job.status !== "ASSIGNED" && job.status !== "IN_PROGRESS") {
    throw new JobExecutionError(
      "INVALID_STATE",
      `This job is not workable (status: ${job.status}).`,
      409
    );
  }
  if (!isJobStep(input.step)) {
    throw new JobExecutionError("VALIDATION_ERROR", "Unknown checklist step.", 422);
  }
  const step = input.step;

  const events = await store.listJobStepEvents(job.id);
  const expected = nextStep(events);
  if (expected === null) {
    throw new JobExecutionError("INVALID_STATE", "This job is already finished.", 409);
  }
  if (step !== expected) {
    throw new JobExecutionError(
      "STEP_OUT_OF_ORDER",
      `Steps must be completed in order. Next step: ${JOB_STEP_LABELS[expected]}.`,
      409
    );
  }

  // Photo gates: the step records that photos exist, so at least one
  // confirmed photo of the right kind must already be on the job.
  if (step === "BEFORE_PHOTOS" && (await readyPhotoCount(store, job, "BEFORE_PHOTO")) === 0) {
    throw new JobExecutionError(
      "PHOTOS_REQUIRED",
      "Upload at least one before photo first, then record this step.",
      422
    );
  }
  if (step === "AFTER_PHOTOS" && (await readyPhotoCount(store, job, "AFTER_PHOTO")) === 0) {
    throw new JobExecutionError(
      "PHOTOS_REQUIRED",
      "Upload at least one after photo first, then record this step.",
      422
    );
  }

  const payload: Record<string, unknown> = {};
  if (step === "CLIENT_CHECKIN") {
    const clientName =
      typeof input.payload?.client_name === "string"
        ? input.payload.client_name.trim()
        : "";
    if (!clientName) {
      throw new JobExecutionError(
        "VALIDATION_ERROR",
        "Record the name of the client who confirmed the finished work.",
        422
      );
    }
    payload.client_name = clientName;
    if (typeof input.payload?.note === "string" && input.payload.note.trim()) {
      payload.note = input.payload.note.trim().slice(0, 500);
    }
  }

  await store.appendJobStepEvent({
    jobId: job.id,
    caseId: job.case_id,
    step,
    actor: input.actor,
    payload
  });

  const caseRecord = await store.getCase(job.case_id);
  // Lifecycle events keep the tech as their actor (the taps came from
  // the tech); projections key off event type, not actor.
  const techActor = { type: input.actor.type, id: input.actor.id };

  if (step === "PICKUP") {
    await store.updateJob(job.id, { status: "IN_PROGRESS" });
    // Starting work = the case's service has started (§3.3 mapping).
    // Drive through the existing lifecycle so every projection and the
    // client tracker see the same events as a staff-driven start. Each
    // transition fires only from its own `from` state, so a case staff
    // already advanced by hand is left exactly as it is.
    if (caseRecord?.current_state === "INSTALLATION_SCHEDULED") {
      const tech = await store.getStaffById(input.actor.id);
      await advanceLifecycle(store, job.case_id, "dispatch_technician", techActor, {
        technician_name: tech ? firstName(tech.name) : "Technician"
      });
    }
    const afterDispatch = await store.getCase(job.case_id);
    if (afterDispatch?.current_state === "TECH_DISPATCHED") {
      await advanceLifecycle(store, job.case_id, "start_service", techActor, {});
    }
  }

  if (step === "FINISHED") {
    await store.updateJob(job.id, { status: "COMPLETED" });
    const current = await store.getCase(job.case_id);
    if (current?.current_state === "INSTALLATION_IN_PROGRESS") {
      await advanceLifecycle(store, job.case_id, "complete_service", techActor, {});
    }
  }

  const freshJob = (await store.getJob(job.id)) ?? job;
  const steps = await store.listJobStepEvents(job.id);
  return { job: freshJob, steps };
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

/** Client contact + service address for a job, read defensively from
 *  the intake event (the address capture lands in a separate intake
 *  branch; when the case carries no address, the field is simply
 *  absent). Staff-created cases have no intake event → null. */
export interface JobClientInfo {
  name: string | null;
  phone: string | null;
  service_address: string | null;
}

function formatServiceAddress(raw: unknown): string | null {
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  if (typeof raw === "string") return str(raw);
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const formatted = str(o.formatted) ?? str(o.formatted_address);
    if (formatted) return formatted;
    const parts = [
      str(o.street) ?? str(o.address1) ?? str(o.line1) ?? str(o.address),
      str(o.city),
      str(o.state),
      str(o.zip) ?? str(o.postal_code)
    ].filter((p): p is string => p !== null);
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

export async function jobClientInfo(
  store: CaseStore,
  caseId: string
): Promise<JobClientInfo | null> {
  const events = await store.getEvents(caseId);
  const intake = [...events]
    .reverse()
    .find(e => e.event_type === "CLIENT_INTAKE_SUBMITTED");
  if (!intake) return null;
  const payload = intake.payload ?? {};
  const str = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    name: str(payload.customer_name),
    phone: str(payload.customer_phone),
    service_address: formatServiceAddress(
      payload.service_address ?? payload.serviceAddress
    )
  };
}

export interface TechJobView {
  job: Job;
  current_step: JobStep | null;
  steps: JobStepEvent[];
  case: {
    id: string;
    reference: string;
    channel: string;
    current_state: string;
    glass_type: string | null;
    vehicle: { year: number; make: string; model: string } | null;
  };
  client: JobClientInfo | null;
}

/** Everything the tech surface may show about one job — built
 *  field-by-field so no economics/internal state can ride along. */
export async function techJobView(
  store: CaseStore,
  job: Job
): Promise<TechJobView> {
  const [caseRecord, steps] = await Promise.all([
    store.getCase(job.case_id),
    store.listJobStepEvents(job.id)
  ]);
  const vehicle = caseRecord ? await store.getVehicle(caseRecord.vehicle_id) : null;
  const glassRequest = caseRecord
    ? await store.getGlassRequest(caseRecord.glass_request_id)
    : null;
  return {
    job,
    current_step: job.status === "COMPLETED" ? null : nextStep(steps),
    steps,
    case: {
      id: job.case_id,
      reference: caseRecord?.reference ?? "",
      channel: caseRecord?.channel ?? "DIRECT",
      current_state: caseRecord?.current_state ?? "",
      glass_type: glassRequest?.glass_type ?? null,
      vehicle: vehicle
        ? { year: vehicle.year, make: vehicle.make, model: vehicle.model }
        : null
    },
    client: await jobClientInfo(store, job.case_id)
  };
}

/**
 * A tech's jobs for the tech home: everything in progress, plus
 * assigned/completed jobs scheduled today or later (shop timezone).
 * Another tech's jobs are never in this list — the filter is the
 * assignment itself.
 */
export async function listTechJobs(
  store: CaseStore,
  techId: string,
  timeZone: string = operatorTimezone()
): Promise<Job[]> {
  const { startIso } = dayRangeUtc(todayKey(timeZone), timeZone);
  const jobs = await store.listJobs();
  return jobs
    .filter(j => j.assigned_tech_id === techId)
    .filter(j => {
      if (j.status === "IN_PROGRESS") return true;
      if (j.status !== "ASSIGNED" && j.status !== "COMPLETED") return false;
      if (!j.scheduled_start) return j.status === "ASSIGNED";
      return j.scheduled_start >= startIso;
    })
    .sort((a, b) =>
      (a.scheduled_start ?? "9999").localeCompare(b.scheduled_start ?? "9999")
    );
}
