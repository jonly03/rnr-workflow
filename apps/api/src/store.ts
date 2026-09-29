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
  GlassType,
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

/**
 * How long a VIN-lookup claim is honored before another caller may steal
 * it. Guards against a crashed worker blocking lookups forever.
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

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
  /** Interchangeable part numbers for the selected candidate (VIN method). */
  interchangePartNumbers?: string[];
}

/**
 * The cached result of one paid VIN lookup for one glass type.
 * A single VIN cache entry holds one of these per glass type that has
 * been looked up, so a second glass type for the same VIN triggers its
 * own (type-correct) lookup instead of reusing the wrong candidates.
 */
export interface VinLookupGlassResult {
  success: boolean;
  decoded?: { year: number; make: string; model: string; trim: string };
  candidates: GlassCandidate[];
  /** Interchangeable part numbers from the VIN result, for sourcing. */
  interchangePartNumbers?: string[];
  /** OEM part numbers from the VIN result, for reference/staff override. */
  oemPartNumbers?: string[];
  error?: string;
}

/** Shape of the vin_lookups.result JSON: per-glass-type results under one VIN. */
export interface VinLookupCacheValue {
  glassTypes: Partial<Record<GlassType, VinLookupGlassResult>>;
}

export interface SaveVinLookupInput {
  vin: string;
  glassType: GlassType;
  result: VinLookupGlassResult;
}

export interface RecordVinLookupSpendInput {
  vin: string;
  glassType: GlassType;
  costCents: number;
  provider: string;
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
  /** True when the offer is for an interchange rather than the primary part. */
  isInterchange: boolean;
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
  findVinLookup(vin: string, glassType: GlassType): Promise<VinLookupGlassResult | null>;
  saveVinLookup(input: SaveVinLookupInput): Promise<void>;
  /**
   * Atomically claims the right to perform a paid VIN lookup for one
   * (VIN, glass type). Returns true when this caller won the claim;
   * false when another lookup is already in flight. Stale claims
   * (older than CLAIM_TTL_MS) may be stolen so a crashed worker cannot
   * block lookups forever. This is the duplicate-charge prevention for
   * concurrent requests; the cache itself handles sequential ones.
   */
  claimVinLookup(vin: string, glassType: GlassType): Promise<boolean>;
  /** Releases a claim taken by claimVinLookup. Always call in a finally. */
  releaseVinLookup(vin: string, glassType: GlassType): Promise<void>;
  /**
   * Records one paid VIN-lookup charge (cents). Called when a paid lookup
   * is submitted, or when it fails after submission where the charge is
   * uncertain but possible. Never called for free (mock) providers.
   */
  recordVinLookupSpend(input: RecordVinLookupSpendInput): Promise<void>;
  /** Total recorded VIN-lookup spend in cents since the given ISO timestamp. */
  getVinLookupSpendCentsSince(sinceIso: string): Promise<number>;
  saveSupplierOffer(input: SaveSupplierOfferInput): Promise<SupplierOffer>;
  listSupplierOffers(glassRequestId: string): Promise<SupplierOffer[]>;
  selectSupplierOffer(offerId: string): Promise<void>;
  /** Removes all offers for a glass request (used before a sourcing re-run). */
  clearSupplierOffers(glassRequestId: string): Promise<void>;
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
  vin_lookup_spend: [],
  supplier_offers: [],
  price_calculations: []
});

export class JsonCaseStore implements CaseStore {
  private data: StoreShape;
  /** Transient (VIN, glass type) lookup claims. Never persisted. */
  private readonly vinLookupClaims = new Map<string, number>();

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
      interchange_part_numbers: input.interchangePartNumbers ?? [],
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

  async findVinLookup(vin: string, glassType: GlassType): Promise<VinLookupGlassResult | null> {
    const normalized = vin.trim().toUpperCase();
    const entry = this.data.vin_lookups.find(v => v.vin === normalized);
    const value = entry?.result as VinLookupCacheValue | undefined;
    return value?.glassTypes?.[glassType] ?? null;
  }

  async saveVinLookup(input: SaveVinLookupInput): Promise<void> {
    const normalized = input.vin.trim().toUpperCase();
    const next = structuredClone(this.data);
    const existing = next.vin_lookups.find(v => v.vin === normalized);
    // Merge: one VIN entry accumulates per-glass-type results.
    const glassTypes: VinLookupCacheValue["glassTypes"] = {
      ...((existing?.result as VinLookupCacheValue | undefined)?.glassTypes ?? {}),
      [input.glassType]: input.result
    };
    const record: VinLookupRecord = {
      id: existing?.id ?? randomUUID(),
      vin: normalized,
      success:
        input.result.success || (existing?.success ?? false),
      result: { glassTypes } as unknown as Record<string, unknown>,
      created_at: existing?.created_at ?? new Date().toISOString()
    };
    if (existing) {
      next.vin_lookups[next.vin_lookups.indexOf(existing)] = record;
    } else {
      next.vin_lookups.push(record);
    }
    this.persist(next);
  }

  private static vinClaimKey(vin: string, glassType: GlassType): string {
    return `${vin.trim().toUpperCase()}|${glassType}`;
  }

  async claimVinLookup(vin: string, glassType: GlassType): Promise<boolean> {
    const key = JsonCaseStore.vinClaimKey(vin, glassType);
    const claimedAt = this.vinLookupClaims.get(key);
    if (claimedAt !== undefined && Date.now() - claimedAt < CLAIM_TTL_MS) {
      return false;
    }
    this.vinLookupClaims.set(key, Date.now());
    return true;
  }

  async releaseVinLookup(vin: string, glassType: GlassType): Promise<void> {
    this.vinLookupClaims.delete(JsonCaseStore.vinClaimKey(vin, glassType));
  }

  async recordVinLookupSpend(input: RecordVinLookupSpendInput): Promise<void> {
    const next = structuredClone(this.data);
    next.vin_lookup_spend.push({
      id: randomUUID(),
      vin: input.vin.trim().toUpperCase(),
      glass_type: input.glassType,
      cost_cents: input.costCents,
      provider: input.provider,
      spent_at: new Date().toISOString()
    });
    this.persist(next);
  }

  async getVinLookupSpendCentsSince(sinceIso: string): Promise<number> {
    return this.data.vin_lookup_spend
      .filter(s => s.spent_at >= sinceIso)
      .reduce((total, s) => total + s.cost_cents, 0);
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
      is_interchange: input.isInterchange,
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

  async clearSupplierOffers(glassRequestId: string): Promise<void> {
    const next = structuredClone(this.data);
    next.supplier_offers = next.supplier_offers.filter(
      o => o.glass_request_id !== glassRequestId
    );
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
