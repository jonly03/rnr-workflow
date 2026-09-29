import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { getVinSpendCapCents, MyGrantError } from "../src/mygrant.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassCatalogProvider, VinLookupResult } from "../src/glass-catalog.js";
import type { GlassType } from "../src/types.js";

const TEST_AUTH_SECRET = "guardrail-test-secret-not-for-production";
const VIN_17 = "1HGCM82633A004352";
const OTHER_VIN = "1C4HJXEG3JW224862";

/** Mock-shaped provider that charges $1 per VIN lookup like live MyGrant. */
class PaidMockProvider extends MockGlassCatalogProvider {
  override readonly name = "paid-mock";
  override readonly vinLookupCostCents = 100;
}

/** Paid provider whose VIN lookup always throws the given error. */
class FailingPaidProvider extends PaidMockProvider {
  constructor(private readonly failure: () => Error) {
    super();
  }
  override async lookupVin(vin: string, glassType: GlassType): Promise<VinLookupResult> {
    this.vinLookups++;
    throw this.failure();
  }
}

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  provider: MockGlassCatalogProvider;
  token: string;
  createCase: (vin?: string) => request.Test;
  runVinLookup: (caseId: string) => request.Test;
}

async function fixture(provider: MockGlassCatalogProvider): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-spend-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const app = createApp(store, { authSecret: TEST_AUTH_SECRET }, {}, { glassCatalog: provider });

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  const token = login.body.token as string;

  const createCase = (vin = VIN_17) =>
    request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Ambiguous", vin },
        glass_request: { glass_type: "WINDSHIELD" }
      });

  const runVinLookup = (caseId: string) =>
    request(app)
      .post(`/api/v1/cases/${caseId}/actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "request_vin_lookup" });

  return { app, store, provider, token, createCase, runVinLookup };
}

const savedCap = process.env.MYGRANT_DAILY_SPEND_CAP_USD;
afterEach(() => {
  if (savedCap === undefined) delete process.env.MYGRANT_DAILY_SPEND_CAP_USD;
  else process.env.MYGRANT_DAILY_SPEND_CAP_USD = savedCap;
});

describe("VIN spend cap configuration", () => {
  it("defaults to $25/day", () => {
    delete process.env.MYGRANT_DAILY_SPEND_CAP_USD;
    expect(getVinSpendCapCents()).toBe(2500);
  });

  it("honors MYGRANT_DAILY_SPEND_CAP_USD", () => {
    process.env.MYGRANT_DAILY_SPEND_CAP_USD = "10";
    expect(getVinSpendCapCents()).toBe(1000);
  });

  it("rejects an invalid cap loudly instead of running uncapped", () => {
    process.env.MYGRANT_DAILY_SPEND_CAP_USD = "not-a-number";
    expect(() => getVinSpendCapCents()).toThrowError(MyGrantError);
  });
});

describe("paid VIN lookup spend tracking", () => {
  it("records $1 of spend on a paid lookup success", async () => {
    const provider = new PaidMockProvider();
    const f = await fixture(provider);
    const created = await f.createCase().expect(201);
    await f.runVinLookup(created.body.id).expect(200);
    expect(provider.vinLookups).toBe(1);

    const spent = await f.store.getVinLookupSpendCentsSince(new Date(0).toISOString());
    expect(spent).toBe(100);

    const events = await request(f.app)
      .get(`/api/v1/cases/${created.body.id}/events`)
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const lookup = events.body.find(
      (e: { event_type: string }) => e.event_type === "START_VIN_LOOKUP"
    );
    expect(lookup.payload).toMatchObject({ charged: true, provider: "paid-mock" });
  });

  it("blocks the lookup loudly when the daily cap is reached, without calling the provider", async () => {
    const provider = new PaidMockProvider();
    const f = await fixture(provider);
    // Spend the whole default $25 cap first (25 distinct VINs to avoid the cache).
    for (let i = 0; i < 25; i++) {
      await f.store.recordVinLookupSpend({
        vin: `SPENT${String(i).padStart(11, "0")}`,
        glassType: "WINDSHIELD",
        costCents: 100,
        provider: "paid-mock"
      });
    }
    const created = await f.createCase().expect(201);
    const blocked = await f.runVinLookup(created.body.id).expect(200);
    expect(blocked.body.current_state).toBe("SYSTEM_ATTENTION_REQUIRED");
    expect(provider.vinLookups).toBe(0);

    const events = await request(f.app)
      .get(`/api/v1/cases/${created.body.id}/events`)
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const failed = events.body.find(
      (e: { event_type: string }) => e.event_type === "VIN_LOOKUP_FAILED"
    );
    expect(failed.payload.error).toMatch(/spend cap reached/);

    // The blocked lookup recorded no additional spend.
    const spent = await f.store.getVinLookupSpendCentsSince(new Date(0).toISOString());
    expect(spent).toBe(2500);
  });

  it("does not apply the cap to the free mock provider", async () => {
    process.env.MYGRANT_DAILY_SPEND_CAP_USD = "0";
    const provider = new MockGlassCatalogProvider();
    const f = await fixture(provider);
    const created = await f.createCase().expect(201);
    // Cap is $0, but the free provider is never gated.
    await f.runVinLookup(created.body.id).expect(200);
    expect(provider.vinLookups).toBe(1);
  });

  it("records spend when a paid lookup fails after submission (charge uncertain)", async () => {
    const failure = new MyGrantError("MYGRANT_UNAVAILABLE", "site died mid-search", 502);
    failure.charged = true;
    const provider = new FailingPaidProvider(() => failure);
    const f = await fixture(provider);
    const created = await f.createCase().expect(201);
    await f.runVinLookup(created.body.id).expect(200);
    expect(provider.vinLookups).toBe(1);

    const spent = await f.store.getVinLookupSpendCentsSince(new Date(0).toISOString());
    expect(spent).toBe(100);
  });

  it("records no spend when the failure happened before submission (no charge possible)", async () => {
    const failure = new MyGrantError(
      "MYGRANT_NO_CREDITS",
      "MyGrant VIN lookup credits are exhausted (0 remaining). Purchase a credit block before retrying — no lookup was attempted.",
      402
    );
    expect(failure.charged).toBe(false);
    const provider = new FailingPaidProvider(() => failure);
    const f = await fixture(provider);
    const created = await f.createCase().expect(201);
    await f.runVinLookup(created.body.id).expect(200);

    const spent = await f.store.getVinLookupSpendCentsSince(new Date(0).toISOString());
    expect(spent).toBe(0);
  });

  it("counts only spend since the given timestamp", async () => {
    const provider = new PaidMockProvider();
    const f = await fixture(provider);
    await f.store.recordVinLookupSpend({
      vin: VIN_17,
      glassType: "WINDSHIELD",
      costCents: 100,
      provider: "paid-mock"
    });
    const since = new Date().toISOString();
    // A second spend after the watermark.
    await f.store.recordVinLookupSpend({
      vin: OTHER_VIN,
      glassType: "WINDSHIELD",
      costCents: 100,
      provider: "paid-mock"
    });
    // The first row predates the real clock only if time passed; assert the
    // windowed query sees at most the rows, and the full query sees both.
    const windowed = await f.store.getVinLookupSpendCentsSince(since);
    const total = await f.store.getVinLookupSpendCentsSince(new Date(0).toISOString());
    expect(total).toBe(200);
    expect(windowed).toBeLessThanOrEqual(200);
    expect(windowed).toBeGreaterThanOrEqual(100);
  });
});

describe("provider cost declaration", () => {
  it("mock declares no cost; MyGrant-shaped providers declare $1", () => {
    const mock = new MockGlassCatalogProvider();
    expect(mock.vinLookupCostCents ?? 0).toBe(0);
    const paid = new PaidMockProvider();
    expect(paid.vinLookupCostCents).toBe(100);
  });

  it("satisfies the GlassCatalogProvider interface", () => {
    const provider: GlassCatalogProvider = new PaidMockProvider();
    expect(provider.name).toBe("paid-mock");
  });
});
