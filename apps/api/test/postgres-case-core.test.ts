import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
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
      "truncate table case_create_idempotency, case_events, glass_requests, cases, vehicles, customers restart identity cascade"
    );
    await pool.end();
  });

  it("persists a Case and event across store instances", async () => {
    const app = createApp(createStore());
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

    const created = await request(app)
      .post("/api/v1/cases")
      .set("Idempotency-Key", "pg-e2e-001")
      .send(input)
      .expect(201);

    expect(created.body.current_state).toBe("REQUEST_RECEIVED");

    const restartedApp = createApp(createStore());

    const detail = await request(restartedApp)
      .get(`/api/v1/cases/${created.body.id}`)
      .expect(200);

    expect(detail.body.reference).toBe(created.body.reference);
    expect(detail.body.vehicle.vin).toBe(input.vehicle.vin);

    const events = await request(restartedApp)
      .get(`/api/v1/cases/${created.body.id}/events`)
      .expect(200);

    expect(events.body).toHaveLength(1);
    expect(events.body[0]).toMatchObject({
      sequence: 1,
      event_type: "CASE_CREATED"
    });
  });

  it("reuses an idempotency key instead of duplicating a Case", async () => {
    const app = createApp(createStore());
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

    const first = await request(app)
      .post("/api/v1/cases")
      .set("Idempotency-Key", "pg-idempotent-001")
      .send(input)
      .expect(201);

    const second = await request(app)
      .post("/api/v1/cases")
      .set("Idempotency-Key", "pg-idempotent-001")
      .send(input)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
  });
});
