import type { CaseStore } from "./store.js";
import type { CalendarProvider } from "./google-calendar.js";
import { loadTech } from "./operators.js";
import type {
  GlassIdentification,
  GlassType,
  Job,
  StaffUser,
  TechProfile
} from "./types.js";

/**
 * Scheduler v1 + assignment — Fulfillment Slice A (brief §3.2, §4).
 *
 * The scheduler is a query + ranking over OUR data (never Google
 * Calendar — brief §7.1): filter ACTIVE techs by qualification tags,
 * availability window, live status, and overlapping jobs; rank by
 * earliest-free, then fewest jobs that day. The scheduler PROPOSES;
 * staff confirm, override (with a recorded reason), or reassign.
 *
 * Assignment is an event + a job row, not a field baked into the case —
 * so the later bid marketplace (assignment_mode OFFERED) can slot in
 * without reshaping this (brief §3.7). v1 does not build offers.
 */

export type SchedulerErrorCode =
  | "CASE_NOT_FOUND"
  | "INVALID_STATE"
  | "TECH_NOT_ACTIVE"
  | "OVERRIDE_REASON_REQUIRED"
  | "VALIDATION_ERROR";

export class SchedulerError extends Error {
  constructor(
    readonly code: SchedulerErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

/** Shop timezone for availability windows + the schedule board. */
export function operatorTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPERATOR_TIMEZONE?.trim() || "America/New_York";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    dayOfWeek: WEEKDAYS.indexOf(get("weekday"))
  };
}

/** Minutes since local midnight for an instant, in the shop timezone. */
function localMinutes(iso: string, timeZone: string): { dayOfWeek: number; minutes: number } {
  const p = zonedParts(new Date(iso), timeZone);
  return { dayOfWeek: p.dayOfWeek, minutes: p.hour * 60 + p.minute };
}

function localDateKey(iso: string, timeZone: string): string {
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Today's local date key (YYYY-MM-DD) in the shop timezone. */
export function todayKey(timeZone: string = operatorTimezone()): string {
  return localDateKey(new Date().toISOString(), timeZone);
}

/** UTC instants bounding a local calendar date (YYYY-MM-DD) in `timeZone`. */
export function dayRangeUtc(
  dateKey: string,
  timeZone: string
): { startIso: string; endIso: string } {
  const [y, m, d] = dateKey.split("-").map(Number);
  const midnightUtc = (yy: number, mm: number, dd: number): number => {
    const target = Date.UTC(yy, mm - 1, dd, 0, 0, 0);
    let t = target;
    for (let i = 0; i < 3; i++) {
      const p = zonedParts(new Date(t), timeZone);
      const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      t += target - wallAsUtc;
    }
    return t;
  };
  const start = midnightUtc(y, m, d);
  const next = new Date(Date.UTC(y, m - 1, d) + 24 * 3600 * 1000);
  const end = midnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

function windowMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** True when [startIso, endIso) sits inside one of the tech's windows for that weekday. */
export function withinAvailability(
  profile: TechProfile,
  startIso: string,
  endIso: string,
  timeZone: string
): boolean {
  const start = localMinutes(startIso, timeZone);
  const end = localMinutes(endIso, timeZone);
  // An end exactly at local midnight belongs to the start's day (1440);
  // anything else at or before the start spans past the day and cannot
  // fit a single weekly window.
  const endMinutes =
    end.minutes === 0 && end.dayOfWeek !== start.dayOfWeek ? 1440 : end.minutes;
  if (endMinutes <= start.minutes) return false;
  return profile.availability.some(
    w =>
      w.day_of_week === start.dayOfWeek &&
      windowMinutes(w.start) <= start.minutes &&
      endMinutes <= windowMinutes(w.end)
  );
}

// --- Job requirements ---

export interface JobRequirement {
  glass_type: GlassType;
  requires_adas: boolean;
  /** MOBILE / IN_SHOP tag the job needs; null when either works. */
  service_mode: "MOBILE" | "IN_SHOP" | null;
  required_tags: string[];
}

/**
 * Derives what a job needs from the case itself (brief §3.2: no new
 * staff data entry in the common path). ADAS is required when the
 * identified glass candidate carries ADAS / calibration features —
 * those windshields need a calibration-qualified tech.
 */
export function deriveRequirement(
  glassType: GlassType,
  identification: GlassIdentification | null
): JobRequirement {
  const features = identification?.selected_candidate?.features ?? [];
  const requires_adas = features.some(f => /adas|calibrat/i.test(f));
  const required_tags = [glassType, ...(requires_adas ? ["ADAS_CALIBRATION"] : [])];
  return { glass_type: glassType, requires_adas, service_mode: null, required_tags };
}

export function missingTags(profile: TechProfile, requirement: JobRequirement): string[] {
  const held = new Set(profile.qualifications);
  const missing = requirement.required_tags.filter(t => !held.has(t));
  if (requirement.service_mode && !held.has(requirement.service_mode)) {
    missing.push(requirement.service_mode);
  }
  return missing;
}

// --- Proposals ---

export interface SchedulerCandidate {
  tech_id: string;
  name: string;
  email: string;
  /** When the tech last becomes free before the job (null = free all day so far). */
  free_at: string | null;
  jobs_that_day: number;
  qualifications: string[];
}

export interface ExcludedTech {
  tech_id: string;
  name: string;
  email: string;
  reasons: string[];
}

export interface ProposalResult {
  requirement: JobRequirement;
  window: { start: string; end: string };
  eligible: SchedulerCandidate[];
  excluded: ExcludedTech[];
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export async function proposeAssignments(
  store: CaseStore,
  input: {
    requirement: JobRequirement;
    startIso: string;
    endIso: string;
    /** The case being scheduled: its own job never counts as a conflict. */
    excludeCaseId: string;
    timeZone?: string;
  }
): Promise<ProposalResult> {
  const timeZone = input.timeZone ?? operatorTimezone();
  const [users, profiles, jobs] = await Promise.all([
    store.listStaffUsers(),
    store.listTechProfiles(),
    store.listJobs()
  ]);
  const profileByUser = new Map(profiles.map(p => [p.user_id, p]));
  const dayKey = localDateKey(input.startIso, timeZone);

  const eligible: SchedulerCandidate[] = [];
  const excluded: ExcludedTech[] = [];

  for (const record of users) {
    if (record.role !== "tech") continue;
    const profile = profileByUser.get(record.id);
    const techJobs = jobs.filter(
      j => j.assigned_tech_id === record.id && j.status === "ASSIGNED" && j.case_id !== input.excludeCaseId
    );
    const base = { tech_id: record.id, name: record.name, email: record.email };
    if (!profile || profile.status !== "ACTIVE") {
      excluded.push({ ...base, reasons: ["not an active tech"] });
      continue;
    }
    const reasons: string[] = [];
    const missing = missingTags(profile, input.requirement);
    if (missing.length) reasons.push(`missing qualification: ${missing.join(", ")}`);
    if (profile.live_status === "OFF") reasons.push("marked off / unavailable");
    if (
      profile.availability.length > 0 &&
      !withinAvailability(profile, input.startIso, input.endIso, timeZone)
    ) {
      reasons.push("outside availability window");
    }
    const conflict = techJobs.find(
      j =>
        j.scheduled_start &&
        j.scheduled_end &&
        overlaps(input.startIso, input.endIso, j.scheduled_start, j.scheduled_end)
    );
    if (conflict) reasons.push("has an overlapping assigned job");
    if (reasons.length) {
      excluded.push({ ...base, reasons });
      continue;
    }
    const dayJobs = techJobs.filter(
      j => j.scheduled_start && localDateKey(j.scheduled_start, timeZone) === dayKey
    );
    const priorEnds = dayJobs
      .map(j => j.scheduled_end)
      .filter((end): end is string => end !== null && end <= input.startIso)
      .sort();
    eligible.push({
      ...base,
      free_at: priorEnds.length ? priorEnds[priorEnds.length - 1] : null,
      jobs_that_day: dayJobs.length,
      qualifications: profile.qualifications
    });
  }

  // Rank: earliest free first (free all day beats any prior job), then
  // fewest jobs that day, then name for a stable, testable order.
  eligible.sort((a, b) => {
    const freeA = a.free_at ? Date.parse(a.free_at) : Number.NEGATIVE_INFINITY;
    const freeB = b.free_at ? Date.parse(b.free_at) : Number.NEGATIVE_INFINITY;
    if (freeA !== freeB) return freeA - freeB;
    if (a.jobs_that_day !== b.jobs_that_day) return a.jobs_that_day - b.jobs_that_day;
    return a.name.localeCompare(b.name);
  });

  return {
    requirement: input.requirement,
    window: { start: input.startIso, end: input.endIso },
    eligible,
    excluded
  };
}

// --- Jobs + assignment ---

/** Gets the case's job, creating the (single, v1) job row on first use. */
export async function ensureJob(store: CaseStore, caseId: string): Promise<Job> {
  const existing = await store.getJobByCase(caseId);
  if (existing) return existing;
  try {
    return await store.createJob({ caseId });
  } catch {
    // A concurrent ensure raced us; the row exists now.
    const raced = await store.getJobByCase(caseId);
    if (raced) return raced;
    throw new Error("Job could not be created for this case.");
  }
}

const ASSIGNABLE_STATES = ["PARTS_ORDERED", "INSTALLATION_SCHEDULED"];
const REASSIGNABLE_STATES = ["PARTS_ORDERED", "INSTALLATION_SCHEDULED", "TECH_DISPATCHED"];

export interface AssignInput {
  techId: string;
  startIso: string;
  endIso: string;
  overrideReason?: string | null;
  actor: { type: string; id: string | null };
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

async function writeCalendarEvent(
  store: CaseStore,
  calendar: CalendarProvider,
  job: Job,
  techProfile: TechProfile,
  summary: string,
  description: string
): Promise<void> {
  // Calendar is a surface, never a gate: any failure is logged inside
  // the provider and the assignment stands without an event id.
  try {
    const tech = await store.getStaffById(job.assigned_tech_id ?? "");
    const eventId = await calendar.createJobEvent({
      techId: job.assigned_tech_id ?? "",
      techEmail: tech?.email ?? "",
      refreshCredential: techProfile.google_refresh_credential,
      summary,
      description,
      location: null,
      startIso: job.scheduled_start ?? "",
      endIso: job.scheduled_end ?? ""
    });
    if (eventId) {
      await store.updateJob(job.id, { calendar_event_id: eventId });
    }
  } catch (error) {
    console.error(`calendar write failed for job ${job.id}:`, error);
  }
}

async function removeCalendarEvent(
  store: CaseStore,
  calendar: CalendarProvider,
  job: Job
): Promise<void> {
  if (!job.calendar_event_id || !job.assigned_tech_id) return;
  try {
    const profile = await store.getTechProfile(job.assigned_tech_id);
    await calendar.deleteJobEvent({
      techId: job.assigned_tech_id,
      refreshCredential: profile?.google_refresh_credential ?? null,
      eventId: job.calendar_event_id
    });
  } catch (error) {
    console.error(`calendar delete failed for job ${job.id}:`, error);
  }
}

async function assign(
  store: CaseStore,
  calendar: CalendarProvider,
  caseId: string,
  input: AssignInput,
  mode: "assign" | "reassign"
): Promise<Job> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) {
    throw new SchedulerError("CASE_NOT_FOUND", "Case not found.", 404);
  }
  const allowed = mode === "assign" ? ASSIGNABLE_STATES : REASSIGNABLE_STATES;
  if (!allowed.includes(caseRecord.current_state)) {
    throw new SchedulerError(
      "INVALID_STATE",
      `A tech can only be ${mode === "assign" ? "assigned" : "reassigned"} once parts are ordered (current state: ${caseRecord.current_state}).`,
      409
    );
  }
  if (Date.parse(input.endIso) <= Date.parse(input.startIso)) {
    throw new SchedulerError(
      "VALIDATION_ERROR",
      "The job window must end after it starts.",
      422
    );
  }
  const { user: tech, profile: techProfile } = await loadTech(store, input.techId).catch(
    () => {
      throw new SchedulerError("TECH_NOT_ACTIVE", "That tech does not exist.", 404);
    }
  );
  if (techProfile.status !== "ACTIVE") {
    throw new SchedulerError(
      "TECH_NOT_ACTIVE",
      "Only an active tech can be assigned work.",
      409
    );
  }

  const job = await ensureJob(store, caseId);
  if (mode === "assign" && job.status === "ASSIGNED") {
    throw new SchedulerError(
      "INVALID_STATE",
      "This job already has a tech. Use reassign to change it.",
      409
    );
  }
  if (mode === "reassign" && job.status !== "ASSIGNED") {
    throw new SchedulerError(
      "INVALID_STATE",
      "This job has no tech yet. Use assign first.",
      409
    );
  }

  // Eligibility gate: assigning outside the scheduler's eligible set is
  // an override and must carry a reason (brief §3.2: override + reason
  // logged as an event).
  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  const identification = glassRequest
    ? await store.getLatestGlassIdentification(glassRequest.id)
    : null;
  const requirement = deriveRequirement(
    glassRequest?.glass_type ?? "WINDSHIELD",
    identification
  );
  const proposals = await proposeAssignments(store, {
    requirement,
    startIso: input.startIso,
    endIso: input.endIso,
    excludeCaseId: caseId
  });
  const isEligible = proposals.eligible.some(c => c.tech_id === input.techId);
  const overrideReason = input.overrideReason?.trim() || null;
  if (!isEligible && !overrideReason) {
    const excluded = proposals.excluded.find(e => e.tech_id === input.techId);
    const why = excluded?.reasons.join("; ") || "not eligible for this window";
    throw new SchedulerError(
      "OVERRIDE_REASON_REQUIRED",
      `This tech is not scheduler-eligible for this job (${why}). Provide an override reason to assign anyway.`,
      422
    );
  }

  const previousTechId = job.assigned_tech_id;
  if (mode === "reassign") {
    await removeCalendarEvent(store, calendar, job);
  }

  const updated = await store.updateJob(job.id, {
    status: "ASSIGNED",
    assigned_tech_id: input.techId,
    scheduled_start: input.startIso,
    scheduled_end: input.endIso,
    calendar_event_id: null
  });

  await store.appendEvent({
    caseId,
    eventType: mode === "assign" ? "TECH_ASSIGNED" : "TECH_REASSIGNED",
    actor: input.actor,
    nextState:
      caseRecord.current_state === "PARTS_ORDERED"
        ? "INSTALLATION_SCHEDULED"
        : undefined,
    payload: {
      tech_id: input.techId,
      technician_name: firstName(tech.name),
      scheduled_at: input.startIso,
      assignment_mode: updated.assignment_mode,
      ...(overrideReason ? { override_reason: overrideReason } : {}),
      ...(mode === "reassign" && previousTechId
        ? { previous_tech_id: previousTechId }
        : {})
    }
  });

  const fresh = (await store.getJob(job.id)) ?? updated;
  await writeCalendarEvent(
    store,
    calendar,
    fresh,
    techProfile,
    `R&R job ${caseRecord.reference} — ${humanizeGlass(requirement.glass_type)}`,
    `Case ${caseRecord.reference}. Open Case Core for the job details.`
  );
  return (await store.getJob(job.id)) ?? fresh;
}

function humanizeGlass(glassType: GlassType): string {
  return glassType
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/(^|\s)\S/g, c => c.toUpperCase());
}

export function assignJob(
  store: CaseStore,
  calendar: CalendarProvider,
  caseId: string,
  input: AssignInput
): Promise<Job> {
  return assign(store, calendar, caseId, input, "assign");
}

export function reassignJob(
  store: CaseStore,
  calendar: CalendarProvider,
  caseId: string,
  input: AssignInput
): Promise<Job> {
  return assign(store, calendar, caseId, input, "reassign");
}

// --- Schedule board ---

export interface ScheduleBoardEntry {
  job: Job | null;
  case_id: string;
  reference: string;
  channel: string;
  current_state: string;
  glass_type: GlassType | null;
  tech_id: string | null;
  tech_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
}

/**
 * The staff schedule board for one local date: every job scheduled that
 * day, plus jobs with a window elsewhere are excluded; cases ready for
 * assignment but not yet scheduled appear as unscheduled entries so
 * staff can pick them up from the board.
 */
export async function scheduleBoard(
  store: CaseStore,
  dateKey: string,
  timeZone: string = operatorTimezone()
): Promise<{ date: string; entries: ScheduleBoardEntry[] }> {
  const { startIso, endIso } = dayRangeUtc(dateKey, timeZone);
  const [jobs, cases] = await Promise.all([store.listJobs(), store.listCases()]);
  const caseById = new Map(cases.map(c => [c.id, c]));
  const entries: ScheduleBoardEntry[] = [];
  const coveredCaseIds = new Set<string>();

  for (const job of jobs) {
    const c = caseById.get(job.case_id);
    if (!c) continue;
    coveredCaseIds.add(job.case_id);
    if (
      !job.scheduled_start ||
      !job.scheduled_end ||
      !overlaps(startIso, endIso, job.scheduled_start, job.scheduled_end)
    ) {
      continue;
    }
    const tech = job.assigned_tech_id
      ? await store.getStaffById(job.assigned_tech_id)
      : null;
    const glassRequest = await store.getGlassRequest(c.glass_request_id);
    entries.push({
      job,
      case_id: c.id,
      reference: c.reference,
      channel: c.channel,
      current_state: c.current_state,
      glass_type: glassRequest?.glass_type ?? null,
      tech_id: job.assigned_tech_id,
      tech_name: tech?.name ?? null,
      scheduled_start: job.scheduled_start,
      scheduled_end: job.scheduled_end
    });
  }

  // Ready-to-assign cases with no scheduled job yet: surface them so the
  // board doubles as the assignment worklist for the day.
  for (const c of cases) {
    if (coveredCaseIds.has(c.id)) continue;
    if (!ASSIGNABLE_STATES.includes(c.current_state)) continue;
    const glassRequest = await store.getGlassRequest(c.glass_request_id);
    entries.push({
      job: null,
      case_id: c.id,
      reference: c.reference,
      channel: c.channel,
      current_state: c.current_state,
      glass_type: glassRequest?.glass_type ?? null,
      tech_id: null,
      tech_name: null,
      scheduled_start: null,
      scheduled_end: null
    });
  }

  entries.sort((a, b) =>
    (a.scheduled_start ?? "9999").localeCompare(b.scheduled_start ?? "9999")
  );
  return { date: dateKey, entries };
}
