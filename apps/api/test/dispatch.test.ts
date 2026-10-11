import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { DEMO_TECH_EMAIL, DEMO_TECH_PASSWORD } from "../src/dispatch.js";
import { JsonCaseStore } from "../src/store.js";

const TEST_AUTH_SECRET = "dispatch-test-secret";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-dispatch-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    passwordHash: await hashPassword("password123")
  });
  const app = createApp(store, { authSecret: TEST_AUTH_SECRET });

  const loginAs = async (email: string, password: string) => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password })
      .expect(200);
    const header = `Bearer ${login.body.token as string}`;
    return {
      get: (url: string) => request(app).get(url).set("Authorization", header),
      post: (url: string) =>
        request(app).post(url).set("Authorization", header),
      staffId: login.body.staff.id as string
    };
  };

  const admin = await loginAs("admin@example.com", "password123");
  return { store, app, admin, loginAs };
}

async function seedDay(admin: { get: (u: string) => request.Test }) {
  const res = await admin.get("/api/v1/dispatch/today").expect(200);
  return res.body.appointments as Array<{ case_id: string; case_ref: string; status: string }>;
}

describe("Dispatch tracking (Phase 4b)", () => {
  it("seeds the demo day idempotently", async () => {
    const { admin } = await fixture();
    const first = await seedDay(admin);
    expect(first).toHaveLength(3);
    const second = await seedDay(admin);
    expect(second).toHaveLength(3);
    expect(second.map(a => a.case_id).sort()).toEqual(
      first.map(a => a.case_id).sort()
    );
  });

  it("returns map-ready appointments with pins and tech info", async () => {
    const { admin } = await fixture();
    const appointments = await seedDay(admin);
    for (const a of appointments) {
      expect(a.case_ref).toMatch(/^RRA-\d{6}$/);
      expect(a.status).toBe("SCHEDULED");
    }
    const res = await admin.get("/api/v1/dispatch/today").expect(200);
    const pin = res.body.appointments[0];
    expect(pin).toMatchObject({
      status: "SCHEDULED",
      tech: { name: "Demo Tech" }
    });
    expect(typeof pin.lat).toBe("number");
    expect(typeof pin.lng).toBe("number");
    expect(pin.address).toContain("Worcester");
  });

  it("blocks technicians from the dispatcher map, allows my-jobs", async () => {
    const { admin, loginAs } = await fixture();
    await seedDay(admin);
    const tech = await loginAs(DEMO_TECH_EMAIL, DEMO_TECH_PASSWORD);
    await tech.get("/api/v1/dispatch/today").expect(403);
    const mine = await tech.get("/api/v1/dispatch/my-jobs").expect(200);
    expect(mine.body.appointments).toHaveLength(3);
  });

  it("advances SCHEDULED -> EN_ROUTE -> ARRIVED -> COMPLETE", async () => {
    const { admin, loginAs } = await fixture();
    const [first] = await seedDay(admin);
    const tech = await loginAs(DEMO_TECH_EMAIL, DEMO_TECH_PASSWORD);

    const enRoute = await tech
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_en_route" })
      .expect(200);
    expect(enRoute.body.appointment.status).toBe("EN_ROUTE");

    // Illegal skip: cannot complete from EN_ROUTE.
    await tech
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_complete" })
      .expect(409);

    await tech
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_arrived" })
      .expect(200);
    const done = await tech
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_complete" })
      .expect(200);
    expect(done.body.appointment.status).toBe("COMPLETE");

    // Terminal: no further transitions.
    await tech
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_en_route" })
      .expect(409);

    const events = await admin
      .get(`/api/v1/cases/${first.case_id}/events`)
      .expect(200);
    const types = events.body.map((e: { event_type: string }) => e.event_type);
    expect(types).toContain("TECH_EN_ROUTE");
    expect(types).toContain("TECH_ARRIVED");
    expect(types).toContain("JOB_COMPLETE");
  });

  it("rejects illegal transitions with a clear code", async () => {
    const { admin, loginAs } = await fixture();
    const [first] = await seedDay(admin);
    const tech = await loginAs(DEMO_TECH_EMAIL, DEMO_TECH_PASSWORD);
    const res = await tech
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_arrived" })
      .expect(409);
    expect(res.body.error.code).toBe("ILLEGAL_TRACKING_TRANSITION");
  });

  it("stops a technician from moving another tech's job", async () => {
    const { store, admin, loginAs } = await fixture();
    const [first] = await seedDay(admin);
    await store.createStaffUser({
      email: "other-tech@example.com",
      name: "Other Tech",
      role: "technician",
      passwordHash: await hashPassword("password123")
    });
    const other = await loginAs("other-tech@example.com", "password123");
    const res = await other
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_en_route" })
      .expect(403);
    expect(res.body.error.code).toBe("NOT_YOUR_JOB");
  });

  it("lets staff advance on a tech's behalf", async () => {
    const { admin } = await fixture();
    const [first] = await seedDay(admin);
    const res = await admin
      .post(`/api/v1/cases/${first.case_id}/actions`)
      .send({ action: "tech_en_route" })
      .expect(200);
    expect(res.body.appointment.status).toBe("EN_ROUTE");
    expect(res.body.appointment.technician_id).toBeTruthy();
  });

  it("404s tracking actions on cases with no appointment", async () => {
    const { admin } = await fixture();
    const create = await admin
      .post("/api/v1/cases")
      .send({
        channel: "DIRECT",
        vehicle: { year: 2019, make: "Subaru", model: "Outback", vin: "4S4BSAFCXK3123456" },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);
    const res = await admin
      .post(`/api/v1/cases/${create.body.id}/actions`)
      .send({ action: "tech_en_route" })
      .expect(404);
    expect(res.body.error.code).toBe("APPOINTMENT_NOT_FOUND");
  });

  it("mints a client tracking link", async () => {
    const { admin } = await fixture();
    const [first] = await seedDay(admin);

    const minted = await admin
      .post(`/api/v1/cases/${first.case_id}/tracking-link`)
      .expect(200);
    expect(minted.body.tracking_token).toMatch(/^rnappr_/);
    expect(minted.body.tracking_url).toContain("?track=");
    expect(minted.body.expires_at).toBeTruthy();
  });

  it("serves the client timeline and hides staff-only data", async () => {
    const { app, admin, loginAs } = await fixture();
    const [first] = await seedDay(admin);
    const tech = await loginAs(DEMO_TECH_EMAIL, DEMO_TECH_PASSWORD);
    await tech.post(`/api/v1/cases/${first.case_id}/actions`).send({ action: "tech_en_route" }).expect(200);
    await tech.post(`/api/v1/cases/${first.case_id}/actions`).send({ action: "tech_arrived" }).expect(200);

    const minted = await admin
      .post(`/api/v1/cases/${first.case_id}/tracking-link`)
      .expect(200);
    const tracked = await request(app)
      .get(`/api/v1/track/${minted.body.tracking_token}`)
      .expect(200);

    expect(tracked.body.case_ref).toBe(first.case_ref);
    expect(tracked.body.status).toBe("ARRIVED");
    expect(tracked.body.tech_name).toBe("Demo Tech");
    const stages = Object.fromEntries(
      tracked.body.timeline.map((t: { stage: string; at: string | null }) => [t.stage, t.at])
    );
    expect(stages.confirmed).toBeTruthy();
    expect(stages.en_route).toBeTruthy();
    expect(stages.arrived).toBeTruthy();
    expect(stages.done).toBeNull();

    const raw = JSON.stringify(tracked.body).toLowerCase();
    expect(raw).not.toContain("sell_price");
    expect(raw).not.toContain("profit");
    expect(raw).not.toContain("supplier");

    // Read-only: the token still verifies after reads (never consumed).
    await request(app).get(`/api/v1/track/${minted.body.tracking_token}`).expect(200);
  });

  it("404s unknown tracking tokens", async () => {
    const { app } = await fixture();
    await request(app).get("/api/v1/track/rnappr_doesnotexist").expect(404);
  });
});
