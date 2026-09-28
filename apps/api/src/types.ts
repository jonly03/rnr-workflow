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
}

/** Staff record as stored, including the password hash. Never sent to clients. */
export interface StaffUserRecord extends StaffUser {
  password_hash: string;
}

export interface StoreShape {
  cases: CaseRecord[];
  vehicles: Vehicle[];
  glass_requests: GlassRequest[];
  events: CaseEvent[];
  idempotency: Record<string, string>;
  staff_users: StaffUserRecord[];
}
