import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ApprovalTokenRecord,
  AssetKind,
  AssetStatus,
  AssetVisibility,
  AvailabilityWindow,
  CaseAsset,
  CaseEvent,
  CaseEventNotification,
  CaseRecord,
  Channel,
  GlassCandidate,
  GlassIdentification,
  GlassRequest,
  GlassType,
  IdentificationMethod,
  IdentificationStatus,
  Invoice,
  InvoiceActuals,
  InvoiceDisputeResolution,
  InvoiceEvent,
  InvoiceEventKind,
  InvoicePaymentStatus,
  Job,
  JobStepEvent,
  OperatorInvite,
  PriceCalculation,
  PriceStatus,
  Quote,
  QuoteSignature,
  QuoteSnapshot,
  QuoteStatus,
  SignatureMethod,
  StaffUser,
  StaffUserRecord,
  StoreShape,
  SupplierOffer,
  SupplierType,
  TechProfile,
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
  /** Null for Google-only accounts (techs): no local password exists. */
  passwordHash: string | null;
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

export interface ReserveVinLookupSpendInput {
  vin: string;
  glassType: GlassType;
  costCents: number;
  provider: string;
  /** Daily cap in cents: the reservation is refused when it would exceed this. */
  capCents: number;
  /** ISO start of the cap window (UTC day). */
  sinceIso: string;
}

export interface ReserveVinLookupSpendResult {
  reserved: boolean;
  /** Spend-ledger row id when reserved; null when the cap refused the reservation. */
  spendId: string | null;
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

export interface SaveQuoteInput {
  caseId: string;
  version: number;
  snapshot: QuoteSnapshot;
  /** ISO timestamp after which the quote can no longer be signed. */
  expiresAt: string;
  status: QuoteStatus;
}

export interface SignQuoteInput {
  quoteId: string;
  name: string;
  signatureHash: string;
  signatureDataUrl: string;
  method: SignatureMethod;
  signedAt: string;
  attribution: string;
}

export interface SaveInvoiceInput {
  caseId: string;
  version: number;
  actuals: InvoiceActuals;
}

export interface CreateTechProfileInput {
  userId: string;
  googleSub?: string | null;
  googleRefreshCredential?: string | null;
}

export type TechProfilePatch = Partial<
  Pick<
    TechProfile,
    | "status"
    | "phone"
    | "home_base"
    | "service_area"
    | "claimed_qualifications"
    | "qualifications"
    | "availability"
    | "live_status"
    | "location_sharing_consent"
    | "google_sub"
    | "google_refresh_credential"
  >
>;

export interface CreateOperatorInviteInput {
  email: string;
  credentialHash: string;
  invitedBy: string | null;
  expiresAt: string;
}

export interface CreateJobInput {
  caseId: string;
}

export interface AppendJobStepEventInput {
  jobId: string;
  caseId: string;
  step: string;
  actor: { type: string; id: string | null };
  payload?: Record<string, unknown>;
}

export interface CreateCaseAssetInput {
  /** Minted by the caller: the storage key embeds the asset id, and the
   *  key must be final before any bytes land. */
  id: string;
  caseId: string;
  jobId: string | null;
  kind: AssetKind;
  visibility: AssetVisibility;
  storageDriver: string;
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: AssetStatus;
  uploadedBy: { type: string; id: string | null };
}

export type CaseAssetPatch = Partial<Pick<CaseAsset, "status" | "size_bytes">>;

export type JobPatch = Partial<
  Pick<
    Job,
    | "status"
    | "assignment_mode"
    | "assigned_tech_id"
    | "scheduled_start"
    | "scheduled_end"
    | "calendar_event_id"
  >
>;

// Re-exported so store consumers can type availability windows without a
// second import path.
export type { AvailabilityWindow };


/** Partial payment-lifecycle update for one invoice version. Only the
 *  fields present are written; the state machine lives in payments.ts —
 *  the store just persists. */
export interface UpdateInvoicePaymentInput {
  payment_status?: InvoicePaymentStatus;
  sent_at?: string | null;
  sent_via?: string | null;
  sent_to?: string | null;
  paid_at?: string | null;
  paid_method?: string | null;
  paid_ref?: string | null;
  paid_by?: string | null;
  dispute_reason_code?: string | null;
  dispute_reason?: string | null;
  disputed_at?: string | null;
  dispute_resolution?: InvoiceDisputeResolution | null;
  dispute_resolved_at?: string | null;
}

export interface AppendInvoiceEventInput {
  invoiceId: string;
  caseId: string;
  kind: InvoiceEventKind;
  actor: { type: string; id: string | null };
  note?: string | null;
  payload?: Record<string, unknown>;
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
  /**
   * Optional realtime feed: invoke `listener` for every case event
   * appended anywhere in this deployment (Postgres LISTEN/NOTIFY for the
   * PG store, an in-process fan-out for the JSON store). Resolves to an
   * unsubscribe function. Powers the staff dashboard's live updates.
   */
  subscribeCaseEvents?(
    listener: (notification: CaseEventNotification) => void
  ): Promise<() => void>;
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
   * Atomically reserves one paid VIN-lookup charge (cents) against the daily
   * cap: the cap check and the ledger insert happen in a single step, so two
   * concurrent paid lookups cannot both slip under the cap. Call BEFORE
   * submitting the lookup; on success or on a failure that may have been
   * charged, the reservation stands as the spend record. On a proven
   * pre-submission failure (no charge possible), call releaseVinLookupSpend
   * to return the budget. Never called for free (mock) providers.
   */
  reserveVinLookupSpend(input: ReserveVinLookupSpendInput): Promise<ReserveVinLookupSpendResult>;
  /** Releases a spend reservation (proven-no-charge failure). Deletes the ledger row. */
  releaseVinLookupSpend(spendId: string): Promise<void>;
  /** Total recorded VIN-lookup spend in cents since the given ISO timestamp. */
  getVinLookupSpendCentsSince(sinceIso: string): Promise<number>;
  saveSupplierOffer(input: SaveSupplierOfferInput): Promise<SupplierOffer>;
  listSupplierOffers(glassRequestId: string): Promise<SupplierOffer[]>;
  selectSupplierOffer(offerId: string): Promise<void>;
  /** Removes all offers for a glass request (used before a sourcing re-run). */
  clearSupplierOffers(glassRequestId: string): Promise<void>;
  savePriceCalculation(input: SavePriceCalculationInput): Promise<PriceCalculation>;
  getLatestPriceCalculation(glassRequestId: string): Promise<PriceCalculation | null>;
  /** Persists a new quote version (append-only; history is never mutated). */
  saveQuote(input: SaveQuoteInput): Promise<Quote>;
  /** All quote versions for a case, oldest first. */
  listQuotes(caseId: string): Promise<Quote[]>;
  getLatestQuote(caseId: string): Promise<Quote | null>;
  /** Records the client's signature on a quote (signature = approval). Idempotent. */
  signQuote(input: SignQuoteInput): Promise<Quote>;
  /** Sets a quote's status (DECLINED / EXPIRED). Returns the updated quote. */
  updateQuoteStatus(quoteId: string, status: QuoteStatus): Promise<Quote>;
  /** Persists a new invoice version (append-only; history is never mutated). */
  saveInvoice(input: SaveInvoiceInput): Promise<Invoice>;
  /** All invoice versions for a case, oldest first. */
  listInvoices(caseId: string): Promise<Invoice[]>;
  getLatestInvoice(caseId: string): Promise<Invoice | null>;
  /** All operator accounts (staff/admin/owner/tech), oldest first. */
  listStaffUsers(): Promise<StaffUserRecord[]>;
  getStaffById(id: string): Promise<StaffUserRecord | null>;
  /** Creates the tech profile for a freshly onboarded tech user. */
  createTechProfile(input: CreateTechProfileInput): Promise<TechProfile>;
  getTechProfile(userId: string): Promise<TechProfile | null>;
  listTechProfiles(): Promise<TechProfile[]>;
  updateTechProfile(userId: string, patch: TechProfilePatch): Promise<TechProfile>;
  createOperatorInvite(input: CreateOperatorInviteInput): Promise<OperatorInvite>;
  findOperatorInviteByHash(credentialHash: string): Promise<OperatorInvite | null>;
  /** The newest unconsumed invite for an email, if one is still open. */
  findOpenOperatorInviteByEmail(email: string): Promise<OperatorInvite | null>;
  listOperatorInvites(): Promise<OperatorInvite[]>;
  consumeOperatorInvite(id: string): Promise<void>;
  deleteOperatorInvite(id: string): Promise<void>;
  /** Creates the (single, v1) job for a case. Throws if one exists. */
  createJob(input: CreateJobInput): Promise<Job>;
  getJobByCase(caseId: string): Promise<Job | null>;
  getJob(id: string): Promise<Job | null>;
  listJobs(): Promise<Job[]>;
  updateJob(id: string, patch: JobPatch): Promise<Job>;
  /** Every invoice in the store, newest first (staff collections board). */
  listAllInvoices(): Promise<Invoice[]>;
  /** Applies a payment-lifecycle patch to one invoice version. */
  updateInvoicePayment(invoiceId: string, patch: UpdateInvoicePaymentInput): Promise<Invoice>;
  /** Appends one entry to an invoice's payment thread (append-only). */
  appendInvoiceEvent(input: AppendInvoiceEventInput): Promise<InvoiceEvent>;
  /** An invoice's payment thread, oldest first. */
  listInvoiceEvents(invoiceId: string): Promise<InvoiceEvent[]>;
  /** Appends one checklist step event to a job (Slice B, append-only). */
  appendJobStepEvent(input: AppendJobStepEventInput): Promise<JobStepEvent>;
  /** All step events for a job, oldest first. */
  listJobStepEvents(jobId: string): Promise<JobStepEvent[]>;
  /** Registers one file in the case's asset registry (Slice B, §7.3). */
  createCaseAsset(input: CreateCaseAssetInput): Promise<CaseAsset>;
  getCaseAsset(id: string): Promise<CaseAsset | null>;
  /** All assets on a case, oldest first. */
  listCaseAssets(caseId: string): Promise<CaseAsset[]>;
  updateCaseAsset(id: string, patch: CaseAssetPatch): Promise<CaseAsset>;
}

const emptyStore = (): StoreShape => ({
  cases: [],
  vehicles: [],
  glass_requests: [],
  events: [],
  idempotency: {},
  staff_users: [],
  tech_profiles: [],
  operator_invites: [],
  jobs: [],
  job_step_events: [],
  case_assets: [],
  approval_tokens: [],
  glass_identifications: [],
  vin_lookups: [],
  vin_lookup_spend: [],
  supplier_offers: [],
  price_calculations: [],
  quotes: [],
  invoices: [],
  invoice_events: []
});

export class JsonCaseStore implements CaseStore {
  private data: StoreShape;
  private caseEventListeners = new Set<
    (notification: CaseEventNotification) => void
  >();
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
    const notification: CaseEventNotification = {
      case_id: event.case_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      sequence: event.sequence
    };
    for (const listener of this.caseEventListeners) {
      try {
        listener(notification);
      } catch {
        // A broken subscriber must never fail the append itself.
      }
    }
    return event;
  }

  async subscribeCaseEvents(
    listener: (notification: CaseEventNotification) => void
  ): Promise<() => void> {
    this.caseEventListeners.add(listener);
    return () => {
      this.caseEventListeners.delete(listener);
    };
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

  async reserveVinLookupSpend(input: ReserveVinLookupSpendInput): Promise<ReserveVinLookupSpendResult> {
    const next = structuredClone(this.data);
    const spentCents = next.vin_lookup_spend
      .filter(s => s.spent_at >= input.sinceIso)
      .reduce((total, s) => total + s.cost_cents, 0);
    if (spentCents + input.costCents > input.capCents) {
      return { reserved: false, spendId: null };
    }
    const spendId = randomUUID();
    next.vin_lookup_spend.push({
      id: spendId,
      vin: input.vin.trim().toUpperCase(),
      glass_type: input.glassType,
      cost_cents: input.costCents,
      provider: input.provider,
      spent_at: new Date().toISOString()
    });
    this.persist(next);
    return { reserved: true, spendId };
  }

  async releaseVinLookupSpend(spendId: string): Promise<void> {
    const next = structuredClone(this.data);
    next.vin_lookup_spend = next.vin_lookup_spend.filter(s => s.id !== spendId);
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

  async saveQuote(input: SaveQuoteInput): Promise<Quote> {
    const now = new Date().toISOString();
    const record: Quote = {
      id: randomUUID(),
      case_id: input.caseId,
      version: input.version,
      snapshot: input.snapshot,
      expires_at: input.expiresAt,
      status: input.status,
      signature: null,
      created_at: now
    };
    const next = structuredClone(this.data);
    next.quotes.push(record);
    this.persist(next);
    return record;
  }

  async listQuotes(caseId: string): Promise<Quote[]> {
    return this.data.quotes
      .filter(q => q.case_id === caseId)
      .sort((a, b) => a.version - b.version);
  }

  async getLatestQuote(caseId: string): Promise<Quote | null> {
    const matches = await this.listQuotes(caseId);
    return matches.length ? matches[matches.length - 1] : null;
  }

  async signQuote(input: SignQuoteInput): Promise<Quote> {
    const next = structuredClone(this.data);
    const record = next.quotes.find(q => q.id === input.quoteId);
    if (!record) throw new Error("Quote not found.");
    // Idempotent: a second sign call returns the current record unchanged.
    if (record.status !== "APPROVED") {
      record.status = "APPROVED";
      record.signature = {
        name: input.name,
        signed_at: input.signedAt,
        attribution: input.attribution,
        signature_hash: input.signatureHash,
        signature_data_url: input.signatureDataUrl,
        method: input.method
      };
    }
    this.persist(next);
    return record;
  }

  async updateQuoteStatus(quoteId: string, status: QuoteStatus): Promise<Quote> {
    const next = structuredClone(this.data);
    const record = next.quotes.find(q => q.id === quoteId);
    if (!record) throw new Error("Quote not found.");
    record.status = status;
    this.persist(next);
    return record;
  }

  async saveInvoice(input: SaveInvoiceInput): Promise<Invoice> {
    const now = new Date().toISOString();
    const record: Invoice = {
      id: randomUUID(),
      case_id: input.caseId,
      version: input.version,
      actuals: input.actuals,
      created_at: now,
      payment_status: "UNSENT",
      sent_at: null,
      sent_via: null,
      sent_to: null,
      paid_at: null,
      paid_method: null,
      paid_ref: null,
      paid_by: null,
      dispute_reason_code: null,
      dispute_reason: null,
      disputed_at: null,
      dispute_resolution: null,
      dispute_resolved_at: null
    };
    const next = structuredClone(this.data);
    next.invoices.push(record);
    this.persist(next);
    return record;
  }

  async listInvoices(caseId: string): Promise<Invoice[]> {
    return this.data.invoices
      .filter(i => i.case_id === caseId)
      .sort((a, b) => a.version - b.version)
      .map(withPaymentDefaults);
  }

  async getLatestInvoice(caseId: string): Promise<Invoice | null> {
    const matches = await this.listInvoices(caseId);
    return matches.length ? matches[matches.length - 1] : null;
  }

  async listStaffUsers(): Promise<StaffUserRecord[]> {
    return [...this.data.staff_users].sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
  }

  async getStaffById(id: string): Promise<StaffUserRecord | null> {
    return this.data.staff_users.find(u => u.id === id) ?? null;
  }

  async createTechProfile(input: CreateTechProfileInput): Promise<TechProfile> {
    const now = new Date().toISOString();
    const record: TechProfile = {
      user_id: input.userId,
      status: "PROFILE_PENDING",
      phone: null,
      home_base: null,
      service_area: null,
      claimed_qualifications: [],
      qualifications: [],
      availability: [],
      live_status: "AVAILABLE",
      location_sharing_consent: false,
      google_sub: input.googleSub ?? null,
      google_refresh_credential: input.googleRefreshCredential ?? null,
      created_at: now,
      updated_at: now
    };
    const next = structuredClone(this.data);
    next.tech_profiles.push(record);
    this.persist(next);
    return record;
  }

  async getTechProfile(userId: string): Promise<TechProfile | null> {
    return this.data.tech_profiles.find(p => p.user_id === userId) ?? null;
  }

  async listTechProfiles(): Promise<TechProfile[]> {
    return [...this.data.tech_profiles];
  }

  async updateTechProfile(userId: string, patch: TechProfilePatch): Promise<TechProfile> {
    const next = structuredClone(this.data);
    const record = next.tech_profiles.find(p => p.user_id === userId);
    if (!record) throw new Error("Tech profile not found.");
    Object.assign(record, patch);
    record.updated_at = new Date().toISOString();
    this.persist(next);
    return record;
  }

  async createOperatorInvite(input: CreateOperatorInviteInput): Promise<OperatorInvite> {
    const record: OperatorInvite = {
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      credential_hash: input.credentialHash,
      invited_by: input.invitedBy,
      expires_at: input.expiresAt,
      consumed_at: null,
      created_at: new Date().toISOString()
    };
    const next = structuredClone(this.data);
    next.operator_invites.push(record);
    this.persist(next);
    return record;
  }

  async listAllInvoices(): Promise<Invoice[]> {
    return [...this.data.invoices]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(withPaymentDefaults);
  }

  async updateInvoicePayment(
    invoiceId: string,
    patch: UpdateInvoicePaymentInput
  ): Promise<Invoice> {
    const next = structuredClone(this.data);
    const record = next.invoices.find(i => i.id === invoiceId);
    if (!record) throw new Error("Invoice not found.");
    Object.assign(record, patch);
    this.persist(next);
    return withPaymentDefaults(record);
  }

  async appendInvoiceEvent(input: AppendInvoiceEventInput): Promise<InvoiceEvent> {
    const record: InvoiceEvent = {
      id: randomUUID(),
      invoice_id: input.invoiceId,
      case_id: input.caseId,
      kind: input.kind,
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      note: input.note ?? null,
      payload: input.payload ?? {},
      created_at: new Date().toISOString()
    };
    const next = structuredClone(this.data);
    next.invoice_events.push(record);
    this.persist(next);
    return record;
  }

  async findOperatorInviteByHash(credentialHash: string): Promise<OperatorInvite | null> {
    return this.data.operator_invites.find(i => i.credential_hash === credentialHash) ?? null;
  }

  async findOpenOperatorInviteByEmail(email: string): Promise<OperatorInvite | null> {
    const normalized = email.trim().toLowerCase();
    const open = this.data.operator_invites.filter(
      i => i.email === normalized && !i.consumed_at
    );
    return open.length ? open[open.length - 1] : null;
  }

  async listOperatorInvites(): Promise<OperatorInvite[]> {
    return [...this.data.operator_invites].sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
  }

  async consumeOperatorInvite(id: string): Promise<void> {
    const next = structuredClone(this.data);
    const record = next.operator_invites.find(i => i.id === id);
    if (!record || record.consumed_at) return;
    record.consumed_at = new Date().toISOString();
    this.persist(next);
  }

  async deleteOperatorInvite(id: string): Promise<void> {
    const next = structuredClone(this.data);
    next.operator_invites = next.operator_invites.filter(i => i.id !== id);
    this.persist(next);
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    if (this.data.jobs.some(j => j.case_id === input.caseId)) {
      throw new Error("A job already exists for this case.");
    }
    const now = new Date().toISOString();
    const record: Job = {
      id: randomUUID(),
      case_id: input.caseId,
      status: "UNASSIGNED",
      assignment_mode: "DIRECT",
      assigned_tech_id: null,
      scheduled_start: null,
      scheduled_end: null,
      calendar_event_id: null,
      created_at: now,
      updated_at: now
    };
    const next = structuredClone(this.data);
    next.jobs.push(record);
    this.persist(next);
    return record;
  }

  async getJobByCase(caseId: string): Promise<Job | null> {
    return this.data.jobs.find(j => j.case_id === caseId) ?? null;
  }

  async getJob(id: string): Promise<Job | null> {
    return this.data.jobs.find(j => j.id === id) ?? null;
  }

  async listJobs(): Promise<Job[]> {
    return [...this.data.jobs];
  }

  async updateJob(id: string, patch: JobPatch): Promise<Job> {
    const next = structuredClone(this.data);
    const record = next.jobs.find(j => j.id === id);
    if (!record) throw new Error("Job not found.");
    Object.assign(record, patch);
    record.updated_at = new Date().toISOString();
    this.persist(next);
    return record;
  }

  async appendJobStepEvent(input: AppendJobStepEventInput): Promise<JobStepEvent> {
    const record: JobStepEvent = {
      id: randomUUID(),
      job_id: input.jobId,
      case_id: input.caseId,
      step: input.step,
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      payload: input.payload ?? {},
      occurred_at: new Date().toISOString()
    };
    const next = structuredClone(this.data);
    next.job_step_events.push(record);
    this.persist(next);
    return record;
  }

  async listJobStepEvents(jobId: string): Promise<JobStepEvent[]> {
    return this.data.job_step_events
      .filter(e => e.job_id === jobId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }

  async createCaseAsset(input: CreateCaseAssetInput): Promise<CaseAsset> {
    const record: CaseAsset = {
      id: input.id,
      case_id: input.caseId,
      job_id: input.jobId,
      kind: input.kind,
      visibility: input.visibility,
      storage_driver: input.storageDriver,
      storage_key: input.storageKey,
      filename: input.filename,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      status: input.status,
      uploaded_by_type: input.uploadedBy.type,
      uploaded_by_id: input.uploadedBy.id,
      created_at: new Date().toISOString()
    };
    const next = structuredClone(this.data);
    next.case_assets.push(record);
    this.persist(next);
    return record;
  }

  async getCaseAsset(id: string): Promise<CaseAsset | null> {
    return this.data.case_assets.find(a => a.id === id) ?? null;
  }

  async listCaseAssets(caseId: string): Promise<CaseAsset[]> {
    return this.data.case_assets
      .filter(a => a.case_id === caseId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async updateCaseAsset(id: string, patch: CaseAssetPatch): Promise<CaseAsset> {
    const next = structuredClone(this.data);
    const record = next.case_assets.find(a => a.id === id);
    if (!record) throw new Error("Asset not found.");
    Object.assign(record, patch);
    this.persist(next);
    return record;
  }
  async listInvoiceEvents(invoiceId: string): Promise<InvoiceEvent[]> {
    return this.data.invoice_events
      .filter(e => e.invoice_id === invoiceId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

/**
 * Store files written before Slice D have invoice rows without payment
 * fields. Normalize on read so the payment lifecycle always sees the
 * full shape (new invoices are UNSENT until staff act).
 */
function withPaymentDefaults(invoice: Invoice): Invoice {
  return {
    ...invoice,
    payment_status: invoice.payment_status ?? "UNSENT",
    sent_at: invoice.sent_at ?? null,
    sent_via: invoice.sent_via ?? null,
    sent_to: invoice.sent_to ?? null,
    paid_at: invoice.paid_at ?? null,
    paid_method: invoice.paid_method ?? null,
    paid_ref: invoice.paid_ref ?? null,
    paid_by: invoice.paid_by ?? null,
    dispute_reason_code: invoice.dispute_reason_code ?? null,
    dispute_reason: invoice.dispute_reason ?? null,
    disputed_at: invoice.disputed_at ?? null,
    dispute_resolution: invoice.dispute_resolution ?? null,
    dispute_resolved_at: invoice.dispute_resolved_at ?? null
  };
}
