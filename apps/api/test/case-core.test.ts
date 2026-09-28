import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { JsonCaseStore } from "../src/store.js";

const TEST_AUTH_SECRET = "test-secret-for-auth-tests";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-case-core-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const app = createApp(store, { authSecret: TEST_AUTH_SECRET });

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);

  const authHeader = `Bearer ${login.body.token as string}`;
  const authed = {
    get: (url: string) => request(app).get(url).set("Authorization", authHeader),
    post: (url: string) =>
      request(app).post(url).set("Authorization", authHeader)
  };
  return { store, app, authed, staffId: login.body.staff.id as string };
}

const input = {
  channel: "DIRECT",
  vehicle: {
    year: 2018,
    make: "Jeep",
    model: "Wrangler",
    vin: "1C4HJXEG3JW224862"
  },
  glass_request: {
    glass_type: "WINDSHIELD"
  }
};

describe("Case Core API", () => {
  it("creates one canonical Case and durable CASE_CREATED event", async () => {
    const { app, authed, staffId } = await fixture();
    const create = await authed.post("/api/v1/cases").send(input).expect(201);

    expect(create.body.reference).toMatch(/^RRA-\d{6}$/);
    // Phase 2: identification auto-runs after intake (single candidate here).
    expect(create.body.current_state).toBe("GLASS_IDENTIFIED");
    expect(create.body.channel).toBe("DIRECT");
    expect(create.body.vehicle.vin).toBe(input.vehicle.vin);

    const events = await authed
      .get(`/api/v1/cases/${create.body.id}/events`)
      .expect(200);

    // Phase 2: CASE_CREATED plus the automatic identification event trail.
    expect(events.body).toHaveLength(5);
    expect(events.body[0]).toMatchObject({
      sequence: 1,
      event_type: "CASE_CREATED",
      actor_type: "RNR_STAFF",
      actor_id: staffId
    });
    const types = events.body.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual([
      "CASE_CREATED",
      "START_IDENTIFICATION",
      "YMM_RESULTS_RETURNED",
      "EVALUATE_GLASS_MATCHES",
      "GLASS_RESOLVED"
    ]);
  });

  it("persists DIRECT, AUCTION and INSURANCE through one model", async () => {
    const { app, authed } = await fixture();
    for (const channel of ["DIRECT", "AUCTION", "INSURANCE"]) {
      await authed.post("/api/v1/cases").send({ ...input, channel }).expect(201);
    }

    const list = await authed.get("/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(3);
    expect(new Set(list.body.map((c: any) => c.channel))).toEqual(
      new Set(["DIRECT", "AUCTION", "INSURANCE"])
    );
  });

  it("guards duplicate create submission with Idempotency-Key", async () => {
    const { app, authed } = await fixture();
    const first = await authed
      .post("/api/v1/cases")
      .set("Idempotency-Key", "create-123")
      .send(input)
      .expect(201);

    const second = await authed
      .post("/api/v1/cases")
      .set("Idempotency-Key", "create-123")
      .send(input)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);

    const list = await authed.get("/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("does not allow arbitrary/unimplemented state actions", async () => {
    const { app, authed } = await fixture();
    const create = await authed.post("/api/v1/cases").send(input).expect(201);

    await authed
      .post(`/api/v1/cases/${create.body.id}/actions`)
      .send({ action: "SET_STATE", input: { state: "COMPLETED" } })
      .expect(409);

    const detail = await authed.get(`/api/v1/cases/${create.body.id}`).expect(200);
    // Phase 2: arbitrary actions stay rejected; state is the identified one.
    expect(detail.body.current_state).toBe("GLASS_IDENTIFIED");
  });

  it("returns validation errors without persisting partial data", async () => {
    const { app, authed } = await fixture();
    await authed
      .post("/api/v1/cases")
      .send({ ...input, vehicle: { ...input.vehicle, vin: "" } })
      .expect(422);

    const list = await authed.get("/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(0);
  });
});
