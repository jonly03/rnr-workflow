import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  ApprovalTokenRecord,
  AvailabilityWindow,
  CaseAsset,
  CaseEvent,
  CaseEventNotification,
  CaseRecord,
  GlassCandidate,
  GlassIdentification,
  GlassRequest,
  Invoice,
  InvoiceActuals,
  Job,
  JobLocationPing,
  JobStepEvent,
  OperatorInvite,
  PriceCalculation,
  Quote,
  QuoteSnapshot,
  QuoteStatus,
  StaffUser,
  StaffUserRecord,
  SupplierOffer,
  TechProfile,
  Vehicle,
  VinLookupRecord
} from "./types.js";
import type {
  AppendEventInput,
  AppendJobLocationPingInput,
  AppendJobStepEventInput,
  CaseAssetPatch,
  CaseStore,
  CreateApprovalTokenInput,
  CreateCaseAssetInput,
  CreateCaseStoreInput,
  CreateJobInput,
  CreateOperatorInviteInput,
  CreateStaffUserInput,
  CreateTechProfileInput,
  JobPatch,
  ReserveVinLookupSpendInput,
  ReserveVinLookupSpendResult,
  SaveGlassIdentificationInput,
  SaveInvoiceInput,
  SavePriceCalculationInput,
  SaveQuoteInput,
  SaveSupplierOfferInput,
  SaveVinLookupInput,
  SignQuoteInput,
  TechProfilePatch,
  VinLookupGlassResult
} from "./store.js";
import type { GlassType } from "./types.js";

type Pool = pg.Pool;
type PoolClient = pg.PoolClient;

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);

function caseRow(row: any): CaseRecord {
  return {
    id: row.id,
    reference: row.reference,
    channel: row.channel,
    current_state: row.current_state,
    customer_id: row.customer_id,
    vehicle_id: row.vehicle_id,
    glass_request_id: row.glass_request_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    version: Number(row.version)
  };
}

function vehicleRow(row: any): Vehicle {
  return {
    id: row.id,
    year: Number(row.year),
    make: row.make,
    model: row.model,
    vin: row.vin,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

function glassRow(row: any): GlassRequest {
  return {
    id: row.id,
    case_id: row.case_id,
    glass_type: row.glass_type,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

function eventRow(row: any): CaseEvent {
  return {
    id: row.id,
    case_id: row.case_id,
    sequence: Number(row.sequence),
    event_type: row.event_type,
    occurred_at: iso(row.occurred_at),
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    payload: row.payload ?? {},
    corrects_event_id: row.corrects_event_id
  };
}

function staffRow(row: any): StaffUserRecord {
  const channels = Array.isArray(row.channels)
    ? row.channels
    : typeof row.channels === "string"
      ? JSON.parse(row.channels)
      : undefined;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    password_hash: row.password_hash,
    created_at: iso(row.created_at),
    ...(channels ? { channels } : {})
  };
}

function approvalTokenRow(row: any): ApprovalTokenRecord {
  return {
    jti: row.jti,
    case_id: row.case_id,
    channel: row.channel,
    purpose: row.purpose,
    token_hash: row.token_hash,
    expires_at: iso(row.expires_at),
    consumed_at: row.consumed_at ? iso(row.consumed_at) : null,
    created_at: iso(row.created_at)
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function glassIdentificationRow(row: any): GlassIdentification {
  return {
    id: row.id,
    case_id: row.case_id,
    glass_request_id: row.glass_request_id,
    method: row.method,
    status: row.status,
    provider: row.provider,
    candidates: parseJson<GlassCandidate[]>(row.candidates, []),
    selected_candidate: parseJson<GlassCandidate | null>(row.selected_candidate, null),
    interchange_part_numbers: parseJson<string[]>(row.interchange_part_numbers, []),
    created_at: iso(row.created_at)
  };
}

function vinLookupRow(row: any): VinLookupRecord {
  return {
    id: row.id,
    vin: row.vin,
    success: Boolean(row.success),
    result: parseJson<Record<string, unknown>>(row.result, {}),
    created_at: iso(row.created_at)
  };
}

function supplierOfferRow(row: any): SupplierOffer {
  return {
    id: row.id,
    case_id: row.case_id,
    glass_request_id: row.glass_request_id,
    supplier_name: row.supplier_name,
    supplier_type: row.supplier_type,
    part_number: row.part_number,
    price_cents: Number(row.price_cents),
    available: Boolean(row.available),
    quantity: Number(row.quantity),
    lead_time_days: row.lead_time_days == null ? null : Number(row.lead_time_days),
    excluded_reason: row.excluded_reason,
    selected: Boolean(row.selected),
    is_interchange: Boolean(row.is_interchange),
    created_at: iso(row.created_at)
  };
}

function priceCalculationRow(row: any): PriceCalculation {
  return {
    id: row.id,
    case_id: row.case_id,
    glass_request_id: row.glass_request_id,
    selected_offer_id: row.selected_offer_id,
    glass_cost_cents: Number(row.glass_cost_cents),
    labor_cents: Number(row.labor_cents),
    profit_cents: Number(row.profit_cents),
    tax_cents: Number(row.tax_cents),
    sell_price_cents: Number(row.sell_price_cents),
    pricing_config: parseJson<Record<string, unknown>>(row.pricing_config, {}),
    status: row.status,
    created_at: iso(row.created_at)
  };
}

function quoteRow(row: any): Quote {
  return {
    id: row.id,
    case_id: row.case_id,
    version: Number(row.version),
    snapshot: parseJson<QuoteSnapshot>(row.snapshot, {
      vehicle: { year: 0, make: "", model: "", vin: "" },
      glass_type: "",
      part_number: null,
      supplier_name: null,
      glass_cost_cents: 0,
      labor_cents: 0,
      profit_cents: 0,
      tax_cents: 0,
      sell_price_cents: 0,
      price_calculation_id: ""
    }),
    expires_at: iso(row.expires_at),
    status: row.status as QuoteStatus,
    signature: row.signature == null ? null : parseJson(row.signature, null),
    created_at: iso(row.created_at)
  };
}

function techProfileRow(row: any): TechProfile {
  return {
    user_id: row.user_id,
    status: row.status,
    phone: row.phone ?? null,
    home_base: row.home_base ?? null,
    service_area: row.service_area ?? null,
    claimed_qualifications: parseJson<string[]>(row.claimed_qualifications, []),
    qualifications: parseJson<string[]>(row.qualifications, []),
    availability: parseJson<AvailabilityWindow[]>(row.availability, []),
    live_status: row.live_status === "OFF" ? "OFF" : "AVAILABLE",
    location_sharing_consent: Boolean(row.location_sharing_consent),
    google_sub: row.google_sub ?? null,
    google_refresh_credential: row.google_refresh_credential ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

function operatorInviteRow(row: any): OperatorInvite {
  return {
    id: row.id,
    email: row.email,
    credential_hash: row.credential_hash,
    invited_by: row.invited_by ?? null,
    expires_at: iso(row.expires_at),
    consumed_at: row.consumed_at ? iso(row.consumed_at) : null,
    created_at: iso(row.created_at)
  };
}

function jobRow(row: any): Job {
  return {
    id: row.id,
    case_id: row.case_id,
    status: row.status,
    assignment_mode: row.assignment_mode === "OFFERED" ? "OFFERED" : "DIRECT",
    assigned_tech_id: row.assigned_tech_id ?? null,
    scheduled_start: row.scheduled_start ? iso(row.scheduled_start) : null,
    scheduled_end: row.scheduled_end ? iso(row.scheduled_end) : null,
    calendar_event_id: row.calendar_event_id ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

function jobStepEventRow(row: any): JobStepEvent {
  return {
    id: row.id,
    job_id: row.job_id,
    case_id: row.case_id,
    step: row.step,
    actor_type: row.actor_type,
    actor_id: row.actor_id ?? null,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    occurred_at: iso(row.occurred_at)
  };
}

function jobLocationPingRow(row: any): JobLocationPing {
  return {
    id: row.id,
    job_id: row.job_id,
    case_id: row.case_id,
    tech_id: row.tech_id,
    lat: Number(row.lat),
    lon: Number(row.lon),
    accuracy_m: row.accuracy_m == null ? null : Number(row.accuracy_m),
    recorded_at: iso(row.recorded_at)
  };
}

function caseAssetRow(row: any): CaseAsset {
  return {
    id: row.id,
    case_id: row.case_id,
    job_id: row.job_id ?? null,
    kind: row.kind,
    visibility: row.visibility,
    storage_driver: row.storage_driver,
    storage_key: row.storage_key,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    status: row.status === "READY" ? "READY" : "PENDING",
    uploaded_by_type: row.uploaded_by_type,
    uploaded_by_id: row.uploaded_by_id ?? null,
    created_at: iso(row.created_at)
  };
}

function invoiceRow(row: any): Invoice {
  return {
    id: row.id,
    case_id: row.case_id,
    version: Number(row.version),
    actuals: parseJson<InvoiceActuals>(row.actuals, {
      glass_cost_cents: 0,
      labor_cents: 0,
      profit_cents: 0,
      tax_cents: 0,
      sell_price_cents: 0,
      price_calculation_id: "",
      quote_id: "",
      quote_version: 0,
      source: "unknown"
    }),
    created_at: iso(row.created_at)
  };
}

export class PgCaseStore implements CaseStore {
  private caseEventListeners = new Set<
    (notification: CaseEventNotification) => void
  >();
  private listenClient: PoolClient | null = null;
  private listenSetup: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  async health() {
    await this.pool.query("select 1");
  }

  async listCases() {
    const result = await this.pool.query(
      "select * from cases order by updated_at desc, reference desc"
    );
    return result.rows.map(caseRow);
  }

  async getCase(id: string) {
    const result = await this.pool.query("select * from cases where id = $1", [id]);
    return result.rowCount ? caseRow(result.rows[0]) : null;
  }

  async getVehicle(id: string) {
    const result = await this.pool.query("select * from vehicles where id = $1", [id]);
    return result.rowCount ? vehicleRow(result.rows[0]) : null;
  }

  async getGlassRequest(id: string) {
    const result = await this.pool.query("select * from glass_requests where id = $1", [id]);
    return result.rowCount ? glassRow(result.rows[0]) : null;
  }

  async getEvents(caseId: string) {
    const result = await this.pool.query(
      "select * from case_events where case_id = $1 order by sequence asc",
      [caseId]
    );
    return result.rows.map(eventRow);
  }

  private async caseById(client: PoolClient, id: string) {
    const result = await client.query("select * from cases where id = $1", [id]);
    return result.rowCount ? caseRow(result.rows[0]) : null;
  }

  async createCase(input: CreateCaseStoreInput) {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      if (input.idempotencyKey) {
        const prior = await client.query(
          "select case_id from case_create_idempotency where idempotency_key = $1",
          [input.idempotencyKey]
        );

        if (prior.rowCount) {
          const existing = await this.caseById(client, prior.rows[0].case_id);
          if (!existing) throw new Error("Idempotency record references a missing case.");
          await client.query("commit");
          return { caseRecord: existing, reused: true };
        }
      }

      const now = new Date().toISOString();
      const caseId = randomUUID();
      const vehicleId = randomUUID();
      const glassRequestId = randomUUID();

      const refResult = await client.query(
        "select nextval('case_reference_seq')::bigint as n"
      );
      const reference = `RRA-${String(refResult.rows[0].n).padStart(6, "0")}`;

      if (input.customer_id) {
        await client.query(
          "insert into customers(id, created_at) values ($1, $2) on conflict (id) do nothing",
          [input.customer_id, now]
        );
      }

      await client.query(
        `insert into vehicles(id, year, make, model, vin, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$6)`,
        [vehicleId, input.vehicle.year, input.vehicle.make, input.vehicle.model, input.vehicle.vin, now]
      );

      await client.query(
        `insert into cases(
          id, reference, channel, current_state, customer_id, vehicle_id,
          glass_request_id, created_at, updated_at, version
        ) values ($1,$2,$3,'REQUEST_RECEIVED',$4,$5,$6,$7,$7,1)`,
        [caseId, reference, input.channel, input.customer_id ?? null, vehicleId, glassRequestId, now]
      );

      await client.query(
        `insert into glass_requests(id, case_id, glass_type, created_at, updated_at)
         values ($1,$2,$3,$4,$4)`,
        [glassRequestId, caseId, input.glass_type, now]
      );

      await client.query(
        `insert into case_events(
          id, case_id, sequence, event_type, occurred_at, actor_type,
          actor_id, payload, corrects_event_id
        ) values ($1,$2,1,'CASE_CREATED',$3,$4,$5,$6::jsonb,null)`,
        [
          randomUUID(),
          caseId,
          now,
          input.actor?.type ?? "RNR_STAFF",
          input.actor?.id ?? null,
          JSON.stringify({
            channel: input.channel,
            vehicle_id: vehicleId,
            glass_request_id: glassRequestId
          })
        ]
      );

      if (input.idempotencyKey) {
        await client.query(
          `insert into case_create_idempotency(idempotency_key, case_id, created_at)
           values ($1,$2,$3)`,
          [input.idempotencyKey, caseId, now]
        );
      }

      await client.query("commit");

      const created = await this.getCase(caseId);
      if (!created) throw new Error("Created case could not be reloaded.");
      return { caseRecord: created, reused: false };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async findStaffByEmail(email: string): Promise<StaffUserRecord | null> {
    const result = await this.pool.query(
      "select * from staff_users where email = $1",
      [email.trim().toLowerCase()]
    );
    return result.rowCount ? staffRow(result.rows[0]) : null;
  }

  async createStaffUser(input: CreateStaffUserInput): Promise<StaffUser> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into staff_users(id, email, name, role, password_hash, channels, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        input.email.trim().toLowerCase(),
        input.name,
        input.role,
        input.passwordHash,
        input.channels ? JSON.stringify(input.channels) : null,
        now
      ]
    );
    const created = await this.findStaffByEmail(input.email);
    if (!created) throw new Error("Staff user could not be reloaded after create.");
    const { password_hash: _hash, ...user } = created;
    return user;
  }

  async createApprovalToken(input: CreateApprovalTokenInput): Promise<{ jti: string }> {
    const jti = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into approval_tokens(jti, case_id, channel, purpose, token_hash, expires_at, consumed_at, created_at)
       values ($1,$2,$3,$4,$5,$6,null,$7)`,
      [jti, input.caseId, input.channel, input.purpose, input.tokenHash, input.expiresAt, now]
    );
    return { jti };
  }

  async findApprovalTokenByHash(tokenHash: string): Promise<ApprovalTokenRecord | null> {
    const result = await this.pool.query(
      "select * from approval_tokens where token_hash = $1",
      [tokenHash]
    );
    return result.rowCount ? approvalTokenRow(result.rows[0]) : null;
  }

  async consumeApprovalToken(jti: string): Promise<void> {
    await this.pool.query(
      `update approval_tokens set consumed_at = now()
       where jti = $1 and consumed_at is null`,
      [jti]
    );
  }

  async appendEvent(input: AppendEventInput): Promise<CaseEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const now = new Date().toISOString();
      const seqResult = await client.query(
        "select coalesce(max(sequence), 0)::int as max_seq from case_events where case_id = $1",
        [input.caseId]
      );
      const sequence = Number(seqResult.rows[0].max_seq) + 1;
      const eventId = randomUUID();
      await client.query(
        `insert into case_events(id, case_id, sequence, event_type, occurred_at,
          actor_type, actor_id, payload, corrects_event_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,null)`,
        [
          eventId,
          input.caseId,
          sequence,
          input.eventType,
          now,
          input.actor.type,
          input.actor.id,
          JSON.stringify(input.payload ?? {})
        ]
      );
      if (input.nextState) {
        await client.query(
          "update cases set current_state = $1, updated_at = $2, version = version + 1 where id = $3",
          [input.nextState, now, input.caseId]
        );
      }
      await client.query("commit");
      // Broadcast AFTER the commit lands: subscribers (staff dashboards)
      // refetch on this signal, so it must never fire for a rolled-back
      // event. A failed notify must not fail the append either — the
      // event is durable; realtime is best-effort on top of it.
      try {
        await client.query("select pg_notify('case_events', $1)", [
          JSON.stringify({
            case_id: input.caseId,
            event_type: input.eventType,
            occurred_at: now,
            sequence
          } satisfies CaseEventNotification)
        ]);
      } catch (notifyError) {
        console.error("case_events pg_notify failed:", notifyError);
      }
      const result = await this.pool.query("select * from case_events where id = $1", [eventId]);
      return eventRow(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One dedicated LISTEN client per store instance, shared by every
   * subscriber. appendEvent's pg_notify (issued by ANY API instance
   * against this database) fans out to all listeners here — that is the
   * cross-instance bus for staff realtime updates.
   */
  async subscribeCaseEvents(
    listener: (notification: CaseEventNotification) => void
  ): Promise<() => void> {
    this.caseEventListeners.add(listener);
    if (!this.listenSetup) {
      this.listenSetup = (async () => {
        const client = await this.pool.connect();
        client.on("notification", (message) => {
          if (message.channel !== "case_events" || !message.payload) return;
          let notification: CaseEventNotification;
          try {
            notification = JSON.parse(message.payload) as CaseEventNotification;
          } catch {
            return;
          }
          for (const current of this.caseEventListeners) {
            try {
              current(notification);
            } catch {
              // A broken subscriber must never break the fan-out.
            }
          }
        });
        client.on("error", (error) => {
          console.error("case_events LISTEN client error:", error);
          // Drop the dead client so the next subscribe re-listens.
          if (this.listenClient === client) {
            this.listenClient = null;
            this.listenSetup = null;
          }
        });
        await client.query("listen case_events");
        this.listenClient = client;
      })();
      // A failed setup clears itself so a later subscribe can retry.
      this.listenSetup.catch(() => {
        this.listenSetup = null;
      });
    }
    await this.listenSetup;
    return () => {
      this.caseEventListeners.delete(listener);
    };
  }

  async saveGlassIdentification(
    input: SaveGlassIdentificationInput
  ): Promise<GlassIdentification> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into glass_identifications(id, case_id, glass_request_id, method, status,
        provider, candidates, selected_candidate, interchange_part_numbers, created_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
      [
        id,
        input.caseId,
        input.glassRequestId,
        input.method,
        input.status,
        input.provider,
        JSON.stringify(input.candidates),
        input.selectedCandidate ? JSON.stringify(input.selectedCandidate) : null,
        JSON.stringify(input.interchangePartNumbers ?? []),
        now
      ]
    );
    const result = await this.pool.query("select * from glass_identifications where id = $1", [id]);
    return glassIdentificationRow(result.rows[0]);
  }

  async getLatestGlassIdentification(
    glassRequestId: string
  ): Promise<GlassIdentification | null> {
    const result = await this.pool.query(
      `select * from glass_identifications
       where glass_request_id = $1 order by created_at desc limit 1`,
      [glassRequestId]
    );
    return result.rowCount ? glassIdentificationRow(result.rows[0]) : null;
  }

  async findVinLookup(vin: string, glassType: GlassType): Promise<VinLookupGlassResult | null> {
    const result = await this.pool.query("select * from vin_lookups where vin = $1", [
      vin.trim().toUpperCase()
    ]);
    if (!result.rowCount) return null;
    const record = vinLookupRow(result.rows[0]);
    const glassTypes = (record.result as { glassTypes?: Partial<Record<GlassType, VinLookupGlassResult>> })
      .glassTypes;
    return glassTypes?.[glassType] ?? null;
  }

  async saveVinLookup(input: SaveVinLookupInput): Promise<void> {
    const normalized = input.vin.trim().toUpperCase();
    // Merge per-glass-type results into the single VIN row in SQL so
    // concurrent saves for different glass types cannot clobber each other.
    await this.pool.query(
      `insert into vin_lookups(id, vin, success, result, created_at)
       values ($1,$2,$3,$4::jsonb,now())
       on conflict (vin) do update set
         success = vin_lookups.success or excluded.success,
         result = jsonb_set(
           coalesce(vin_lookups.result, '{}'::jsonb),
           '{glassTypes}',
           coalesce(vin_lookups.result->'glassTypes', '{}'::jsonb)
             || (excluded.result->'glassTypes'),
           true
         )`,
      [
        randomUUID(),
        normalized,
        input.result.success,
        JSON.stringify({ glassTypes: { [input.glassType]: input.result } })
      ]
    );
  }

  /**
   * Atomic single-flight claim. The INSERT wins outright; on conflict the
   * UPDATE only fires for stale claims (> 5 minutes), so exactly one
   * caller holds a fresh claim. A returned row means we won.
   */
  async claimVinLookup(vin: string, glassType: GlassType): Promise<boolean> {
    const result = await this.pool.query(
      `insert into vin_lookup_claims(vin, glass_type, claimed_at)
       values ($1,$2,now())
       on conflict (vin, glass_type) do update
         set claimed_at = now()
         where vin_lookup_claims.claimed_at < now() - interval '5 minutes'
       returning vin`,
      [vin.trim().toUpperCase(), glassType]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseVinLookup(vin: string, glassType: GlassType): Promise<void> {
    await this.pool.query(
      "delete from vin_lookup_claims where vin = $1 and glass_type = $2",
      [vin.trim().toUpperCase(), glassType]
    );
  }

  /**
   * Atomic cap check + ledger insert in one transaction. The transaction-scoped
   * advisory lock serializes concurrent reservations (the API runs serverless,
   * so an in-process mutex cannot do this), making the read-check-write safe
   * against two paid lookups racing under the cap.
   */
  async reserveVinLookupSpend(input: ReserveVinLookupSpendInput): Promise<ReserveVinLookupSpendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('vin_lookup_spend_cap'))");
      const total = await client.query(
        "select coalesce(sum(cost_cents),0)::int as total from vin_lookup_spend where spent_at >= $1",
        [input.sinceIso]
      );
      const spentCents = total.rows[0]?.total ?? 0;
      if (spentCents + input.costCents > input.capCents) {
        await client.query("rollback");
        return { reserved: false, spendId: null };
      }
      const spendId = randomUUID();
      await client.query(
        `insert into vin_lookup_spend(id, vin, glass_type, cost_cents, provider, spent_at)
         values ($1,$2,$3,$4,$5,now())`,
        [spendId, input.vin.trim().toUpperCase(), input.glassType, input.costCents, input.provider]
      );
      await client.query("commit");
      return { reserved: true, spendId };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseVinLookupSpend(spendId: string): Promise<void> {
    await this.pool.query("delete from vin_lookup_spend where id = $1", [spendId]);
  }

  async getVinLookupSpendCentsSince(sinceIso: string): Promise<number> {
    const result = await this.pool.query(
      "select coalesce(sum(cost_cents),0)::int as total from vin_lookup_spend where spent_at >= $1",
      [sinceIso]
    );
    return result.rows[0]?.total ?? 0;
  }

  async saveSupplierOffer(input: SaveSupplierOfferInput): Promise<SupplierOffer> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into supplier_offers(id, case_id, glass_request_id, supplier_name,
        supplier_type, part_number, price_cents, available, quantity,
        lead_time_days, excluded_reason, selected, is_interchange, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.caseId,
        input.glassRequestId,
        input.supplierName,
        input.supplierType,
        input.partNumber,
        input.priceCents,
        input.available,
        input.quantity,
        input.leadTimeDays,
        input.excludedReason,
        input.selected,
        input.isInterchange,
        now
      ]
    );
    const result = await this.pool.query("select * from supplier_offers where id = $1", [id]);
    return supplierOfferRow(result.rows[0]);
  }

  async listSupplierOffers(glassRequestId: string): Promise<SupplierOffer[]> {
    const result = await this.pool.query(
      `select * from supplier_offers
       where glass_request_id = $1 order by created_at asc`,
      [glassRequestId]
    );
    return result.rows.map(supplierOfferRow);
  }

  async selectSupplierOffer(offerId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(
        "select glass_request_id from supplier_offers where id = $1",
        [offerId]
      );
      if (!found.rowCount) {
        await client.query("rollback");
        return;
      }
      const glassRequestId = found.rows[0].glass_request_id;
      await client.query(
        "update supplier_offers set selected = false where glass_request_id = $1",
        [glassRequestId]
      );
      await client.query(
        "update supplier_offers set selected = true where id = $1",
        [offerId]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async clearSupplierOffers(glassRequestId: string): Promise<void> {
    await this.pool.query(
      "delete from supplier_offers where glass_request_id = $1",
      [glassRequestId]
    );
  }

  async savePriceCalculation(input: SavePriceCalculationInput): Promise<PriceCalculation> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into price_calculations(id, case_id, glass_request_id, selected_offer_id,
        glass_cost_cents, labor_cents, profit_cents, tax_cents, sell_price_cents,
        pricing_config, status, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [
        id,
        input.caseId,
        input.glassRequestId,
        input.selectedOfferId,
        input.glassCostCents,
        input.laborCents,
        input.profitCents,
        input.taxCents,
        input.sellPriceCents,
        JSON.stringify(input.pricingConfig),
        input.status,
        now
      ]
    );
    const result = await this.pool.query("select * from price_calculations where id = $1", [id]);
    return priceCalculationRow(result.rows[0]);
  }

  async getLatestPriceCalculation(glassRequestId: string): Promise<PriceCalculation | null> {
    const result = await this.pool.query(
      `select * from price_calculations
       where glass_request_id = $1 order by created_at desc limit 1`,
      [glassRequestId]
    );
    return result.rowCount ? priceCalculationRow(result.rows[0]) : null;
  }

  async saveQuote(input: SaveQuoteInput): Promise<Quote> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into quotes(id, case_id, version, snapshot, expires_at, status, signature, created_at)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)`,
      [
        id,
        input.caseId,
        input.version,
        JSON.stringify(input.snapshot),
        input.expiresAt,
        input.status,
        null,
        now
      ]
    );
    const result = await this.pool.query("select * from quotes where id = $1", [id]);
    return quoteRow(result.rows[0]);
  }

  async listQuotes(caseId: string): Promise<Quote[]> {
    const result = await this.pool.query(
      "select * from quotes where case_id = $1 order by version asc",
      [caseId]
    );
    return result.rows.map(quoteRow);
  }

  async getLatestQuote(caseId: string): Promise<Quote | null> {
    const result = await this.pool.query(
      "select * from quotes where case_id = $1 order by version desc limit 1",
      [caseId]
    );
    return result.rowCount ? quoteRow(result.rows[0]) : null;
  }

  async signQuote(input: SignQuoteInput): Promise<Quote> {
    // Idempotent: only transition an unsigned quote; a second sign call
    // returns the current record unchanged.
    const result = await this.pool.query(
      `update quotes
       set status = 'APPROVED',
           signature = $2::jsonb
       where id = $1 and status <> 'APPROVED'
       returning *`,
      [
        input.quoteId,
        JSON.stringify({
          name: input.name,
          signed_at: input.signedAt,
          attribution: input.attribution,
          signature_hash: input.signatureHash,
          signature_data_url: input.signatureDataUrl
        })
      ]
    );
    if (!result.rowCount) {
      const current = await this.pool.query("select * from quotes where id = $1", [input.quoteId]);
      if (!current.rowCount) throw new Error("Quote not found.");
      return quoteRow(current.rows[0]);
    }
    return quoteRow(result.rows[0]);
  }

  async updateQuoteStatus(quoteId: string, status: QuoteStatus): Promise<Quote> {
    const result = await this.pool.query(
      "update quotes set status = $2 where id = $1 returning *",
      [quoteId, status]
    );
    if (!result.rowCount) throw new Error("Quote not found.");
    return quoteRow(result.rows[0]);
  }

  async saveInvoice(input: SaveInvoiceInput): Promise<Invoice> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into invoices(id, case_id, version, actuals, created_at)
       values ($1,$2,$3,$4::jsonb,$5)`,
      [
        id,
        input.caseId,
        input.version,
        JSON.stringify(input.actuals),
        now
      ]
    );
    const result = await this.pool.query("select * from invoices where id = $1", [id]);
    return invoiceRow(result.rows[0]);
  }

  async listInvoices(caseId: string): Promise<Invoice[]> {
    const result = await this.pool.query(
      "select * from invoices where case_id = $1 order by version asc",
      [caseId]
    );
    return result.rows.map(invoiceRow);
  }

  async getLatestInvoice(caseId: string): Promise<Invoice | null> {
    const result = await this.pool.query(
      "select * from invoices where case_id = $1 order by version desc limit 1",
      [caseId]
    );
    return result.rowCount ? invoiceRow(result.rows[0]) : null;
  }

  async listStaffUsers(): Promise<StaffUserRecord[]> {
    const result = await this.pool.query(
      "select * from staff_users order by created_at asc"
    );
    return result.rows.map(staffRow);
  }

  async getStaffById(id: string): Promise<StaffUserRecord | null> {
    const result = await this.pool.query("select * from staff_users where id = $1", [id]);
    return result.rowCount ? staffRow(result.rows[0]) : null;
  }

  async createTechProfile(input: CreateTechProfileInput): Promise<TechProfile> {
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into tech_profiles(user_id, status, google_sub, google_refresh_credential, created_at, updated_at)
       values ($1, 'PROFILE_PENDING', $2, $3, $4, $4)`,
      [input.userId, input.googleSub ?? null, input.googleRefreshCredential ?? null, now]
    );
    const created = await this.getTechProfile(input.userId);
    if (!created) throw new Error("Tech profile could not be reloaded after create.");
    return created;
  }

  async getTechProfile(userId: string): Promise<TechProfile | null> {
    const result = await this.pool.query(
      "select * from tech_profiles where user_id = $1",
      [userId]
    );
    return result.rowCount ? techProfileRow(result.rows[0]) : null;
  }

  async listTechProfiles(): Promise<TechProfile[]> {
    const result = await this.pool.query("select * from tech_profiles");
    return result.rows.map(techProfileRow);
  }

  async updateTechProfile(userId: string, patch: TechProfilePatch): Promise<TechProfile> {
    const columns: Record<string, string> = {
      status: "status",
      phone: "phone",
      home_base: "home_base",
      service_area: "service_area",
      claimed_qualifications: "claimed_qualifications",
      qualifications: "qualifications",
      availability: "availability",
      live_status: "live_status",
      location_sharing_consent: "location_sharing_consent",
      google_sub: "google_sub",
      google_refresh_credential: "google_refresh_credential"
    };
    const jsonColumns = new Set(["claimed_qualifications", "qualifications", "availability"]);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      values.push(jsonColumns.has(key) ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${jsonColumns.has(key) ? "::jsonb" : ""}`);
    }
    values.push(new Date().toISOString());
    sets.push(`updated_at = $${values.length}`);
    values.push(userId);
    const result = await this.pool.query(
      `update tech_profiles set ${sets.join(", ")} where user_id = $${values.length} returning *`,
      values
    );
    if (!result.rowCount) throw new Error("Tech profile not found.");
    return techProfileRow(result.rows[0]);
  }

  async createOperatorInvite(input: CreateOperatorInviteInput): Promise<OperatorInvite> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into operator_invites(id, email, credential_hash, invited_by, expires_at, consumed_at, created_at)
       values ($1,$2,$3,$4,$5,null,$6)`,
      [
        id,
        input.email.trim().toLowerCase(),
        input.credentialHash,
        input.invitedBy,
        input.expiresAt,
        now
      ]
    );
    const result = await this.pool.query("select * from operator_invites where id = $1", [id]);
    return operatorInviteRow(result.rows[0]);
  }

  async findOperatorInviteByHash(credentialHash: string): Promise<OperatorInvite | null> {
    const result = await this.pool.query(
      "select * from operator_invites where credential_hash = $1",
      [credentialHash]
    );
    return result.rowCount ? operatorInviteRow(result.rows[0]) : null;
  }

  async findOpenOperatorInviteByEmail(email: string): Promise<OperatorInvite | null> {
    const result = await this.pool.query(
      `select * from operator_invites
       where email = $1 and consumed_at is null
       order by created_at desc limit 1`,
      [email.trim().toLowerCase()]
    );
    return result.rowCount ? operatorInviteRow(result.rows[0]) : null;
  }

  async listOperatorInvites(): Promise<OperatorInvite[]> {
    const result = await this.pool.query(
      "select * from operator_invites order by created_at asc"
    );
    return result.rows.map(operatorInviteRow);
  }

  async consumeOperatorInvite(id: string): Promise<void> {
    await this.pool.query(
      `update operator_invites set consumed_at = now()
       where id = $1 and consumed_at is null`,
      [id]
    );
  }

  async deleteOperatorInvite(id: string): Promise<void> {
    await this.pool.query("delete from operator_invites where id = $1", [id]);
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `insert into jobs(id, case_id, status, assignment_mode, assigned_tech_id,
        scheduled_start, scheduled_end, calendar_event_id, created_at, updated_at)
       values ($1,$2,'UNASSIGNED','DIRECT',null,null,null,null,$3,$3)`,
      [id, input.caseId, now]
    );
    const created = await this.getJob(id);
    if (!created) throw new Error("Job could not be reloaded after create.");
    return created;
  }

  async getJobByCase(caseId: string): Promise<Job | null> {
    const result = await this.pool.query("select * from jobs where case_id = $1", [caseId]);
    return result.rowCount ? jobRow(result.rows[0]) : null;
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.pool.query("select * from jobs where id = $1", [id]);
    return result.rowCount ? jobRow(result.rows[0]) : null;
  }

  async listJobs(): Promise<Job[]> {
    const result = await this.pool.query("select * from jobs");
    return result.rows.map(jobRow);
  }

  async updateJob(id: string, patch: JobPatch): Promise<Job> {
    const columns: Record<string, string> = {
      status: "status",
      assignment_mode: "assignment_mode",
      assigned_tech_id: "assigned_tech_id",
      scheduled_start: "scheduled_start",
      scheduled_end: "scheduled_end",
      calendar_event_id: "calendar_event_id"
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    values.push(new Date().toISOString());
    sets.push(`updated_at = $${values.length}`);
    values.push(id);
    const result = await this.pool.query(
      `update jobs set ${sets.join(", ")} where id = $${values.length} returning *`,
      values
    );
    if (!result.rowCount) throw new Error("Job not found.");
    return jobRow(result.rows[0]);
  }

  async appendJobStepEvent(input: AppendJobStepEventInput): Promise<JobStepEvent> {
    const id = randomUUID();
    const result = await this.pool.query(
      `insert into job_step_events(id, job_id, case_id, step, actor_type, actor_id, payload)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning *`,
      [
        id,
        input.jobId,
        input.caseId,
        input.step,
        input.actor.type,
        input.actor.id,
        JSON.stringify(input.payload ?? {})
      ]
    );
    return jobStepEventRow(result.rows[0]);
  }

  async listJobStepEvents(jobId: string): Promise<JobStepEvent[]> {
    const result = await this.pool.query(
      "select * from job_step_events where job_id = $1 order by occurred_at asc, id asc",
      [jobId]
    );
    return result.rows.map(jobStepEventRow);
  }

  async appendJobLocationPing(
    input: AppendJobLocationPingInput
  ): Promise<JobLocationPing> {
    const id = randomUUID();
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const result = await this.pool.query(
      `insert into job_location_pings(id, job_id, case_id, tech_id, lat, lon, accuracy_m, recorded_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        id,
        input.jobId,
        input.caseId,
        input.techId,
        input.lat,
        input.lon,
        input.accuracyM ?? null,
        recordedAt
      ]
    );
    return jobLocationPingRow(result.rows[0]);
  }

  async listJobLocationPings(jobId: string): Promise<JobLocationPing[]> {
    const result = await this.pool.query(
      "select * from job_location_pings where job_id = $1 order by recorded_at asc, id asc",
      [jobId]
    );
    return result.rows.map(jobLocationPingRow);
  }

  async latestJobLocationPings(): Promise<JobLocationPing[]> {
    const result = await this.pool.query(
      `select distinct on (job_id) *
       from job_location_pings
       order by job_id, recorded_at desc, id desc`
    );
    return result.rows.map(jobLocationPingRow);
  }

  async createCaseAsset(input: CreateCaseAssetInput): Promise<CaseAsset> {
    const id = input.id;
    const result = await this.pool.query(
      `insert into case_assets(id, case_id, job_id, kind, visibility,
        storage_driver, storage_key, filename, content_type, size_bytes,
        status, uploaded_by_type, uploaded_by_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [
        id,
        input.caseId,
        input.jobId,
        input.kind,
        input.visibility,
        input.storageDriver,
        input.storageKey,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.status,
        input.uploadedBy.type,
        input.uploadedBy.id
      ]
    );
    return caseAssetRow(result.rows[0]);
  }

  async getCaseAsset(id: string): Promise<CaseAsset | null> {
    const result = await this.pool.query("select * from case_assets where id = $1", [id]);
    return result.rowCount ? caseAssetRow(result.rows[0]) : null;
  }

  async listCaseAssets(caseId: string): Promise<CaseAsset[]> {
    const result = await this.pool.query(
      "select * from case_assets where case_id = $1 order by created_at asc, id asc",
      [caseId]
    );
    return result.rows.map(caseAssetRow);
  }

  async updateCaseAsset(id: string, patch: CaseAssetPatch): Promise<CaseAsset> {
    const columns: Record<string, string> = {
      status: "status",
      size_bytes: "size_bytes"
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) {
      const existing = await this.getCaseAsset(id);
      if (!existing) throw new Error("Asset not found.");
      return existing;
    }
    values.push(id);
    const result = await this.pool.query(
      `update case_assets set ${sets.join(", ")} where id = $${values.length} returning *`,
      values
    );
    if (!result.rowCount) throw new Error("Asset not found.");
    return caseAssetRow(result.rows[0]);
  }
}
