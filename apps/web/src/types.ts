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
}

export interface GlassRequest {
  id: string;
  glass_type: GlassType;
}

export interface GlassCandidate {
  part_number: string;
  description: string;
  features: string[];
  position: GlassType;
  list_price_cents: number;
}

export interface GlassIdentification {
  id: string;
  case_id: string;
  glass_request_id: string;
  method: "YMM" | "VIN";
  status: "CANDIDATES_FOUND" | "AMBIGUOUS" | "RESOLVED" | "FAILED";
  provider: string;
  candidates: GlassCandidate[];
  selected_candidate: GlassCandidate | null;
  created_at: string;
}

export type SupplierType = "NATIONAL" | "REGIONAL" | "LOCAL";

export interface SupplierOffer {
  id: string;
  case_id: string;
  glass_request_id: string;
  supplier_name: string;
  supplier_type: SupplierType;
  part_number: string;
  price_cents: number;
  available: boolean;
  quantity: number;
  lead_time_days: number | null;
  excluded_reason: string | null;
  selected: boolean;
  created_at: string;
}

export type PriceStatus = "CALCULATED" | "PROFIT_REVIEW" | "APPROVED" | "REJECTED";

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

/** Staff-only projection of a client self-service intake (QR front door).
 *  Present when the customer created the case themselves; null for
 *  staff-created cases. Customer contact lives here so staff can text
 *  the quote link to the mobile the customer provided. */
export interface ClientIntake {
  source: string;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  vin_ocr_suggestion: string | null;
  photo_count: number;
  submitted_at: string;
}

export interface CaseRecord {
  id: string;
  reference: string;
  channel: Channel;
  current_state: string;
  customer_id: string | null;
  client_intake?: ClientIntake | null;
  vehicle: Vehicle;
  glass_request: GlassRequest;
  glass_identification: GlassIdentification | null;
  supplier_offers: SupplierOffer[];
  price_calculation: PriceCalculation | null;
  invoice: Invoice | null;
  quote: Quote | null;
  /** Fulfillment assignment (Slice A); null until staff open scheduling. */
  job?: JobAssignment | null;
  created_at: string;
  updated_at: string;
}

/** The case's fulfillment job (Slice A): assignment + schedule window. */
export interface JobAssignment {
  id: string;
  case_id: string;
  status: "UNASSIGNED" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";
  assignment_mode: "DIRECT" | "OFFERED";
  assigned_tech_id: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  calendar_event_id: string | null;
  tech_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Checklist steps a tech works through on a job (Slice B). The API
 *  enforces this exact order server-side. */
export const JOB_STEPS = [
  { step: "PICKUP", label: "Go pick up the order", action: "Start pickup" },
  { step: "PICKED_UP", label: "Order picked up", action: "Mark picked up" },
  { step: "EN_ROUTE", label: "Head to the client", action: "Start driving" },
  { step: "ARRIVED", label: "Arrived at the client", action: "Mark arrived" },
  { step: "CHECKED_IN", label: "Check in with the client", action: "Check in" },
  { step: "BEFORE_PHOTOS", label: "Before photos", action: "Photos uploaded" },
  { step: "PREP_STARTED", label: "Prep", action: "Start prep" },
  { step: "PREP_DONE", label: "Prep done", action: "Prep done" },
  { step: "INSTALL_STARTED", label: "Install (remove, clean, install)", action: "Start install" },
  { step: "INSTALL_DONE", label: "Install done", action: "Install done" },
  { step: "AFTER_PHOTOS", label: "After photos", action: "Photos uploaded" },
  { step: "CLIENT_CHECKIN", label: "Client check-in", action: "Record check-in" },
  { step: "FINISHED", label: "Finished", action: "Finish job" }
] as const;

export type JobStep = (typeof JOB_STEPS)[number]["step"];

export interface JobStepEvent {
  id: string;
  job_id: string;
  case_id: string;
  step: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export type AssetKind =
  | "INTAKE_PHOTO"
  | "BEFORE_PHOTO"
  | "AFTER_PHOTO"
  | "INVOICE_PDF"
  | "SIGNED_QUOTE"
  | "OTHER";

export type AssetVisibility = "CLIENT_VISIBLE" | "TECH_VISIBLE" | "INTERNAL";

/** A file on a case (Slice B asset registry) as the API projects it —
 *  the storage key never leaves the server. */
export interface CaseAsset {
  id: string;
  case_id: string;
  job_id: string | null;
  kind: AssetKind;
  visibility: AssetVisibility;
  storage_driver: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: "PENDING" | "READY";
  uploaded_by_type: string;
  uploaded_by_id: string | null;
  created_at: string;
  has_bytes: boolean;
}

/** The tech's view of one assigned job (Slice B): job + checklist +
 *  the operational facts of the case. No economics, ever. */
export interface TechJob {
  job: Omit<JobAssignment, "tech_name">;
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
  client: {
    name: string | null;
    phone: string | null;
    service_address: string | null;
  } | null;
  assets: CaseAsset[];
}

/** Staff view of a case's job execution (Slice B). */
export interface CaseJobView {
  job: (JobAssignment & { tech_name: string | null }) | null;
  steps: JobStepEvent[];
  current_step: JobStep | null;
  assets: CaseAsset[];
}

export type OperatorStatus = "INVITED" | "PROFILE_PENDING" | "ACTIVE" | "DEACTIVATED";

export interface AvailabilityWindow {
  day_of_week: number;
  start: string;
  end: string;
}

/** Tech profile as staff may see it (no credential material, ever). */
export interface TechProfile {
  user_id: string;
  status: Exclude<OperatorStatus, "INVITED">;
  phone: string | null;
  home_base: string | null;
  service_area: string | null;
  claimed_qualifications: string[];
  qualifications: string[];
  availability: AvailabilityWindow[];
  live_status: "AVAILABLE" | "OFF";
  location_sharing_consent: boolean;
  google_sub: string | null;
  created_at: string;
  updated_at: string;
}

export interface Operator {
  id: string;
  email: string;
  name: string;
  role: string;
  status: OperatorStatus;
  profile: TechProfile | null;
  created_at: string;
}

export interface OperatorInviteView {
  id: string;
  email: string;
  status: "INVITED";
  expires_at: string;
  created_at: string;
}

export interface SchedulerCandidate {
  tech_id: string;
  name: string;
  email: string;
  free_at: string | null;
  jobs_that_day: number;
  qualifications: string[];
}

export interface SchedulerProposal {
  requirement: {
    glass_type: GlassType;
    requires_adas: boolean;
    service_mode: "MOBILE" | "IN_SHOP" | null;
    required_tags: string[];
  };
  window: { start: string; end: string };
  eligible: SchedulerCandidate[];
  excluded: { tech_id: string; name: string; email: string; reasons: string[] }[];
}

export interface ScheduleBoardEntry {
  job: JobAssignment | null;
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

export type QuoteStatus = "SENT" | "APPROVED" | "DECLINED" | "EXPIRED";

/** Immutable snapshot captured at quote generation (integer cents). */
export interface QuoteSnapshot {
  vehicle: { year: number; make: string; model: string; vin: string };
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

export interface QuoteSignature {
  name: string;
  signed_at: string;
  attribution: string;
  signature_hash: string;
  /** Raw signature image. Staff-visible only — never rendered in the client view. */
  signature_data_url: string;
}

export interface Quote {
  id: string;
  case_id: string;
  version: number;
  snapshot: QuoteSnapshot;
  expires_at: string;
  status: QuoteStatus;
  signature: QuoteSignature | null;
  created_at: string;
}

/** Line items copied from the signed quote's snapshot (integer cents).
 *  `quote_id`/`quote_version` record which quote authorized the invoice. */
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

export interface Invoice {
  id: string;
  case_id: string;
  version: number;
  actuals: InvoiceActuals;
  created_at: string;
}

export interface CaseEvent {
  id: string;
  case_id: string;
  sequence: number;
  event_type: string;
  occurred_at: string;
  actor_type: string;
  payload: Record<string, unknown>;
}
