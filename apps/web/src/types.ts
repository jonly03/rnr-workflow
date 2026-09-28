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

export interface CaseRecord {
  id: string;
  reference: string;
  channel: Channel;
  current_state: string;
  customer_id: string | null;
  vehicle: Vehicle;
  glass_request: GlassRequest;
  glass_identification: GlassIdentification | null;
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
