import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CaseEvent, CaseRecord, GlassRequest, StoreShape, Vehicle } from "./types.js";

const emptyStore = (): StoreShape => ({
  cases: [],
  vehicles: [],
  glass_requests: [],
  events: [],
  idempotency: {}
});

export class JsonCaseStore {
  private data: StoreShape;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  private load(): StoreShape {
    if (!fs.existsSync(this.filePath)) return emptyStore();
    return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as StoreShape;
  }

  private persist(next: StoreShape) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, this.filePath);
    this.data = next;
  }

  snapshot(): StoreShape {
    return structuredClone(this.data);
  }

  listCases() {
    return [...this.data.cases].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getCase(id: string) {
    return this.data.cases.find(c => c.id === id) ?? null;
  }

  getVehicle(id: string) {
    return this.data.vehicles.find(v => v.id === id) ?? null;
  }

  getGlassRequest(id: string) {
    return this.data.glass_requests.find(g => g.id === id) ?? null;
  }

  getEvents(caseId: string) {
    return this.data.events
      .filter(e => e.case_id === caseId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  findIdempotentCase(key: string) {
    const id = this.data.idempotency[key];
    return id ? this.getCase(id) : null;
  }

  createCase(input: {
    channel: CaseRecord["channel"];
    customer_id?: string | null;
    vehicle: Omit<Vehicle, "id" | "created_at" | "updated_at">;
    glass_type: GlassRequest["glass_type"];
    idempotencyKey?: string;
  }) {
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
      actor_type: "RNR_STAFF",
      actor_id: null,
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
}
