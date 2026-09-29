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

/** Staff record as stored, including the password hash. Never sent to clients. */
export interface StaffUserRecord extends StaffUser {
  password_hash: string;
}

export type ApprovalTokenPurpose = "quote-approval";

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

export interface StoreShape {
  cases: CaseRecord[];
  vehicles: Vehicle[];
  glass_requests: GlassRequest[];
  events: CaseEvent[];
  idempotency: Record<string, string>;
  staff_users: StaffUserRecord[];
  approval_tokens: ApprovalTokenRecord[];
  glass_identifications: GlassIdentification[];
  vin_lookups: VinLookupRecord[];
  vin_lookup_spend: VinLookupSpendRecord[];
  supplier_offers: SupplierOffer[];
  price_calculations: PriceCalculation[];
}
