import type { CaseStore } from "./store.js";
import { completedSteps, JOB_STEP_LABELS, nextStep, type JobStep } from "./job-execution.js";
import { dayRangeUtc, operatorTimezone, todayKey } from "./scheduler.js";
import type { Job, JobLocationPing } from "./types.js";

/**
 * Live tracking — Fulfillment Slice C (brief §3.4, §4).
 *
 * LOCATION LAW, enforced here server-side:
 *  - a tech's device may report position ONLY while their job is
 *    IN_PROGRESS (from the first checklist tap to FINISHED) and ONLY
 *    when their profile carries location-sharing consent. Revoking
 *    consent stops ingestion on the very next report.
 *  - Only the job's ASSIGNED tech can report for that job; anyone else
 *    gets a 404 (the tech surface never confirms a job exists for
 *    someone it doesn't belong to — same law as Slice B).
 *  - Pings are rows in job_location_pings, NEVER case events: at one
 *    report every ~45s they would flood the case log and the realtime
 *    fan-out. The ops map polls its own endpoint; the client tracker
 *    never reads coordinates at all — it receives a computed ETA
 *    summary (§3.4: summaries + ETA, no raw pin, no coordinates).
 */

export type TrackingErrorCode =
  | "JOB_NOT_FOUND"
  | "JOB_NOT_ACTIVE"
  | "LOCATION_CONSENT_REQUIRED"
  | "VALIDATION_ERROR";

export class TrackingError extends Error {
  constructor(
    readonly code: TrackingErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "TrackingError";
  }
}

/** A ping older than this is not evidence of where the tech is now. */
export const PING_FRESH_MS = 5 * 60 * 1000;

/** Assumed average urban driving speed for the ETA estimate. */
const ETA_SPEED_KMH = 30;

export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Records one position report for a job. Throws TrackingError on any
 * law violation; the route maps it to the HTTP response.
 */
export async function recordJobLocationPing(
  store: CaseStore,
  input: {
    jobId: string;
    techId: string;
    lat: unknown;
    lon: unknown;
    accuracyM?: unknown;
  }
): Promise<JobLocationPing> {
  const job = await store.getJob(input.jobId);
  if (!job || job.assigned_tech_id !== input.techId) {
    throw new TrackingError("JOB_NOT_FOUND", "Job not found.", 404);
  }
  if (!isValidCoordinate(input.lat, input.lon)) {
    throw new TrackingError(
      "VALIDATION_ERROR",
      "lat and lon must be valid coordinates.",
      422
    );
  }
  const accuracyM =
    typeof input.accuracyM === "number" &&
    Number.isFinite(input.accuracyM) &&
    input.accuracyM >= 0
      ? input.accuracyM
      : null;
  if (job.status !== "IN_PROGRESS") {
    throw new TrackingError(
      "JOB_NOT_ACTIVE",
      "Location is only shared while the job is in progress.",
      409
    );
  }
  const profile = await store.getTechProfile(input.techId);
  if (!profile?.location_sharing_consent) {
    throw new TrackingError(
      "LOCATION_CONSENT_REQUIRED",
      "Location sharing is off for this technician. Turn it on in your profile to share your position during jobs.",
      403
    );
  }
  return store.appendJobLocationPing({
    jobId: job.id,
    caseId: job.case_id,
    techId: input.techId,
    lat: input.lat as number,
    lon: input.lon as number,
    accuracyM
  });
}

// ---------------------------------------------------------------------
// Service location (where the job happens)
// ---------------------------------------------------------------------

export interface ServiceLocation {
  formatted: string | null;
  lat: number | null;
  lon: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The job's service location, read defensively from the intake event
 * (the address + coordinates are captured by the intake flow's
 * real-address picker; cases without one simply have no pin). Mirrors
 * the defensive read in job-execution.ts — never throws on odd shapes.
 */
export async function jobServiceLocation(
  store: CaseStore,
  caseId: string
): Promise<ServiceLocation | null> {
  const events = await store.getEvents(caseId);
  const intake = [...events]
    .reverse()
    .find(e => e.event_type === "CLIENT_INTAKE_SUBMITTED");
  if (!intake) return null;
  const payload = intake.payload ?? {};
  const raw = (payload.service_address ?? payload.serviceAddress) as unknown;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const formatted =
    typeof o.formatted === "string" && o.formatted.trim()
      ? o.formatted.trim()
      : typeof o.formatted_address === "string" && o.formatted_address.trim()
        ? o.formatted_address.trim()
        : null;
  const lat = num(o.lat) ?? num(o.latitude);
  const lon = num(o.lon) ?? num(o.lng) ?? num(o.longitude);
  if (!formatted && lat === null && lon === null) return null;
  return {
    formatted,
    lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
    lon: lon !== null && lon >= -180 && lon <= 180 ? lon : null
  };
}

// ---------------------------------------------------------------------
// Client ETA — an estimate, or nothing
// ---------------------------------------------------------------------

export interface ClientEta {
  /** Friendly window, e.g. "about 15–25 min". Always an estimate. */
  label: string;
  minutes_low: number;
  minutes_high: number;
}

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Straight-line distance → a friendly, honestly-rounded window. */
export function estimateEta(distanceKm: number): ClientEta {
  const minutes = (distanceKm / ETA_SPEED_KMH) * 60;
  const low = Math.max(5, Math.floor((minutes * 0.8) / 5) * 5);
  const high = Math.max(low + 5, Math.ceil((minutes * 1.25) / 5) * 5);
  return { label: `about ${low}–${high} min`, minutes_low: low, minutes_high: high };
}

/**
 * The ETA the client tracker may show for a case, or null. Shown ONLY
 * while the tech is travelling to the client — the EN_ROUTE step is
 * done and ARRIVED is not (once the tech has arrived, the tracker
 * already says so; an "ETA" to a place they're standing at would be
 * invented precision). Requires a FRESH ping and known job
 * coordinates: no signal → no ETA, never a guess.
 */
export async function clientEtaForCase(
  store: CaseStore,
  caseId: string,
  now: number = Date.now()
): Promise<ClientEta | null> {
  const job = await store.getJobByCase(caseId);
  if (!job || job.status !== "IN_PROGRESS" || !job.assigned_tech_id) return null;
  const steps = await store.listJobStepEvents(job.id);
  const done = completedSteps(steps);
  if (!done.has("EN_ROUTE") || done.has("ARRIVED")) return null;

  const location = await jobServiceLocation(store, caseId);
  if (!location || location.lat === null || location.lon === null) return null;

  const pings = await store.listJobLocationPings(job.id);
  const latest = pings[pings.length - 1];
  if (!latest) return null;
  if (now - Date.parse(latest.recorded_at) > PING_FRESH_MS) return null;

  return estimateEta(
    haversineKm(latest, { lat: location.lat, lon: location.lon })
  );
}

// ---------------------------------------------------------------------
// Staff daily ops map
// ---------------------------------------------------------------------

export interface OpsMapJob {
  job_id: string;
  case_id: string;
  reference: string;
  channel: string;
  case_state: string;
  job_status: Job["status"];
  glass_type: string | null;
  tech_id: string | null;
  tech_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  service_address: string | null;
  /** Pin coordinates for the job site — null when the case carries no
   *  geocoded address; the job still lists, it just has no pin. */
  service_lat: number | null;
  service_lon: number | null;
  /** The checklist step the tech is currently on (next uncompleted),
   *  or null when the job is finished. */
  current_step: JobStep | null;
  current_step_label: string | null;
}

export interface OpsMapTech {
  tech_id: string;
  tech_name: string | null;
  job_id: string;
  reference: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  recorded_at: string;
  /** Seconds since the latest ping, at response build time. */
  age_seconds: number;
}

export interface OpsMapView {
  date: string;
  jobs: OpsMapJob[];
  techs: OpsMapTech[];
}

/**
 * The staff bird's-eye view for one day (shop timezone): every job
 * scheduled that day — plus any job in progress right now, whenever it
 * was scheduled — each with its service pin when coordinates exist,
 * its current checklist step, and each active tech's latest position.
 * A tech with no ping yet simply has no entry in `techs`: the UI shows
 * "no signal yet" — a position is never fabricated.
 */
export async function opsMapView(
  store: CaseStore,
  dateKey: string = todayKey(),
  timeZone: string = operatorTimezone(),
  now: number = Date.now()
): Promise<OpsMapView> {
  const { startIso, endIso } = dayRangeUtc(dateKey, timeZone);
  const [jobs, cases, latestPings] = await Promise.all([
    store.listJobs(),
    store.listCases(),
    store.latestJobLocationPings()
  ]);
  const caseById = new Map(cases.map(c => [c.id, c]));
  const pingByJob = new Map(latestPings.map(p => [p.job_id, p]));

  const todays = jobs.filter(job => {
    if (job.status === "IN_PROGRESS") return true;
    if (!job.scheduled_start || !job.scheduled_end) return false;
    // ISO instants compare lexicographically — same overlap test the
    // schedule board uses.
    return job.scheduled_start < endIso && job.scheduled_end > startIso;
  });

  const jobViews: OpsMapJob[] = [];
  const techViews: OpsMapTech[] = [];
  for (const job of todays) {
    const c = caseById.get(job.case_id);
    if (!c) continue;
    const [tech, glassRequest, location, steps] = await Promise.all([
      job.assigned_tech_id ? store.getStaffById(job.assigned_tech_id) : null,
      store.getGlassRequest(c.glass_request_id),
      jobServiceLocation(store, job.case_id),
      store.listJobStepEvents(job.id)
    ]);
    const step: JobStep | null =
      job.status === "COMPLETED" ? null : nextStep(steps);
    jobViews.push({
      job_id: job.id,
      case_id: job.case_id,
      reference: c.reference,
      channel: c.channel,
      case_state: c.current_state,
      job_status: job.status,
      glass_type: glassRequest?.glass_type ?? null,
      tech_id: job.assigned_tech_id,
      tech_name: tech?.name ?? null,
      scheduled_start: job.scheduled_start,
      scheduled_end: job.scheduled_end,
      service_address: location?.formatted ?? null,
      service_lat: location?.lat ?? null,
      service_lon: location?.lon ?? null,
      current_step: step,
      current_step_label: step ? JOB_STEP_LABELS[step] : null
    });

    if (job.status === "IN_PROGRESS" && job.assigned_tech_id) {
      const ping = pingByJob.get(job.id);
      if (ping) {
        techViews.push({
          tech_id: job.assigned_tech_id,
          tech_name: tech?.name ?? null,
          job_id: job.id,
          reference: c.reference,
          lat: ping.lat,
          lon: ping.lon,
          accuracy_m: ping.accuracy_m,
          recorded_at: ping.recorded_at,
          age_seconds: Math.max(
            0,
            Math.round((now - Date.parse(ping.recorded_at)) / 1000)
          )
        });
      }
    }
  }

  jobViews.sort((a, b) =>
    (a.scheduled_start ?? "9999").localeCompare(b.scheduled_start ?? "9999")
  );
  return { date: dateKey, jobs: jobViews, techs: techViews };
}
