import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ApprovalTokenRecord,
  CaseEvent,
  CaseRecord,
  Channel,
  GlassCandidate,
  GlassIdentification,
  GlassRequest,
  IdentificationMethod,
  IdentificationStatus,
  PriceCalculation,
  PriceStatus,
  StaffUser,
  StaffUserRecord,
  StoreShape,
  SupplierOffer,
  SupplierType,
  Vehicle,
  VinLookupRecord
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
  channels?: Channel[];
}

export interface CreateApprovalTokenInput {
  caseId: string;
  channel: Channel;
  purpose: string;
  tokenHash: string;
  expiresAt: string;
}

export interface AppendEventInput {
  caseId: string;
  eventType: string;
  actor: { type: string; id: string | null };
  payload?: Record<string, unknown>;
  /** When present, the case transitions to this state atomically with the event. */
  nextState?: string;
}

export interface SaveGlassIdentificationInput {
  caseId: string;
  glassRequestId: string;
  method: IdentificationMethod;
  status: IdentificationStatus;
  provider: string;
  candidates: GlassCandidate[];
  selectedCandidate?: GlassCandidate | null;
}

export interface SaveVinLookupInput {
  vin: string;
  success: boolean;
  result: Record<string, unknown>;
}

export interface SaveSupplierOfferInput {
  caseId: string;
  glassRequestId: string;
  supplierName: string;
  supplierType: SupplierType;
  partNumber: string;
  priceCents: number;
  available: boolean;
  quantity: number;
  leadTimeDays: number | null;
  excludedReason: string | null;
  selected: boolean;
}

export interface SavePriceCalculationInput {
  caseId: string;
  glassRequestId: string;
  selectedOfferId: string | null;
  glassCostCents: number;
  laborCents: number;
  profitCents: number;
  taxCents: number;
  sellPriceCents: number;
  pricingConfig: Record<string, unknown>;
  status: PriceStatus;
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
  createApprovalToken(input: CreateApprovalTokenInput): Promise<{ jti: string }>;
  findApprovalTokenByHash(tokenHash: string): Promise<ApprovalTokenRecord | null>;
  consumeApprovalToken(jti: string): Promise<void>;
  /** Appends an event, optionally transitioning the case state atomically. */
  appendEvent(input: AppendEventInput): Promise<CaseEvent>;
  saveGlassIdentification(input: SaveGlassIdentificationInput): Promise<GlassIdentification>;
  getLatestGlassIdentification(glassRequestId: string): Promise<GlassIdentification | null>;
  findVinLookup(vin: string): Promise<VinLookupRecord | null>;
  saveVinLookup(input: SaveVinLookupInput): Promise<void>;
  saveSupplierOffer(input: SaveSupplierOfferInput): Promise<SupplierOffer>;
  listSupplierOffers(glassRequestId: string): Promise<SupplierOffer[]>;
  selectSupplierOffer(offerId: string): Promise<void>;
  savePriceCalculation(input: SavePriceCalculationInput): Promise<PriceCalculation>;
  getLatestPriceCalculation(glassRequestId: string): Promise<PriceCalculation | null>;
}

const emptyStore = (): StoreShape => ({
  cases: [],
  vehicles: [],
  glass_requests: [],
  events: [],
  idempotency: {},
  staff_users: [],
  approval_tokens: [],
  glass_identifications: [],
  vin_lookups: [],
  supplier_offers: [],
  price_calculations: []
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
      created_at: now,
      ...(input.channels ? { channels: [...input.channels] } : {})
    };
    const next = structuredClone(this.data);
    next.staff_users.push(record);
    this.persist(next);
    const { password_hash: _hash, ...user } = record;
    return user;
  }

  async createApprovalToken(input: CreateApprovalTokenInput): Promise<{ jti: string }> {
    const now = new Date().toISOString();
    const record: ApprovalTokenRecord = {
      jti: randomUUID(),
      case_id: input.caseId,
      channel: input.channel,
      purpose: input.purpose as ApprovalTokenRecord["purpose"],
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      consumed_at: null,
      created_at: now
    };
    const next = structuredClone(this.data);
    next.approval_tokens.push(record);
    this.persist(next);
    return { jti: record.jti };
  }

  async findApprovalTokenByHash(tokenHash: string): Promise<ApprovalTokenRecord | null> {
    return this.data.approval_tokens.find(t => t.token_hash === tokenHash) ?? null;
  }

  async consumeApprovalToken(jti: string): Promise<void> {
    const next = structuredClone(this.data);
    const record = next.approval_tokens.find(t => t.jti === jti);
    if (!record || record.consumed_at) return;
    record.consumed_at = new Date().toISOString();
    this.persist(next);
  }

  async appendEvent(input: AppendEventInput): Promise<CaseEvent> {
    const now = new Date().toISOString();
    const next = structuredClone(this.data);
    const caseRecord = next.cases.find(c => c.id === input.caseId);
    if (!caseRecord) throw new Error("Case not found.");
    const sequence =
      next.events.filter(e => e.case_id === input.caseId).length + 1;
    const event: CaseEvent = {
      id: randomUUID(),
      case_id: input.caseId,
      sequence,
      event_type: input.eventType,
      occurred_at: now,
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      payload: input.payload ?? {},
      corrects_event_id: null
    };
    next.events.push(event);
    if (input.nextState) {
      caseRecord.current_state = input.nextState;
      caseRecord.updated_at = now;
      caseRecord.version += 1;
    }
    this.persist(next);
    return event;
  }

  async saveGlassIdentification(
    input: SaveGlassIdentificationInput
  ): Promise<GlassIdentification> {
    const now = new Date().toISOString();
    const record: GlassIdentification = {
      id: randomUUID(),
      case_id: input.caseId,
      glass_request_id: input.glassRequestId,
      method: input.method,
      status: input.status,
      provider: input.provider,
      candidates: input.candidates,
      selected_candidate: input.selectedCandidate ?? null,
      created_at: now
    };
    const next = structuredClone(this.data);
    next.glass_identifications.push(record);
    this.persist(next);
    return record;
  }

  async getLatestGlassIdentification(
    glassRequestId: string
  ): Promise<GlassIdentification | null> {
    const matches = this.data.glass_identifications.filter(
      g => g.glass_request_id === glassRequestId
    );
    return matches.length ? matches[matches.length - 1] : null;
  }

  async findVinLookup(vin: string): Promise<VinLookupRecord | null> {
    const normalized = vin.trim().toUpperCase();
    return this.data.vin_lookups.find(v => v.vin === normalized) ?? null;
  }

  async saveVinLookup(input: SaveVinLookupInput): Promise<void> {
    const normalized = input.vin.trim().toUpperCase();
    const next = structuredClone(this.data);
    const existing = next.vin_lookups.find(v => v.vin === normalized);
    const record: VinLookupRecord = {
      id: existing?.id ?? randomUUID(),
      vin: normalized,
      success: input.success,
      result: input.result,
      created_at: existing?.created_at ?? new Date().toISOString()
    };
    if (existing) {
      next.vin_lookups[next.vin_lookups.indexOf(existing)] = record;
    } else {
      next.vin_lookups.push(record);
    }
    this.persist(next);
  }

  async saveSupplierOffer(input: SaveSupplierOfferInput): Promise<SupplierOffer> {
    const now = new Date().toISOString();
    const record: SupplierOffer = {
      id: randomUUID(),
      case_id: input.caseId,
      glass_request_id: input.glassRequestId,
      supplier_name: input.supplierName,
      supplier_type: input.supplierType,
      part_number: input.partNumber,
      price_cents: input.priceCents,
      available: input.available,
      quantity: input.quantity,
      lead_time_days: input.leadTimeDays,
      excluded_reason: input.excludedReason,
      selected: input.selected,
      created_at: now
    };
    const next = structuredClone(this.data);
    next.supplier_offers.push(record);
    this.persist(next);
    return record;
  }

  async listSupplierOffers(glassRequestId: string): Promise<SupplierOffer[]> {
    return this.data.supplier_offers
      .filter(o => o.glass_request_id === glassRequestId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async selectSupplierOffer(offerId: string): Promise<void> {
    const next = structuredClone(this.data);
    const record = next.supplier_offers.find(o => o.id === offerId);
    if (!record) return;
    // Only one selected offer per glass request.
    for (const o of next.supplier_offers) {
      if (o.glass_request_id === record.glass_request_id) o.selected = false;
    }
    record.selected = true;
    this.persist(next);
  }

  async savePriceCalculation(input: SavePriceCalculationInput): Promise<PriceCalculation> {
    const now = new Date().toISOString();
    const record: PriceCalculation = {
      id: randomUUID(),
      case_id: input.caseId,
      glass_request_id: input.glassRequestId,
      selected_offer_id: input.selectedOfferId,
      glass_cost_cents: input.glassCostCents,
      labor_cents: input.laborCents,
      profit_cents: input.profitCents,
      tax_cents: input.taxCents,
      sell_price_cents: input.sellPriceCents,
      pricing_config: input.pricingConfig,
      status: input.status,
      created_at: now
    };
    const next = structuredClone(this.data);
    next.price_calculations.push(record);
    this.persist(next);
    return record;
  }

  async getLatestPriceCalculation(glassRequestId: string): Promise<PriceCalculation | null> {
    const matches = this.data.price_calculations.filter(
      p => p.glass_request_id === glassRequestId
    );
    return matches.length ? matches[matches.length - 1] : null;
  }
}
