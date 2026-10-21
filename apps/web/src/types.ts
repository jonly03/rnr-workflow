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
