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

export interface CaseRecord {
  id: string;
  reference: string;
  channel: Channel;
  current_state: string;
  customer_id: string | null;
  vehicle: Vehicle;
  glass_request: GlassRequest;
  glass_identification: GlassIdentification | null;
  supplier_offers: SupplierOffer[];
  price_calculation: PriceCalculation | null;
  created_at: string;
  updated_at: string;
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

/** Phase 4b: install tracking. One status stream drives the tech view,
 *  the dispatcher map monitor, and the client tracker. */
export type AppointmentStatus =
  | "SCHEDULED"
  | "EN_ROUTE"
  | "ARRIVED"
  | "COMPLETE";

export interface DispatchAppointment {
  id: string;
  case_id: string;
  case_ref: string;
  lat: number;
  lng: number;
  status: AppointmentStatus;
  tech: { id: string; name: string } | null;
  address: string;
  time_window: string;
  customer_name: string;
  vehicle: { year: number; make: string; model: string } | null;
  glass_type: string | null;
}

export interface DispatchDay {
  date: string;
  appointments: DispatchAppointment[];
}

export interface TrackingTimelineStep {
  stage: "confirmed" | "en_route" | "arrived" | "done";
  at: string | null;
}

/** Client-safe tracking payload: no economics, no supplier info. */
export interface TrackingInfo {
  case_ref: string;
  vehicle: { year: number; make: string; model: string } | null;
  glass_type: string | null;
  customer_name: string;
  address: string;
  time_window: string;
  tech_name: string;
  status: AppointmentStatus;
  timeline: TrackingTimelineStep[];
}

export interface TrackingLink {
  tracking_token: string;
  tracking_url: string;
  expires_at: string;
}
