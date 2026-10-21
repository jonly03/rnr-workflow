export type Channel = "DIRECT" | "AUCTION" | "INSURANCE";
export type GlassType =
  | "WINDSHIELD"
  | "BACK_GLASS"
  | "DOOR_GLASS"
  | "QUARTER_GLASS"
  | "VENT_GLASS";

export interface Vehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  vin: string;
  created_at: string;
  updated_at: string;
}

export interface GlassRequest {
  id: string;
  case_id: string;
  glass_type: GlassType;
  created_at: string;
  updated_at: string;
}

export interface CaseRecord {
  id: string;
  reference: string;
  channel: Channel;
  current_state: string;
  customer_id: string | null;
  vehicle_id: string;
  glass_request_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface CaseEvent {
  id: string;
  case_id: string;
  sequence: number;
  event_type: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  corrects_event_id: string | null;
}

/**
 * Lightweight projection of a CaseEvent broadcast to staff realtime
 * subscribers the moment the event is appended. Deliberately carries no
 * payload: subscribers refetch through the normal authenticated API, so
 * nothing beyond "this case changed" ever travels over the socket.
 */
export interface CaseEventNotification {
  case_id: string;
  event_type: string;
  occurred_at: string;
  sequence: number;
}

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
  /**
   * Channels this staff member may access. Absent/undefined means all
   * channels (full-access staff/admin). Enforced backend-side on case routes.
   */
  channels?: Channel[];
}

/** Staff record as stored, including the password hash. Never sent to clients.
 *  The hash is null for Google-only accounts (techs onboarded via Google
 *  Sign-In hold no local password; password login rejects null hashes). */
export interface StaffUserRecord extends StaffUser {
  password_hash: string | null;
}

export type ApprovalTokenPurpose = "quote-approval" | "case-view" | "intake-status";

/**
 * Opaque single-use token granting an external party scoped access to one
 * case for one purpose (e.g. approving a quote). Only the sha256 hash is
 * stored; the token itself is shown once at mint time.
 */
export interface ApprovalTokenRecord {
  jti: string;
  case_id: string;
  channel: Channel;
  purpose: ApprovalTokenPurpose;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

/** One glass part candidate returned by a catalog provider. */
export interface GlassCandidate {
  part_number: string;
  description: string;
  /** Option/feature codes that distinguish candidates, e.g. "rain-sensor". */
  features: string[];
  position: GlassType;
  list_price_cents: number;
}

export type IdentificationMethod = "YMM" | "VIN";
export type IdentificationStatus =
  | "CANDIDATES_FOUND"
  | "AMBIGUOUS"
  | "RESOLVED"
  | "FAILED";

/** One persisted identification run for a glass request. Latest wins. */
export interface GlassIdentification {
  id: string;
  case_id: string;
  glass_request_id: string;
  method: IdentificationMethod;
  status: IdentificationStatus;
  provider: string;
  candidates: GlassCandidate[];
  selected_candidate: GlassCandidate | null;
  /**
   * Interchangeable part numbers for the selected candidate (VIN method).
   * Sourcing prices the primary plus every interchange and picks the
   * cheapest in-stock offer — interchanges are often cheaper than the
   * primary, sometimes pricier (MOPAR/OEM).
   */
  interchange_part_numbers: string[];
  created_at: string;
}

/**
 * Cached VIN lookup result. One row per VIN; `result` holds per-glass-type
 * results so each glass type reuses its own successful lookup instead of
 * being repurchased — and never reuses another glass type's candidates.
 * Failed lookups are retried (repurchased) on the next request.
 */
export interface VinLookupRecord {
  id: string;
  vin: string;
  success: boolean;
  result: Record<string, unknown>;
  created_at: string;
}

/**
 * One recorded VIN-lookup charge. The shop pays per VIN lookup on live
 * providers (MyGrant: $1); YMM and part-number searches are free and are
 * never recorded here. Written when a paid lookup is submitted (or when a
 * failure happens after submission, where the charge is uncertain but
 * possible) so the daily spend cap is conservative with real money.
 */
export interface VinLookupSpendRecord {
  id: string;
  vin: string;
  glass_type: GlassType;
  cost_cents: number;
  provider: string;
  spent_at: string;
}

export type SupplierType = "NATIONAL" | "REGIONAL" | "LOCAL";

/** One supplier offer for an identified glass part. Regional suppliers and
 *  unavailable stock are excluded from auto-selection (see excluded_reason). */
export interface SupplierOffer {
  id: string;
  case_id: string;
  glass_request_id: string;
  supplier_name: string;
  supplier_type: SupplierType;
  part_number: string;
  /** What R&R pays the supplier, in cents. */
  price_cents: number;
  available: boolean;
  quantity: number;
  lead_time_days: number | null;
  /** Why this offer was excluded from auto-selection; null if eligible. */
  excluded_reason: string | null;
  selected: boolean;
  /**
   * True when this offer is for an interchangeable part number rather
   * than the primary identified part. The full set stays visible so
   * staff can override the system pick when a job needs the OEM part.
   */
  is_interchange: boolean;
  created_at: string;
}

export type PriceStatus = "CALCULATED" | "PROFIT_REVIEW" | "APPROVED" | "REJECTED";

/** A persisted pricing snapshot. The sell price is reproducible from the
 *  stored inputs + pricing_config; snapshots are never mutated. */
export interface PriceCalculation {
  id: string;
  case_id: string;
  glass_request_id: string;
  selected_offer_id: string | null;
  glass_cost_cents: number;
  labor_cents: number;
  profit_cents: number;
  tax_cents: number;
  sell_price_cents: number;
  pricing_config: Record<string, unknown>;
  status: PriceStatus;
  created_at: string;
}

/**
 * Operator (tech) onboarding lifecycle (brief §7.1):
 * INVITED (an invite row exists, no account yet) → PROFILE_PENDING
 * (Google sign-in matched the invite; profile submitted, awaiting staff
 * verification) → ACTIVE ⇄ DEACTIVATED. Only ACTIVE techs can sign in
 * and be assigned work.
 */
export type OperatorStatus =
  | "INVITED"
  | "PROFILE_PENDING"
  | "ACTIVE"
  | "DEACTIVATED";

/**
 * Qualification tags a tech can hold. Glass types reuse the GlassType
 * codes; the rest are capability tags. A job's requirement is a set of
 * these tags and a tech is qualified when they hold every required tag.
 */
export const QUALIFICATION_TAGS: readonly string[] = [
  "WINDSHIELD",
  "BACK_GLASS",
  "DOOR_GLASS",
  "QUARTER_GLASS",
  "VENT_GLASS",
  "ADAS_CALIBRATION",
  "MOBILE",
  "IN_SHOP"
];

/** One recurring weekly availability window. Times are "HH:MM" in the
 *  shop timezone (OPERATOR_TIMEZONE, default America/New_York). */
export interface AvailabilityWindow {
  /** 0 = Sunday … 6 = Saturday. */
  day_of_week: number;
  start: string;
  end: string;
}

/** Tech-side profile keyed to a staff_users row with role "tech". */
export interface TechProfile {
  user_id: string;
  status: Exclude<OperatorStatus, "INVITED">;
  phone: string | null;
  home_base: string | null;
  service_area: string | null;
  /** Qualifications the tech claimed at profile completion. */
  claimed_qualifications: string[];
  /** Qualifications staff verified. This is what the scheduler reads. */
  qualifications: string[];
  availability: AvailabilityWindow[];
  /** Live availability: OFF excludes the tech from scheduler proposals. */
  live_status: "AVAILABLE" | "OFF";
  /** Consent to share location while a job is active (Slice C enforces). */
  location_sharing_consent: boolean;
  /** Google account subject id, bound at Google sign-in. */
  google_sub: string | null;
  /**
   * Google OAuth refresh credential for calendar writes (Slice A §7.1).
   * Server-side only — never serialized into any API response.
   */
  google_refresh_credential: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * An invitation for a tech to onboard, addressed to a Gmail account.
 * Only the sha256 hash of the invite credential is stored; the raw
 * credential is shown once, inside the invite link staff send.
 */
export interface OperatorInvite {
  id: string;
  email: string;
  credential_hash: string;
  invited_by: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

/** How a job gets its tech. DIRECT = staff-confirmed assignment (v1).
 *  OFFERED is the later bid/pickup marketplace — designed-for, not built. */
export type AssignmentMode = "DIRECT" | "OFFERED";

export type JobStatus = "UNASSIGNED" | "ASSIGNED";

/**
 * The assignment record for a case's fulfillment work (1 job per case in
 * v1). Granular tech checklist steps land on this entity in Slice B; for
 * Slice A it carries the schedule window + the assigned tech.
 */
export interface Job {
  id: string;
  case_id: string;
  status: JobStatus;
  assignment_mode: AssignmentMode;
  assigned_tech_id: string | null;
  /** ISO instants for the scheduled work window. Null until scheduled. */
  scheduled_start: string | null;
  scheduled_end: string | null;
  /** Google Calendar event id once the calendar surface has written it. */
  calendar_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreShape {
  cases: CaseRecord[];
  vehicles: Vehicle[];
  glass_requests: GlassRequest[];
  events: CaseEvent[];
  idempotency: Record<string, string>;
  staff_users: StaffUserRecord[];
  tech_profiles: TechProfile[];
  operator_invites: OperatorInvite[];
  jobs: Job[];
  approval_tokens: ApprovalTokenRecord[];
  glass_identifications: GlassIdentification[];
  vin_lookups: VinLookupRecord[];
  vin_lookup_spend: VinLookupSpendRecord[];
  supplier_offers: SupplierOffer[];
  price_calculations: PriceCalculation[];
  quotes: Quote[];
  invoices: Invoice[];
}

/** Quote lifecycle: sent (awaiting signature) -> approved (signed) by the
 *  client, or declined / expired (staff can requote: new version). */
export type QuoteStatus = "SENT" | "APPROVED" | "DECLINED" | "EXPIRED" | "SUPERSEDED";

/** Immutable snapshot captured at quote generation: vehicle + glass +
 *  economics. All money is integer cents. */
export interface QuoteSnapshot {
  vehicle: {
    year: number;
    make: string;
    model: string;
    vin: string;
  };
  glass_type: string;
  part_number: string | null;
  supplier_name: string | null;
  glass_cost_cents: number;
  labor_cents: number;
  profit_cents: number;
  tax_cents: number;
  sell_price_cents: number;
  price_calculation_id: string;
}

/** The client's ESIGN-style signature record on a quote (signature =
 *  approval). The raw signature image (data URL) is stored alongside,
 *  staff-visible only; clients and API consumers see the hash, name,
 *  and timestamp. */
export interface QuoteSignature {
  name: string;
  signed_at: string;
  attribution: string;
  signature_hash: string;
  signature_data_url: string;
}

/** A persisted quote. Versions are append-only: a requote supersedes by
 *  creating a new version; history is never mutated. A signed quote never
 *  expires; an unsigned quote past expires_at cannot be signed. */
export interface Quote {
  id: string;
  case_id: string;
  version: number;
  snapshot: QuoteSnapshot;
  /** ISO timestamp after which the quote can no longer be signed. */
  expires_at: string;
  status: QuoteStatus;
  signature: QuoteSignature | null;
  created_at: string;
}

/** Line items copied from the signed quote's snapshot at invoice time.
 *  All money is integer cents. `quote_id`/`quote_version` record exactly
 *  which quote authorized this invoice. */
export interface InvoiceActuals {
  glass_cost_cents: number;
  labor_cents: number;
  profit_cents: number;
  tax_cents: number;
  sell_price_cents: number;
  price_calculation_id: string;
  quote_id: string;
  quote_version: number;
  source: string;
}

/** A persisted invoice, generated off a client-signed quote. Versions are
 *  append-only: re-invoicing creates a new version; history is never
 *  mutated. There is no invoice signature — the signed quote is the
 *  authorization. */
export interface Invoice {
  id: string;
  case_id: string;
  version: number;
  actuals: InvoiceActuals;
  created_at: string;
}
