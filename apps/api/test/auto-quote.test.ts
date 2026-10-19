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
 * Automation (Nelly, 2026-10-19): "Generate quote and client link
 * automatically. If supplier is overridden, requote."
 *
 * - Price approval produces the quote in the same request — no
 *   generate_quote action anywhere in these flows.
 * - The customer sign link mints immediately against the auto quote.
 * - A supplier (or glass) override on an unsigned quote reprices and
 *   auto-requotes: the new version supersedes the stale one, and a link
 *   sent earlier now serves the new version.
 * - A signed quote is the customer's contract: overrides are refused.
 */

const TEST_AUTH_SECRET = "<redacted>";
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  token: string;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-auto-quote-"));
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
  return { app, store, token: login.body.token as string };
}

const staff = (f: Fixture) => ({
  post: (url: string) => request(f.app).post(url).set("Authorization", `Bearer ${f.token}`),
  get: (url: string) => request(f.app).get(url).set("Authorization", `Bearer ${f.token}`)
});

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  staff(f).post(`/api/v1/cases/${caseId}/actions`).send({ action, ...body });

const signatureDataUrl = (bytes = 1024) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

/** Drives a DIRECT case through identification + pricing. The quote must
 *  exist afterwards WITHOUT any generate_quote action. */
async function autoQuotedCase(f: Fixture): Promise<string> {
  const created = await staff(f)
    .post("/api/v1/cases")
    .send({
      channel: "DIRECT",
      vehicle: { year: 2020, make: "Honda", model: "Ambiguous", vin: VIN_17 },
      glass_request: { glass_type: "DOOR_GLASS" as GlassType }
    })
    .expect(201);
  const caseId = created.body.id as string;
  await act(f, caseId, "start_identification").expect(200);
  const start = Date.now();
  let settled: request.Response | null = null;
  for (;;) {
    const r = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    if (r.body.current_state === "HUMAN_GLASS_REVIEW_REQUIRED") { settled = r; break; }
    if (Date.now() - start > 15000) throw new Error("timed out waiting for review state");
    await new Promise(rr => setTimeout(rr, 100));
  }
  const ident = settled!.body.glass_identification;
  const priced = await act(f, caseId, "select_glass_candidate", {
    part_number: ident.candidates[0].part_number
  }).expect(200);
  expect(priced.body.current_state).toBe("QUOTE_SENT");
  expect(priced.body.quote).not.toBeNull();
  expect(priced.body.quote.version).toBe(1);
  expect(priced.body.quote.status).toBe("SENT");
  expect(priced.body.quote.snapshot.price_calculation_id).toBe(priced.body.price_calculation.id);
  return caseId;
}

async function otherOffer(f: Fixture, caseId: string) {
  const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
  const offers = detail.body.supplier_offers as any[];
  const replacement = offers.find(o => !o.selected && !o.excluded_reason);
  expect(replacement).toBeDefined();
  return { detail: detail.body, replacement };
}

describe("Auto-quote + auto-requote", () => {
  it("quote and client link exist automatically at price approval", async () => {
    const f = await fixture();
    const caseId = await autoQuotedCase(f);

    const events = await staff(f).get(`/api/v1/cases/${caseId}/events`).expect(200);
    const generated = (events.body as any[]).filter(e => e.event_type === "QUOTE_GENERATED");
    expect(generated).toHaveLength(1);
    expect(generated[0].payload.auto).toBe(true);
    expect(generated[0].payload.trigger).toBe("price_approved");

    // The link mints immediately — no quote action was ever taken.
    const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
    const view = await request(f.app).get(`/api/v1/public/quote/${link.body.token}`).expect(200);
    expect(view.body.status).toBe("AWAITING_SIGNATURE");
    expect(view.body.quote_version).toBe(1);
  });

  it("supplier override on a sent quote auto-requotes and supersedes", async () => {
    const f = await fixture();
    const caseId = await autoQuotedCase(f);
    const { detail, replacement } = await otherOffer(f, caseId);
    const v1Total = detail.quote.snapshot.sell_price_cents;

    // The customer already has a link for v1.
    const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);

    const res = await act(f, caseId, "override_supplier_offer", {
      offer_id: replacement.id
    }).expect(200);
    expect(res.body.current_state).toBe("QUOTE_SENT");
    expect(res.body.quote.version).toBe(2);
    expect(res.body.quote.status).toBe("SENT");
    expect(res.body.quote.snapshot.glass_cost_cents).toBe(replacement.price_cents);
    expect(res.body.quote.snapshot.price_calculation_id).toBe(res.body.price_calculation.id);
    expect(res.body.quote.snapshot.sell_price_cents).not.toBe(v1Total);

    const quotes = await f.store.listQuotes(caseId);
    expect(quotes.map(q => [q.version, q.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, "SENT"]
    ]);

    const events = await staff(f).get(`/api/v1/cases/${caseId}/events`).expect(200);
    const generated = (events.body as any[]).filter(e => e.event_type === "QUOTE_GENERATED");
    expect(generated).toHaveLength(2);
    expect(generated[1].payload.auto).toBe(true);
    expect(generated[1].payload.trigger).toBe("reprice");
    expect(generated[1].payload.superseded_version).toBe(1);

    // The link sent for v1 now serves v2 — the customer always sees the
    // current numbers, never the stale quote.
    const view = await request(f.app).get(`/api/v1/public/quote/${link.body.token}`).expect(200);
    expect(view.body.quote_version).toBe(2);
    expect(view.body.total_cents).toBe(res.body.quote.snapshot.sell_price_cents);
  });

  it("a signed quote blocks supplier and glass overrides", async () => {
    const f = await fixture();
    const caseId = await autoQuotedCase(f);
    const { replacement } = await otherOffer(f, caseId);
    const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
    await request(f.app)
      .post(`/api/v1/public/quote/${link.body.token}/sign`)
      .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
      .expect(200);

    const sup = await act(f, caseId, "override_supplier_offer", {
      offer_id: replacement.id
    }).expect(409);
    expect(sup.body.error.code).toBe("INVALID_TRANSITION");

    const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    const otherCandidate = (detail.body.glass_identification.candidates as any[]).find(
      c => c.part_number !== detail.body.glass_identification.selected_candidate.part_number
    );
    expect(otherCandidate).toBeDefined();
    const glass = await act(f, caseId, "override_glass_candidate", {
      part_number: otherCandidate.part_number
    }).expect(409);
    expect(glass.body.error.code).toBe("INVALID_TRANSITION");

    // The signed quote is untouched.
    const quotes = await f.store.listQuotes(caseId);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].status).toBe("APPROVED");
  });

  it("supplier override after a decline auto-requotes a fresh version", async () => {
    const f = await fixture();
    const caseId = await autoQuotedCase(f);
    const { replacement } = await otherOffer(f, caseId);
    const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
    await request(f.app).post(`/api/v1/public/quote/${link.body.token}/decline`).expect(200);

    const res = await act(f, caseId, "override_supplier_offer", {
      offer_id: replacement.id
    }).expect(200);
    expect(res.body.current_state).toBe("QUOTE_SENT");
    expect(res.body.quote.version).toBe(2);
    expect(res.body.quote.snapshot.glass_cost_cents).toBe(replacement.price_cents);

    const quotes = await f.store.listQuotes(caseId);
    expect(quotes.map(q => [q.version, q.status])).toEqual([
      [1, "DECLINED"],
      [2, "SENT"]
    ]);
  });
});
