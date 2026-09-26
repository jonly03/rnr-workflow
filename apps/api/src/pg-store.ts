import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  CaseEvent,
  CaseRecord,
  GlassRequest,
  StaffUser,
  StaffUserRecord,
  Vehicle
} from "./types.js";
import type {
  CaseStore,
  CreateCaseStoreInput,
  CreateStaffUserInput
} from "./store.js";

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
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    password_hash: row.password_hash,
    created_at: iso(row.created_at)
  };
}

export class PgCaseStore implements CaseStore {
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
      `insert into staff_users(id, email, name, role, password_hash, created_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [id, input.email.trim().toLowerCase(), input.name, input.role, input.passwordHash, now]
    );
    const created = await this.findStaffByEmail(input.email);
    if (!created) throw new Error("Staff user could not be reloaded after create.");
    const { password_hash: _hash, ...user } = created;
    return user;
  }
}
