import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

const TEST_AUTH_SECRET = "test-secret-for-glass-tests";

const VIN_17 = "1HGCM82633A004352";

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  provider: MockGlassCatalogProvider;
  token: string;
  createCase: (overrides?: {
    model?: string;
    make?: string;
    glassType?: GlassType;
    vin?: string;
  }) => request.Test;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-glass-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const provider = new MockGlassCatalogProvider();
  const app = createApp(store, { authSecret: TEST_AUTH_SECRET }, {}, { glassCatalog: provider });

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  const token = login.body.token as string;

  const createCase = (overrides: { model?: string; make?: string; glassType?: GlassType; vin?: string } = {}) =>
    request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: {
          year: 2020,
          make: overrides.make ?? "Honda",
          model: overrides.model ?? "Accord",
          vin: overrides.vin ?? VIN_17
        },
        glass_request: { glass_type: overrides.glassType ?? "WINDSHIELD" }
      });

  return { app, store, provider, token, createCase };
}

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  request(f.app)
    .post(`/api/v1/cases/${caseId}/actions`)
    .set("Authorization", `Bearer ${f.token}`)
    .send({ action, ...body });

describe("Glass Identification", () => {
  it("auto-identifies a single-candidate case on creation", async () => {
    const f = await fixture();
    const res = await f.createCase().expect(201);

    expect(res.body.current_state).toBe("GLASS_IDENTIFIED");
    expect(res.body.glass_identification).toMatchObject({
      method: "YMM",
      status: "RESOLVED",
      provider: "mock-catalog"
    });
    expect(res.body.glass_identification.candidates).toHaveLength(1);
    expect(res.body.glass_identification.selected_candidate.part_number).toBe(
      res.body.glass_identification.candidates[0].part_number
    );

    // The audit trail shows the YMM search and evaluation.
    const events = await request(f.app)
      .get(`/api/v1/cases/${res.body.id}/events`)
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const types = events.body.map((e: { event_type: string }) => e.event_type);
    expect(types).toContain("YMM_RESULTS_RETURNED");
    expect(types).toContain("GLASS_RESOLVED");
  });

  it("routes ambiguous windshields to VIN lookup", async () => {
    const f = await fixture();
    const res = await f.createCase({ model: "Ambiguous" }).expect(201);

    expect(res.body.current_state).toBe("VIN_LOOKUP_REQUIRED");
    expect(res.body.glass_identification.status).toBe("AMBIGUOUS");
    expect(res.body.glass_identification.candidates).toHaveLength(3);
    expect(res.body.glass_identification.selected_candidate).toBeNull();
  });

  it("resolves via VIN lookup and records the charge", async () => {
    const f = await fixture();
    const created = await f.createCase({ model: "Ambiguous" }).expect(201);

    const res = await act(f, created.body.id, "request_vin_lookup").expect(200);
    expect(res.body.current_state).toBe("GLASS_IDENTIFIED");
    expect(res.body.glass_identification).toMatchObject({ method: "VIN", status: "RESOLVED" });
    expect(f.provider.vinLookups).toBe(1);

    const events = await request(f.app)
      .get(`/api/v1/cases/${created.body.id}/events`)
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const lookup = events.body.find(
      (e: { event_type: string }) => e.event_type === "START_VIN_LOOKUP"
    );
    expect(lookup.payload.charged).toBe(true);
  });

  it("reuses a saved successful VIN result instead of repurchasing", async () => {
    const f = await fixture();
    const first = await f.createCase({ model: "Ambiguous" }).expect(201);
    await act(f, first.body.id, "request_vin_lookup").expect(200);
    expect(f.provider.vinLookups).toBe(1);

    // Second case, same VIN: the provider must not be called again.
    const second = await f.createCase({ model: "Ambiguous" }).expect(201);
    expect(second.body.current_state).toBe("VIN_LOOKUP_REQUIRED");
    const res = await act(f, second.body.id, "request_vin_lookup").expect(200);
    expect(res.body.current_state).toBe("GLASS_IDENTIFIED");
    expect(f.provider.vinLookups).toBe(1);

    const events = await request(f.app)
      .get(`/api/v1/cases/${second.body.id}/events`)
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const reuse = events.body.find(
      (e: { event_type: string }) => e.event_type === "USE_SAVED_VIN_RESULT"
    );
    expect(reuse.payload).toMatchObject({ cached: true, charged: false });
  });

  it("never offers VIN lookup for Door glass: ambiguous door glass goes to human review", async () => {
    const f = await fixture();
    const res = await f
      .createCase({ model: "Ambiguous", glassType: "DOOR_GLASS" })
      .expect(201);

    expect(res.body.current_state).toBe("HUMAN_GLASS_REVIEW_REQUIRED");

    const denied = await act(f, res.body.id, "request_vin_lookup").expect(409);
    expect(denied.body.error.code).toBe("VIN_NOT_ELIGIBLE");
    expect(f.provider.vinLookups).toBe(0);
  });

  it("lets staff resolve human review by selecting a candidate", async () => {
    const f = await fixture();
    const res = await f
      .createCase({ model: "Ambiguous", glassType: "DOOR_GLASS" })
      .expect(201);
    const partNumber = res.body.glass_identification.candidates[1].part_number;

    const selected = await act(f, res.body.id, "select_glass_candidate", {
      part_number: partNumber
    }).expect(200);
    expect(selected.body.current_state).toBe("GLASS_IDENTIFIED");
    expect(selected.body.glass_identification.selected_candidate.part_number).toBe(partNumber);
    expect(selected.body.glass_identification.status).toBe("RESOLVED");
  });

  it("rejects selecting a part number that was not identified", async () => {
    const f = await fixture();
    const res = await f
      .createCase({ model: "Ambiguous", glassType: "DOOR_GLASS" })
      .expect(201);

    const denied = await act(f, res.body.id, "select_glass_candidate", {
      part_number: "NOPE-123"
    }).expect(422);
    expect(denied.body.error.code).toBe("INVALID_CANDIDATE");
  });

  it("marks unidentifiable glass and allows retry", async () => {
    const f = await fixture();
    const res = await f.createCase({ make: "Unknown" }).expect(201);
    expect(res.body.current_state).toBe("GLASS_NOT_IDENTIFIED");

    // Retry re-runs identification (still nothing in the mock catalog).
    const retried = await act(f, res.body.id, "retry_identification").expect(200);
    expect(retried.body.current_state).toBe("GLASS_NOT_IDENTIFIED");
    expect(f.provider.ymmSearches).toBe(2);
  });

  it("lets staff record that human-reviewed glass cannot be identified", async () => {
    const f = await fixture();
    const res = await f
      .createCase({ model: "Ambiguous", glassType: "QUARTER_GLASS" })
      .expect(201);
    expect(res.body.current_state).toBe("HUMAN_GLASS_REVIEW_REQUIRED");

    const done = await act(f, res.body.id, "mark_glass_unidentifiable").expect(200);
    expect(done.body.current_state).toBe("GLASS_NOT_IDENTIFIED");
  });

  it("rejects VIN lookup from the wrong state and rejects short VINs", async () => {
    const f = await fixture();
    const identified = await f.createCase().expect(201);
    const wrongState = await act(f, identified.body.id, "request_vin_lookup").expect(409);
    expect(wrongState.body.error.code).toBe("VIN_NOT_ELIGIBLE");

    const shortVin = await f.createCase({ model: "Ambiguous", vin: "SHORT" }).expect(201);
    expect(shortVin.body.current_state).toBe("VIN_LOOKUP_REQUIRED");
    const badVin = await act(f, shortVin.body.id, "request_vin_lookup").expect(422);
    expect(badVin.body.error.code).toBe("VIN_NOT_ELIGIBLE");
    expect(f.provider.vinLookups).toBe(0);
  });

  it("rejects unknown actions with 409 as before", async () => {
    const f = await fixture();
    const res = await f.createCase().expect(201);
    const denied = await act(f, res.body.id, "order_snacks").expect(409);
    expect(denied.body.error.code).toBe("ACTION_NOT_ALLOWED");
  });
});
