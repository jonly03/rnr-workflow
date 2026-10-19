import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { hashSignatureBytes } from "../src/invoicing.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

const TEST_AUTH_SECRET = "test-auth-secret-for-invoicing-tests-0123456789";
const VIN_17 = "1HGCM82633A004352";

const PRICING = {
  labor_cents: 12500,
  target_profit_cents: 25000,
  tax_rate: 0.0625
};

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  token: string;
  createCase: () => request.Test;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-invoice-"));
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
      pricingConfig: PRICING
    }
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  const token = login.body.token as string;
  const createCase = () =>
    request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Ambiguous", vin: VIN_17 },
        glass_request: { glass_type: "DOOR_GLASS" as GlassType }
      });
  return { app, store, token, createCase };
}

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  request(f.app)
    .post(`/api/v1/cases/${caseId}/actions`)
    .set("Authorization", `Bearer ${f.token}`)
    .send({ action, ...body });

const getCase = (f: Fixture, caseId: string) =>
  request(f.app)
    .get(`/api/v1/cases/${caseId}`)
    .set("Authorization", `Bearer ${f.token}`);

const getEvents = (f: Fixture, caseId: string) =>
  request(f.app)
    .get(`/api/v1/cases/${caseId}/events`)
    .set("Authorization", `Bearer ${f.token}`);

/** Creates a case and drives it to PRICE_APPROVED via human candidate selection. */
async function approvedCase(f: Fixture): Promise<string> {
  const created = await f.createCase().expect(201);
  const caseId = created.body.id as string;
  await act(f, caseId, "start_identification").expect(200);
  const start = Date.now();
  let settled: request.Response | null = null;
  for (;;) {
    const r = await getCase(f, caseId).expect(200);
    if (r.body.current_state === "HUMAN_GLASS_REVIEW_REQUIRED") { settled = r; break; }
    if (Date.now() - start > 15000) throw new Error("timed out waiting for HUMAN_GLASS_REVIEW_REQUIRED");
    await new Promise(rr => setTimeout(rr, 100));
  }
  const ident = settled!.body.glass_identification;
  await act(f, caseId, "select_glass_candidate", {
    part_number: ident.candidates[0].part_number
  }).expect(200);
  const priced = await getCase(f, caseId).expect(200);
  expect(priced.body.current_state).toBe("PRICE_APPROVED");
  return caseId;
}

/** A plausible signature-pad PNG payload (not a real image — the API only
 *  checks the data-URL shape and a minimum byte count). */
const signatureDataUrl = (bytes = 1024) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

describe("Invoice + in-app sign-off", () => {
  it("generates an invoice from the approved price snapshot", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    const before = await getCase(f, caseId).expect(200);
    const calc = before.body.price_calculation;

    const res = await act(f, caseId, "generate_invoice").expect(200);
    expect(res.body.current_state).toBe("INVOICED");
    const invoice = res.body.invoice;
    expect(invoice).toBeDefined();
    expect(invoice.version).toBe(1);
    expect(invoice.status).toBe("SENT");
    expect(invoice.signature).toBeNull();
    // Actuals are an integer-cents copy of the approved price snapshot.
    expect(invoice.actuals.glass_cost_cents).toBe(calc.glass_cost_cents);
    expect(invoice.actuals.labor_cents).toBe(12500);
    expect(invoice.actuals.profit_cents).toBe(25000);
    expect(invoice.actuals.tax_cents).toBe(calc.tax_cents);
    expect(invoice.actuals.sell_price_cents).toBe(calc.sell_price_cents);
    expect(invoice.actuals.price_calculation_id).toBe(calc.id);
    expect(invoice.actuals.source).toBe("price_snapshot");
    for (const v of Object.values(invoice.actuals)) {
      if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }

    const events = await getEvents(f, caseId).expect(200);
    const generated = events.body.filter((e: any) => e.event_type === "INVOICE_GENERATED");
    expect(generated).toHaveLength(1);
    expect(generated[0].payload.invoice_id).toBe(invoice.id);
  });

  it("rejects generate_invoice from a non-approved state", async () => {
    const f = await fixture();
    const created = await f.createCase().expect(201);
    const res = await act(f, created.body.id, "generate_invoice").expect(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("rejects close_case on an unsigned invoice with INVOICE_NOT_SIGNED", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "generate_invoice").expect(200);
    const res = await act(f, caseId, "close_case").expect(409);
    expect(res.body.error.code).toBe("INVOICE_NOT_SIGNED");
    const still = await getCase(f, caseId).expect(200);
    expect(still.body.current_state).toBe("INVOICED");
  });

  it("signs the invoice, then closes the case", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "generate_invoice").expect(200);

    const name = "Lou Customer";
    const dataUrl = signatureDataUrl();
    const expectedHash = createHash("sha256")
      .update(Buffer.from(dataUrl.split(",")[1], "base64"))
      .digest("hex");
    expect(hashSignatureBytes(Buffer.from(dataUrl.split(",")[1], "base64"))).toBe(expectedHash);

    const signed = await act(f, caseId, "sign_invoice", {
      name,
      signature_data_url: dataUrl,
      attribution: "signed on staff tablet at counter"
    }).expect(200);
    const invoice = signed.body.invoice;
    expect(invoice.status).toBe("SIGNED");
    expect(invoice.signature.name).toBe(name);
    expect(invoice.signature.signature_hash).toBe(expectedHash);
    expect(invoice.signature.signed_at).toBeTruthy();
    expect(invoice.signature.attribution).toBe("signed on staff tablet at counter");
    // The raw image is stored for staff; the hash is what clients see.
    expect(invoice.signature.signature_data_url).toBe(dataUrl);
    expect(signed.body.current_state).toBe("INVOICED");

    // Idempotent re-sign: returns the current record, no duplicate event.
    const eventsBefore = (await getEvents(f, caseId).expect(200)).body.length;
    const again = await act(f, caseId, "sign_invoice", {
      name: "Someone Else",
      signature_data_url: signatureDataUrl(2048),
      attribution: ""
    }).expect(200);
    expect(again.body.invoice.signature.name).toBe(name);
    const eventsAfter = (await getEvents(f, caseId).expect(200)).body.length;
    expect(eventsAfter).toBe(eventsBefore);

    const closed = await act(f, caseId, "close_case").expect(200);
    expect(closed.body.current_state).toBe("CLOSED");
    const events = await getEvents(f, caseId).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    expect(types).toContain("INVOICE_SIGNED");
    expect(types).toContain("CASE_CLOSED");
    const closeEvent = events.body.find((e: any) => e.event_type === "CASE_CLOSED");
    expect(closeEvent.payload.signed_by).toBe(name);
  });

  it("validates the signature payload", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "generate_invoice").expect(200);

    await act(f, caseId, "sign_invoice", {
      name: "   ",
      signature_data_url: signatureDataUrl()
    }).expect(422);
    await act(f, caseId, "sign_invoice", {
      name: "Lou",
      signature_data_url: "not-a-data-url"
    }).expect(422);
    await act(f, caseId, "sign_invoice", {
      name: "Lou",
      signature_data_url: "data:image/png;base64," + Buffer.alloc(100).toString("base64")
    }).expect(422);

    const still = await getCase(f, caseId).expect(200);
    expect(still.body.invoice.status).toBe("SENT");
  });

  it("re-invoicing creates a new version without mutating history", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    const first = await act(f, caseId, "generate_invoice").expect(200);
    const v1id = first.body.invoice.id as string;
    const second = await act(f, caseId, "generate_invoice").expect(200);
    expect(second.body.invoice.version).toBe(2);
    expect(second.body.invoice.id).not.toBe(v1id);
    expect(second.body.current_state).toBe("INVOICED");

    const invoices = await f.store.listInvoices(caseId);
    expect(invoices.map(i => i.version)).toEqual([1, 2]);
    expect(invoices[0].actuals.sell_price_cents).toBe(invoices[1].actuals.sell_price_cents);
  });

  it("rejects close_case when the latest invoice version is unsigned", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "generate_invoice").expect(200);
    await act(f, caseId, "sign_invoice", {
      name: "Lou",
      signature_data_url: signatureDataUrl(),
      attribution: ""
    }).expect(200);
    // A corrected re-invoice supersedes the signed v1: the case cannot close
    // until the newest version is signed.
    await act(f, caseId, "generate_invoice").expect(200);
    const res = await act(f, caseId, "close_case").expect(409);
    expect(res.body.error.code).toBe("INVOICE_NOT_SIGNED");
  });
});
