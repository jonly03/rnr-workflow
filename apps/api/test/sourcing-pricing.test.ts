import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider, type YmmSearchInput } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { calculatePrice, loadPricingConfig } from "../src/pricing.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

const TEST_AUTH_SECRET = "test-secret-for-sourcing-tests";
const VIN_17 = "1HGCM82633A004352";

const PRICING = {
  labor_cents: 12500,
  target_profit_cents: 25000,
  tax_rate: 0.0625
};

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  sourcing: MockSourcingProvider;
  token: string;
  createCase: (overrides?: {
    model?: string;
    make?: string;
    glassType?: GlassType;
    vin?: string;
  }) => request.Test;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-sourcing-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const sourcing = new MockSourcingProvider();
  const app = createApp(
    store,
    { authSecret: TEST_AUTH_SECRET },
    {},
    {
      glassCatalog: new MockGlassCatalogProvider(),
      sourcingProvider: sourcing,
      pricingConfig: PRICING
    }
  );

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

  return { app, store, sourcing, token, createCase };
}

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  request(f.app)
    .post(`/api/v1/cases/${caseId}/actions`)
    .set("Authorization", `Bearer ${f.token}`)
    .send({ action, ...body });

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

describe("Sourcing + Pricing", () => {
  it("auto-sources and auto-prices a standard case on creation", async () => {
    const f = await fixture();
    const res = await f.createCase().expect(201);

    // Full automatic chain: identification → sourcing → pricing.
    expect(res.body.current_state).toBe("PRICE_APPROVED");

    const offers = res.body.supplier_offers as any[];
    expect(offers.length).toBe(4);

    // Regional is excluded even though it is cheapest.
    const regional = offers.find(o => o.supplier_type === "REGIONAL");
    expect(regional.excluded_reason).toMatch(/Regional/);
    expect(regional.selected).toBe(false);

    // Unavailable stock is excluded.
    const unavailable = offers.find(o => o.available === false);
    expect(unavailable.excluded_reason).toMatch(/stock/i);
    expect(unavailable.selected).toBe(false);

    // Cheapest eligible offer wins.
    const selected = offers.find(o => o.selected);
    expect(selected).toBeDefined();
    expect(selected.supplier_type).toBe("NATIONAL");
    const eligiblePrices = offers
      .filter(o => !o.excluded_reason)
      .map(o => o.price_cents);
    expect(selected.price_cents).toBe(Math.min(...eligiblePrices));

    // Pricing snapshot is reproducible.
    const calc = res.body.price_calculation;
    expect(calc.status).toBe("APPROVED");
    expect(calc.glass_cost_cents).toBe(selected.price_cents);
    expect(calc.labor_cents).toBe(12500);
    expect(calc.profit_cents).toBe(25000);
    expect(calc.tax_cents).toBe(Math.round(selected.price_cents * 0.0625));
    expect(calc.sell_price_cents).toBe(
      calc.glass_cost_cents + calc.labor_cents + calc.profit_cents + calc.tax_cents
    );
  });

  it("applies the $250 target profit to cheap glass (no low-cost exception)", async () => {
    // Cheap glass still gets the standard $250 target profit per owner policy.
    const cheapProvider = {
      name: "cheap-mock",
      offerSearches: 0,
      async searchOffers(partNumber: string) {
        this.offerSearches++;
        return [
          {
            supplier_name: "National Glass Supply",
            supplier_type: "NATIONAL" as const,
            part_number: partNumber,
            price_cents: 3000, // $30 — cheap, but policy is $250 profit regardless
            available: true,
            quantity: 5,
            lead_time_days: 2,
            is_interchange: false
          }
        ];
      }
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-cheap-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    await store.createStaffUser({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff",
      passwordHash: await hashPassword("password123")
    });
    const app = createApp(
      store,
      { authSecret: TEST_AUTH_SECRET },
      {},
      {
        glassCatalog: new MockGlassCatalogProvider(),
        sourcingProvider: cheapProvider,
        pricingConfig: PRICING
      }
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
    const token = login.body.token as string;
    const res = await request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Accord", vin: VIN_17 },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);

    expect(res.body.current_state).toBe("PRICE_APPROVED");
    expect(res.body.price_calculation.status).toBe("APPROVED");
    expect(res.body.price_calculation.glass_cost_cents).toBe(3000);
    expect(res.body.price_calculation.profit_cents).toBe(25000); // $250 even for cheap glass
  });

  it("no eligible inventory reaches the manual retry path", async () => {
    // The NOSTOCK hook returns only Regional/unavailable offers.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-nostock-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    await store.createStaffUser({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff",
      passwordHash: await hashPassword("password123")
    });
    // Use a glass catalog that returns a part number containing NOSTOCK.
    class NoStockCatalog extends MockGlassCatalogProvider {
      override async searchYmm(input: YmmSearchInput) {
        const candidates = await super.searchYmm(input);
        return candidates.map(c => ({
          ...c,
          part_number: `${c.part_number}-NOSTOCK`
        }));
      }
    }
    const app = createApp(
      store,
      { authSecret: TEST_AUTH_SECRET },
      {},
      {
        glassCatalog: new NoStockCatalog(),
        sourcingProvider: new MockSourcingProvider(),
        pricingConfig: PRICING
      }
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
    const token = login.body.token as string;
    const created = await request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Accord", vin: VIN_17 },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);

    expect(created.body.current_state).toBe("NO_ELIGIBLE_INVENTORY");
    const offers = created.body.supplier_offers as any[];
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every(o => o.excluded_reason)).toBe(true);
    expect(created.body.price_calculation).toBeNull();

    // Staff can retry sourcing.
    const retried = await request(app)
      .post(`/api/v1/cases/${created.body.id}/actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "retry_sourcing" })
      .expect(200);
    // Still no stock (deterministic mock), so back to NO_ELIGIBLE_INVENTORY.
    expect(retried.body.current_state).toBe("NO_ELIGIBLE_INVENTORY");
  });

  it("re-running sourcing with the same inputs is deterministic", async () => {
    const f = await fixture();
    const first = await f.createCase().expect(201);
    const second = await f.createCase().expect(201);

    const firstSelected = (first.body.supplier_offers as any[]).find(o => o.selected);
    const secondSelected = (second.body.supplier_offers as any[]).find(o => o.selected);
    expect(firstSelected.price_cents).toBe(secondSelected.price_cents);
    expect(firstSelected.supplier_name).toBe(secondSelected.supplier_name);
    expect(first.body.price_calculation.sell_price_cents).toBe(
      second.body.price_calculation.sell_price_cents
    );
  });

  it("calculatePrice applies the pricing formula correctly", () => {
    // $200 glass + $125 labor + $250 profit + 6.25% tax on glass ($12.50).
    const result = calculatePrice({
      glass_cost_cents: 20000,
      labor_cents: 12500,
      profit_cents: 25000,
      tax_rate: 0.0625
    });
    expect(result.tax_cents).toBe(1250);
    expect(result.sell_price_cents).toBe(20000 + 12500 + 25000 + 1250);
    expect(dollars(result.sell_price_cents)).toBe("$587.50");
  });

  it("calculatePrice rounds tax to the nearest cent", () => {
    // $100.08 * 6.25% = $6.255 → rounds to $6.26.
    const result = calculatePrice({
      glass_cost_cents: 10008,
      labor_cents: 12500,
      profit_cents: 25000,
      tax_rate: 0.0625
    });
    expect(result.tax_cents).toBe(626);
    // $100.01 * 6.25% = $6.250625 → rounds to $6.25.
    const result2 = calculatePrice({
      glass_cost_cents: 10001,
      labor_cents: 12500,
      profit_cents: 25000,
      tax_rate: 0.0625
    });
    expect(result2.tax_cents).toBe(625);
  });

  it("excludes offers with malformed prices", async () => {
    const badProvider = {
      name: "bad-mock",
      offerSearches: 0,
      async searchOffers(partNumber: string) {
        this.offerSearches++;
        return [
          {
            supplier_name: "Bad Supplier",
            supplier_type: "NATIONAL" as const,
            part_number: partNumber,
            price_cents: -100, // negative: invalid
            available: true,
            quantity: 5,
            lead_time_days: 2,
            is_interchange: false
          },
          {
            supplier_name: "Good Supplier",
            supplier_type: "NATIONAL" as const,
            part_number: partNumber,
            price_cents: 25000,
            available: true,
            quantity: 5,
            lead_time_days: 2,
            is_interchange: false
          }
        ];
      }
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-badprice-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    await store.createStaffUser({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff",
      passwordHash: await hashPassword("password123")
    });
    const app = createApp(
      store,
      { authSecret: TEST_AUTH_SECRET },
      {},
      {
        glassCatalog: new MockGlassCatalogProvider(),
        sourcingProvider: badProvider,
        pricingConfig: PRICING
      }
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
    const token = login.body.token as string;
    const res = await request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Accord", vin: VIN_17 },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);

    expect(res.body.current_state).toBe("PRICE_APPROVED");
    const offers = res.body.supplier_offers as any[];
    const bad = offers.find(o => o.supplier_name === "Bad Supplier");
    expect(bad.excluded_reason).toMatch(/Invalid.*price/i);
    expect(bad.selected).toBe(false);
    const good = offers.find(o => o.supplier_name === "Good Supplier");
    expect(good.selected).toBe(true);
  });

  it("loadPricingConfig reads env vars with sensible defaults", () => {
    const defaults = loadPricingConfig({});
    expect(defaults).toEqual({
      labor_cents: 12500,
      target_profit_cents: 25000,
      tax_rate: 0.0625
    });
    const custom = loadPricingConfig({
      PRICING_LABOR_CENTS: "15000",
      PRICING_TARGET_PROFIT_CENTS: "22500",
      PRICING_TAX_RATE: "0.07"
    });
    expect(custom).toEqual({
      labor_cents: 15000,
      target_profit_cents: 22500,
      tax_rate: 0.07
    });
  });

  it("rejects invalid pricing actions with clear errors", async () => {
    const f = await fixture();
    const res = await f.createCase().expect(201);
    const caseId = res.body.id as string;
    // Case is already PRICE_APPROVED; approve_price is not legal here.
    const bad = await act(f, caseId, "approve_price").expect(409);
    expect(bad.body.error.code).toBe("INVALID_TRANSITION");
    // retry_sourcing is not legal from PRICE_APPROVED either.
    const bad2 = await act(f, caseId, "retry_sourcing").expect(409);
    expect(bad2.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("prices the primary plus every interchange and picks the cheapest in-stock offer", async () => {
    const f = await fixture();
    // Ambiguous YMM routes to VIN lookup; the mock VIN result carries two
    // interchange part numbers (<primary>-ALT1 / -ALT2).
    const created = await f.createCase({ model: "Ambiguous" }).expect(201);
    expect(created.body.current_state).toBe("VIN_LOOKUP_REQUIRED");

    const res = await act(f, created.body.id, "request_vin_lookup").expect(200);
    expect(res.body.current_state).toBe("PRICE_APPROVED");

    // The identification persists the interchange list for sourcing.
    const identification = res.body.glass_identification;
    expect(identification.method).toBe("VIN");
    expect(identification.interchange_part_numbers).toHaveLength(2);
    const primary = identification.selected_candidate.part_number as string;
    expect(identification.interchange_part_numbers).toEqual([
      `${primary}-ALT1`,
      `${primary}-ALT2`
    ]);

    // One search per part number: primary + both interchanges.
    expect(f.sourcing.offerSearches).toBe(3);

    // 4 mock offers per part number, all persisted with primary/interchange
    // labeling intact.
    const offers = res.body.supplier_offers as any[];
    expect(offers).toHaveLength(12);
    const primaryOffers = offers.filter(o => o.part_number === primary);
    const interchangeOffers = offers.filter(o => o.part_number !== primary);
    expect(primaryOffers).toHaveLength(4);
    expect(interchangeOffers).toHaveLength(8);
    expect(primaryOffers.every((o: any) => o.is_interchange === false)).toBe(true);
    expect(interchangeOffers.every((o: any) => o.is_interchange === true)).toBe(true);

    // Cheapest eligible in-stock offer wins across the whole set. The mock
    // prices interchange parts cheaper than the primary (mirroring real
    // MyGrant), so the system pick is an interchange.
    const selected = offers.find(o => o.selected);
    expect(selected).toBeDefined();
    const eligiblePrices = offers
      .filter(o => !o.excluded_reason)
      .map(o => o.price_cents);
    expect(selected.price_cents).toBe(Math.min(...eligiblePrices));
    expect(selected.is_interchange).toBe(true);
    expect(selected.part_number).not.toBe(primary);

    // Pricing follows the system pick.
    expect(res.body.price_calculation.glass_cost_cents).toBe(selected.price_cents);
  });

  it("falls back to the primary when interchanges have no eligible offers", async () => {
    const f = await fixture();
    // Provider that returns only ineligible offers for interchange parts.
    const picky = new MockSourcingProvider();
    const origSearch = picky.searchOffers.bind(picky);
    picky.searchOffers = async (partNumber: string) => {
      const offers = await origSearch(partNumber);
      if (partNumber.includes("-ALT")) {
        return offers.map(o => ({ ...o, available: false, quantity: 0 }));
      }
      return offers;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-alt-nostock-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    await store.createStaffUser({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff",
      passwordHash: await hashPassword("password123")
    });
    const app = createApp(
      store,
      { authSecret: TEST_AUTH_SECRET },
      {},
      {
        glassCatalog: new MockGlassCatalogProvider(),
        sourcingProvider: picky,
        pricingConfig: PRICING
      }
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
    const token = login.body.token as string;
    const created = await request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Ambiguous", vin: VIN_17 },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);
    const res = await request(app)
      .post(`/api/v1/cases/${created.body.id}/actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "request_vin_lookup" })
      .expect(200);

    const offers = res.body.supplier_offers as any[];
    const selected = offers.find(o => o.selected);
    expect(selected).toBeDefined();
    // All interchange offers are unavailable: the primary still wins.
    expect(selected.is_interchange).toBe(false);
    expect(selected.part_number).toBe(
      res.body.glass_identification.selected_candidate.part_number
    );
  });
});
