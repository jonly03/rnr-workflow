import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

/**
 * Intake live progress (Nelly, 2026-10-20): the customer who submitted
 * the QR intake watches their request move — a client-safe progress
 * projection behind their intake-status token — and the "Request
 * received" page is complete when it hands them the URL of the quote
 * they can sign. Signing carries the staff flow to the "Order parts"
 * stage (invoice auto-generated, fulfillment unlocked).
 */

const TEST_AUTH_SECRET = "<redacted>";
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };

interface Fixture {
  app: ReturnType<typeof createApp>;
  token: string;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-intake-status-"));
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
      sourcingProvider: new MockSourcingProvider(),
      pricingConfig: PRICING,
      quotingConfig: { expiry_hours: 72 }
    }
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  return { app, token: login.body.token as string };
}

const staff = (f: Fixture) => ({
  post: (url: string) => request(f.app).post(url).set("Authorization", `Bearer ${f.token}`),
  get: (url: string) => request(f.app).get(url).set("Authorization", `Bearer ${f.token}`)
});

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  staff(f).post(`/api/v1/cases/${caseId}/actions`).send({ action, ...body });

const signatureDataUrl = (bytes = 1024) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

/** Submits an intake the mock catalog resolves to a single candidate. */
async function simpleIntake(f: Fixture, model = "Accord", glassType: GlassType = "WINDSHIELD") {
  const res = await request(f.app)
    .post("/api/v1/public/intake")
    .send({
      customer_name: "Jane Customer",
      customer_phone: "(617) 555-0142",
      glass_type: glassType,
      vin: VIN_17,
      year: 2020,
      make: "Honda",
      model,
      service_address: {
        place_id: "mock:terrace-118",
        formatted: "118 Terrace St, Boston, MA 02120",
        street: "118 Terrace St",
        city: "Boston",
        state: "Massachusetts",
        zip: "02120",
        lat: 42.3349,
        lon: -71.0828
      }
    })
    .expect(201);
  expect(res.body.status_token).toMatch(/^rnappr_/);
  return res.body as { reference: string; status_token: string };
}

const statusOf = (f: Fixture, token: string) =>
  request(f.app).get(`/api/v1/public/intake-status/${token}`);

describe("Intake live progress (status token + quote URL)", () => {
  it("an auto-driven intake is already quote-ready on the first poll, leak-free", async () => {
    const f = await fixture();
    const { reference, status_token } = await simpleIntake(f);

    const res = await statusOf(f, status_token).expect(200);
    expect(res.body.reference).toBe(reference);
    expect(res.body.vehicle).toEqual({ year: 2020, make: "Honda", model: "Accord" });
    expect(res.body.phase).toBe("quote_ready");
    expect(res.body.quote_ready).toBe(true);
    expect(res.body.headline).toContain("quote is ready");
    const byKey = Object.fromEntries(res.body.steps.map((s: any) => [s.key, s.done]));
    expect(byKey).toEqual({ received: true, glass: true, pricing: true, quote: true });

    // Projection law: no internal state names, no economics, no suppliers.
    const raw = JSON.stringify(res.body);
    for (const forbidden of [
      "current_state",
      "QUOTE_SENT",
      "REQUEST_RECEIVED",
      "supplier",
      "profit",
      "glass_cost",
      "sell_price",
      "labor"
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("rejects bogus tokens and enforces token purpose both ways", async () => {
    const f = await fixture();
    const { status_token } = await simpleIntake(f);

    await statusOf(f, `rnappr_${"0".repeat(64)}`).expect(404);
    await request(f.app)
      .post(`/api/v1/public/intake-status/rnappr_${"0".repeat(64)}/quote-link`)
      .expect(404);

    // The status token is NOT a quote token, and a quote token is NOT a
    // status token.
    await request(f.app).get(`/api/v1/public/quote/${status_token}`).expect(404);
    const link = await request(f.app)
      .post(`/api/v1/public/intake-status/${status_token}/quote-link`)
      .expect(200);
    const quoteToken = (link.body.path as string).split("/quote/")[1];
    await statusOf(f, quoteToken).expect(404);
  });

  it("hands the customer their sign URL; signing takes staff to Order parts", async () => {
    const f = await fixture();
    const { status_token } = await simpleIntake(f);

    const link = await request(f.app)
      .post(`/api/v1/public/intake-status/${status_token}/quote-link`)
      .expect(200);
    expect(link.body.path).toMatch(/^\/quote\/rnappr_/);
    const quoteToken = (link.body.path as string).split("/quote/")[1];

    const view = await request(f.app).get(`/api/v1/public/quote/${quoteToken}`).expect(200);
    expect(view.body.status).toBe("AWAITING_SIGNATURE");
    expect(view.body.total_cents).toBeGreaterThan(0);

    const signed = await request(f.app)
      .post(`/api/v1/public/quote/${quoteToken}/sign`)
      .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
      .expect(200);
    expect(signed.body.status).toBe("APPROVED");

    // The intake page now reports the approval.
    const after = await statusOf(f, status_token).expect(200);
    expect(after.body.phase).toBe("approved");
    expect(after.body.quote_ready).toBe(false);

    // Staff side: invoice auto-generated from the signed quote, and the
    // fulfillment chain is unlocked at its first step — Order parts.
    const list = await staff(f).get("/api/v1/cases").expect(200);
    const c = list.body[0];
    expect(c.current_state).toBe("INVOICED");
    expect(c.invoice).not.toBeNull();
    await act(f, c.id, "order_parts").expect(200);
    const done = await staff(f).get(`/api/v1/cases/${c.id}`).expect(200);
    expect(done.body.current_state).toBe("PARTS_ORDERED");
  });

  it("a case that needs staff (ambiguous glass) waits at 'identifying', then completes when staff pick the glass", async () => {
    const f = await fixture();
    // Door glass is VIN-ineligible, so ambiguity routes to human review —
    // the staff-pick path (a windshield would route to the paid VIN
    // lookup instead).
    const { status_token } = await simpleIntake(f, "Ambiguous", "DOOR_GLASS");

    // The chain paused for a human: no quote, no sign link yet.
    const waiting = await statusOf(f, status_token).expect(200);
    expect(waiting.body.phase).toBe("identifying");
    expect(waiting.body.quote_ready).toBe(false);
    const stepMap = Object.fromEntries(waiting.body.steps.map((s: any) => [s.key, s.done]));
    expect(stepMap.glass).toBe(false);
    await request(f.app)
      .post(`/api/v1/public/intake-status/${status_token}/quote-link`)
      .expect(409);

    // Staff resolve the ambiguity; the customer's page completes itself.
    const list = await staff(f).get("/api/v1/cases").expect(200);
    const c = list.body[0];
    expect(c.current_state).toBe("HUMAN_GLASS_REVIEW_REQUIRED");
    await act(f, c.id, "select_glass_candidate", {
      part_number: c.glass_identification.candidates[0].part_number
    }).expect(200);

    const ready = await statusOf(f, status_token).expect(200);
    expect(ready.body.phase).toBe("quote_ready");
    await request(f.app)
      .post(`/api/v1/public/intake-status/${status_token}/quote-link`)
      .expect(200);
  });
});
