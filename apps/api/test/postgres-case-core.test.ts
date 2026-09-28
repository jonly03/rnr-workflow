import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { createStore } from "../src/store-factory.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("Case Core PostgreSQL adapter", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    process.env.DATABASE_SSL_MODE = "disable";
    const pool = createPool(url!);
    await pool.query(
      "truncate table case_create_idempotency, case_events, glass_identifications, vin_lookups, approval_tokens, glass_requests, cases, vehicles, customers, staff_users restart identity cascade"
    );
    const seedPool = createPool(url!);
    const seedStore = new (await import("../src/pg-store.js")).PgCaseStore(seedPool);
    await seedStore.createStaffUser({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff",
      passwordHash: await hashPassword("password123")
    });
    await seedPool.end();
    await pool.end();
  });

  const authedApp = async () => {
    const app = createApp(createStore(), { authSecret: "test-secret" });
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
    const token = login.body.token as string;
    return {
      get: (url: string) =>
        request(app).get(url).set("Authorization", `Bearer ${token}`),
      post: (url: string) =>
        request(app).post(url).set("Authorization", `Bearer ${token}`)
    };
  };

  it("persists a Case and event across store instances", async () => {
    const app = await authedApp();
    const input = {
      channel: "DIRECT",
      vehicle: {
        year: 2018,
        make: "Jeep",
        model: "Wrangler",
        vin: "1C4HJXEG3JW224862"
      },
      glass_request: { glass_type: "WINDSHIELD" }
    };

    const created = await app
      .post("/api/v1/cases")
      .set("Idempotency-Key", "pg-e2e-001")
      .send(input)
      .expect(201);

    // Phase 2: identification auto-runs after intake (single candidate here).
    // Phase 3: sourcing + pricing auto-advance to PRICE_APPROVED.
    expect(created.body.current_state).toBe("PRICE_APPROVED");

    const restartedApp = await authedApp();

    const detail = await restartedApp
      .get(`/api/v1/cases/${created.body.id}`)
      .expect(200);

    expect(detail.body.reference).toBe(created.body.reference);
    expect(detail.body.vehicle.vin).toBe(input.vehicle.vin);
    expect(detail.body.glass_identification).toMatchObject({
      method: "YMM",
      status: "RESOLVED"
    });

    const events = await restartedApp
      .get(`/api/v1/cases/${created.body.id}/events`)
      .expect(200);

    // Phase 2: CASE_CREATED + identification events.
    // Phase 3: sourcing + pricing auto-advance adds 6 more events (11 total).
    expect(events.body).toHaveLength(11);
    expect(events.body[0]).toMatchObject({
      sequence: 1,
      event_type: "CASE_CREATED"
    });
  });

  it("reuses an idempotency key instead of duplicating a Case", async () => {
    const app = await authedApp();
    const input = {
      channel: "AUCTION",
      vehicle: {
        year: 2020,
        make: "Toyota",
        model: "Camry",
        vin: "4T1G11AK0LU000001"
      },
      glass_request: { glass_type: "BACK_GLASS" }
    };

    const first = await app
      .post("/api/v1/cases")
      .set("Idempotency-Key", "pg-idempotent-001")
      .send(input)
      .expect(201);

    const second = await app
      .post("/api/v1/cases")
      .set("Idempotency-Key", "pg-idempotent-001")
      .send(input)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
  });
});
