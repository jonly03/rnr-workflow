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

const TEST_AUTH_SECRET = "<redacted>";
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };

interface Fixture {
  app: ReturnType<typeof createApp>;
  token: string;
}

async function fixture(quotingConfig = { expiry_hours: 72 }): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-customer-view-"));
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
      quotingConfig
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

/** Creates a DIRECT case and drives it to PRICE_APPROVED. */
async function approvedCase(f: Fixture): Promise<string> {
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
  await act(f, caseId, "select_glass_candidate", {
    part_number: ident.candidates[0].part_number
  }).expect(200);
  const priced = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
  // Price approval auto-generates the quote: the case settles at QUOTE_SENT.
  expect(priced.body.current_state).toBe("QUOTE_SENT");
  return caseId;
}

const signatureDataUrl = (bytes = 1024) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

async function quotedCase(f: Fixture): Promise<{ caseId: string; linkToken: string }> {
  const caseId = await approvedCase(f);
  // No generate_quote call: the quote already exists (auto-generated).
  const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
  expect(link.body.token).toMatch(/^rnappr_/);
  expect(link.body.path).toBe(`/quote/${link.body.token}`);
  return { caseId, linkToken: link.body.token as string };
}

describe("Customer view (Direct): sign link + tracking link", () => {
  it("serves a leak-free quote projection to the token holder only", async () => {
    const f = await fixture();
    const { linkToken } = await quotedCase(f);

    const view = await request(f.app).get(`/api/v1/public/quote/${linkToken}`).expect(200);
    expect(view.body.status).toBe("AWAITING_SIGNATURE");
    expect(view.body.noun).toBe("quote");
    expect(view.body.vehicle).toEqual({ year: 2020, make: "Honda", model: "Ambiguous" });
    expect(view.body.total_cents).toBeGreaterThan(0);
    // Projection law: no internal economics or supplier data, ever.
    const raw = JSON.stringify(view.body);
    for (const forbidden of ["glass_cost", "profit", "supplier", "current_state", "vin"]) {
      expect(raw).not.toContain(forbidden);
    }

    await request(f.app).get(`/api/v1/public/quote/rnappr_${"0".repeat(64)}`).expect(404);
    // The staff quote-link endpoint itself requires a staff session.
    await request(f.app).post(`/api/v1/cases/whatever/quote-link`).expect(401);
  });

  it("signs via link -> invoice is created -> tracking follows the whole job", async () => {
    const f = await fixture();
    const { caseId, linkToken } = await quotedCase(f);

    const signed = await request(f.app)
      .post(`/api/v1/public/quote/${linkToken}/sign`)
      .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
      .expect(200);
    expect(signed.body.status).toBe("APPROVED");
    expect(signed.body.invoice_version).toBe(1);
    const trackingToken = signed.body.tracking_token as string;
    expect(trackingToken).toMatch(/^rnappr_/);

    // The sign link is single-use: it cannot be replayed.
    await request(f.app).get(`/api/v1/public/quote/${linkToken}`).expect(404);
    await request(f.app)
      .post(`/api/v1/public/quote/${linkToken}/sign`)
      .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
      .expect(404);

    // Staff side: signed + invoiced from the signed quote.
    const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    expect(detail.body.current_state).toBe("INVOICED");
    expect(detail.body.quote.signature.name).toBe("Jane Customer");
    expect(detail.body.invoice.actuals.quote_id).toBe(detail.body.quote.id);

    // Tracking: first milestones lit, fulfillment still pending.
    const track1 = await request(f.app).get(`/api/v1/public/track/${trackingToken}`).expect(200);
    const byKey1 = Object.fromEntries(track1.body.milestones.map((m: any) => [m.key, m]));
    expect(byKey1.quote_signed.done).toBe(true);
    expect(byKey1.invoice_created.done).toBe(true);
    expect(byKey1.parts_ordered.done).toBe(false);
    expect(track1.body.total_cents).toBe(detail.body.invoice.actuals.sell_price_cents);
    expect(JSON.stringify(track1.body)).not.toContain("profit");

    // Walk fulfillment as staff; the tracking page follows each step.
    await act(f, caseId, "order_parts").expect(200);
    await act(f, caseId, "schedule_installation", { scheduled_at: "2026-10-21T14:00:00Z" }).expect(200);
    await act(f, caseId, "dispatch_technician", { technician_name: "Lou" }).expect(200);
    const mid = await request(f.app).get(`/api/v1/public/track/${trackingToken}`).expect(200);
    const byKeyMid = Object.fromEntries(mid.body.milestones.map((m: any) => [m.key, m]));
    expect(byKeyMid.parts_ordered.done).toBe(true);
    expect(byKeyMid.scheduled.detail).toBe("2026-10-21T14:00:00Z");
    expect(byKeyMid.tech_dispatched.detail).toBe("Lou");
    expect(mid.body.status).toContain("on the way");

    await act(f, caseId, "start_service").expect(200);
    await act(f, caseId, "complete_service").expect(200);
    // Out-of-order steps are rejected.
    await act(f, caseId, "order_parts").expect(409);
    await act(f, caseId, "close_case").expect(200);

    const done = await request(f.app).get(`/api/v1/public/track/${trackingToken}`).expect(200);
    expect(done.body.current_state).toBe("CLOSED");
    expect(done.body.milestones.every((m: any) => m.done)).toBe(true);
  });

  it("decline via link ends the quote and kills the link", async () => {
    const f = await fixture();
    const { caseId, linkToken } = await quotedCase(f);
    const res = await request(f.app).post(`/api/v1/public/quote/${linkToken}/decline`).expect(200);
    expect(res.body.status).toBe("DECLINED");
    const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    expect(detail.body.current_state).toBe("QUOTE_DECLINED");
    await request(f.app).get(`/api/v1/public/quote/${linkToken}`).expect(404);
    // Staff can requote and mint a fresh link afterwards.
    await act(f, caseId, "requote").expect(200);
    await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
  });

  it("an expired quote's link dies with it — signing is impossible (404)", async () => {
    const f = await fixture({ expiry_hours: 0.001 }); // ~3.6 seconds
    const caseId = await approvedCase(f);
    const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
    // Let the quote lapse, then try to use the link. The token's TTL is
    // bound to the quote's expiry, so the link is simply dead — the sign
    // attempt never reaches the quote.
    await new Promise(r => setTimeout(r, 3800));
    const res = await request(f.app)
      .post(`/api/v1/public/quote/${link.body.token}/sign`)
      .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
      .expect(404);
    expect(res.body.error.code).toBe("LINK_INVALID");
    await request(f.app).get(`/api/v1/public/quote/${link.body.token}`).expect(404);
  });

  it("staff can re-issue a tracking link after signing", async () => {
    const f = await fixture();
    const { caseId, linkToken } = await quotedCase(f);
    await request(f.app)
      .post(`/api/v1/public/quote/${linkToken}/sign`)
      .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
      .expect(200);
    const reissued = await staff(f).post(`/api/v1/cases/${caseId}/tracking-link`).expect(200);
    await request(f.app).get(`/api/v1/public/track/${reissued.body.token}`).expect(200);
    // A quote-approval token is NOT a tracking token (purpose is enforced).
    const { linkToken: link2 } = await quotedCase(f);
    await request(f.app).get(`/api/v1/public/track/${link2}`).expect(404);
  });
});
