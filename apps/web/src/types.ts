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

/** The service address a customer picked from the geocoder's
 *  suggestions at intake — where the car will be serviced. */
export interface ServiceAddress {
  formatted: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lon: number | null;
  place_id: string | null;
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
  service_address: ServiceAddress | null;
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
  /** Payment thread of the latest invoice (staff-only). */
  invoice_events?: InvoiceEvent[];
  /** Service complete but the invoice is not paid/written off yet. */
  awaiting_payment?: boolean;
  quote: Quote | null;
  created_at: string;
  updated_at: string;
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
  /** Raw signature image for legacy drawn signatures. Staff-visible only —
   *  never rendered in the client view. Empty for typed signatures. */
  signature_data_url: string;
  /** "typed" — the typed first + last name IS the signature; "drawn" — a
   *  legacy signature-pad image. Absent on pre-typed-signature records
   *  (all drawn). */
  method?: "typed" | "drawn";
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

/** Invoice payment lifecycle (Slice D): UNSENT -> SENT -> PAID, with
 *  DISPUTED reachable from SENT/UNSENT and resolvable to paid, adjusted
 *  (re-invoiced), or written off (admin only). Paid -> case closes. */
export type InvoicePaymentStatus = "UNSENT" | "SENT" | "DISPUTED" | "PAID";

export type InvoiceDisputeResolution =
  | "RESOLVED_PAID"
  | "RESOLVED_ADJUSTED"
  | "RESOLVED_WRITTEN_OFF";

export interface Invoice {
  id: string;
  case_id: string;
  version: number;
  actuals: InvoiceActuals;
  created_at: string;
  payment_status: InvoicePaymentStatus;
  sent_at: string | null;
  sent_via: string | null;
  sent_to: string | null;
  paid_at: string | null;
  paid_method: string | null;
  paid_ref: string | null;
  paid_by: string | null;
  dispute_reason_code: string | null;
  dispute_reason: string | null;
  disputed_at: string | null;
  dispute_resolution: InvoiceDisputeResolution | null;
  dispute_resolved_at: string | null;
  /** Server-derived: whole days waiting while SENT/DISPUTED. */
  aging_days?: number | null;
  /** Server-derived: payment state lets the case close. */
  closable?: boolean;
}

export type InvoiceEventKind =
  | "SENT"
  | "DISPUTE_OPENED"
  | "DISPUTE_UPDATE"
  | "DISPUTE_RESOLVED"
  | "PAID";

/** One entry in an invoice's append-only payment thread (staff-only). */
export interface InvoiceEvent {
  id: string;
  invoice_id: string;
  case_id: string;
  kind: InvoiceEventKind;
  actor_type: string;
  actor_id: string | null;
  note: string | null;
  payload: Record<string, unknown>;
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
