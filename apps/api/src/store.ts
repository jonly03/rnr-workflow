import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CaseEvent,
  CaseRecord,
  GlassRequest,
  StaffUser,
  StaffUserRecord,
  StoreShape,
  Vehicle
} from "./types.js";

export interface CreateCaseStoreInput {
  channel: CaseRecord["channel"];
  customer_id?: string | null;
  vehicle: Omit<Vehicle, "id" | "created_at" | "updated_at">;
  glass_type: GlassRequest["glass_type"];
  idempotencyKey?: string;
  actor?: { type: string; id: string | null };
}

export interface CreateStaffUserInput {
  email: string;
  name: string;
  role: string;
  passwordHash: string;
}

export interface CaseStore {
  health(): Promise<void>;
  listCases(): Promise<CaseRecord[]>;
  getCase(id: string): Promise<CaseRecord | null>;
  getVehicle(id: string): Promise<Vehicle | null>;
  getGlassRequest(id: string): Promise<GlassRequest | null>;
  getEvents(caseId: string): Promise<CaseEvent[]>;
  createCase(input: CreateCaseStoreInput): Promise<{ caseRecord: CaseRecord; reused: boolean }>;
  findStaffByEmail(email: string): Promise<StaffUserRecord | null>;
  createStaffUser(input: CreateStaffUserInput): Promise<StaffUser>;
}

const emptyStore = (): StoreShape => ({
  cases: [],
  vehicles: [],
  glass_requests: [],
  events: [],
  idempotency: {},
  staff_users: []
});

export class JsonCaseStore implements CaseStore {
  private data: StoreShape;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  private load(): StoreShape {
    if (!fs.existsSync(this.filePath)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    // Tolerate store files written before staff_users existed.
    return { ...emptyStore(), ...parsed };
  }

  private persist(next: StoreShape) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, this.filePath);
    this.data = next;
  }

  async health() {}

  snapshot(): StoreShape {
    return structuredClone(this.data);
  }

  async listCases() {
    return [...this.data.cases].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getCase(id: string) {
    return this.data.cases.find(c => c.id === id) ?? null;
  }

  async getVehicle(id: string) {
    return this.data.vehicles.find(v => v.id === id) ?? null;
  }

  async getGlassRequest(id: string) {
    return this.data.glass_requests.find(g => g.id === id) ?? null;
  }

  async getEvents(caseId: string) {
    return this.data.events
      .filter(e => e.case_id === caseId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  private findIdempotentCase(key: string) {
    const id = this.data.idempotency[key];
    return id ? this.data.cases.find(c => c.id === id) ?? null : null;
  }

  async createCase(input: CreateCaseStoreInput) {
    if (input.idempotencyKey) {
      const existing = this.findIdempotentCase(input.idempotencyKey);
      if (existing) return { caseRecord: existing, reused: true };
    }

    const now = new Date().toISOString();
    const caseId = randomUUID();
    const vehicleId = randomUUID();
    const glassRequestId = randomUUID();
    const count = this.data.cases.length + 1;
    const reference = `RRA-${String(count).padStart(6, "0")}`;

    const vehicle: Vehicle = {
      id: vehicleId,
      ...input.vehicle,
      created_at: now,
      updated_at: now
    };

    const glassRequest: GlassRequest = {
      id: glassRequestId,
      case_id: caseId,
      glass_type: input.glass_type,
      created_at: now,
      updated_at: now
    };

    const caseRecord: CaseRecord = {
      id: caseId,
      reference,
      channel: input.channel,
      current_state: "REQUEST_RECEIVED",
      customer_id: input.customer_id ?? null,
      vehicle_id: vehicleId,
      glass_request_id: glassRequestId,
      created_at: now,
      updated_at: now,
      version: 1
    };

    const event: CaseEvent = {
      id: randomUUID(),
      case_id: caseId,
      sequence: 1,
      event_type: "CASE_CREATED",
      occurred_at: now,
      actor_type: input.actor?.type ?? "RNR_STAFF",
      actor_id: input.actor?.id ?? null,
      payload: {
        channel: input.channel,
        vehicle_id: vehicleId,
        glass_request_id: glassRequestId
      },
      corrects_event_id: null
    };

    const next = structuredClone(this.data);
    next.vehicles.push(vehicle);
    next.glass_requests.push(glassRequest);
    next.cases.push(caseRecord);
    next.events.push(event);
    if (input.idempotencyKey) next.idempotency[input.idempotencyKey] = caseId;

    this.persist(next);
    return { caseRecord, reused: false };
  }

  async findStaffByEmail(email: string): Promise<StaffUserRecord | null> {
    const normalized = email.trim().toLowerCase();
    return (
      this.data.staff_users.find(u => u.email === normalized) ?? null
    );
  }

  async createStaffUser(input: CreateStaffUserInput): Promise<StaffUser> {
    const normalized = input.email.trim().toLowerCase();
    if (await this.findStaffByEmail(normalized)) {
      throw new Error("Staff user already exists.");
    }
    const now = new Date().toISOString();
    const record: StaffUserRecord = {
      id: randomUUID(),
      email: normalized,
      name: input.name,
      role: input.role,
      password_hash: input.passwordHash,
      created_at: now
    };
    const next = structuredClone(this.data);
    next.staff_users.push(record);
    this.persist(next);
    const { password_hash: _hash, ...user } = record;
    return user;
  }
}
