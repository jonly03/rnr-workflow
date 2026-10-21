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
import { hashSignatureBytes, hashTypedSignature } from "../src/quoting.js";
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

async function fixture(quotingConfig = { expiry_hours: 72 }): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-quote-"));
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
  // Auto-quote: price approval generates the quote in the same request.
  expect(priced.body.current_state).toBe("QUOTE_SENT");
  return caseId;
}

/** A plausible signature-pad PNG payload (not a real image — the API only
 *  checks the data-URL shape and a minimum byte count). */
const signatureDataUrl = (bytes = 1024) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

const signBody = (name = "Lou Customer") => ({
  name,
  signature_data_url: signatureDataUrl(),
  attribution: "signed on staff tablet at counter"
});

describe("Quote sign-off (signature = approval)", () => {
  it("auto-generates a versioned quote from the approved price snapshot", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    const before = await getCase(f, caseId).expect(200);
    const calc = before.body.price_calculation;

    // No generate_quote action was taken: approval produced the quote.
    const res = before;
    expect(res.body.current_state).toBe("QUOTE_SENT");
    const quote = res.body.quote;
    expect(quote).toBeDefined();
    expect(quote.version).toBe(1);
    expect(quote.status).toBe("SENT");
    expect(quote.signature).toBeNull();
    // 72h default expiry.
    const ttlMs = new Date(quote.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(71 * 3600_000);
    expect(ttlMs).toBeLessThanOrEqual(72 * 3600_000);
    // Snapshot is an integer-cents copy of vehicle + glass + economics.
    expect(quote.snapshot.vehicle.vin).toBe(VIN_17);
    expect(quote.snapshot.vehicle.year).toBe(2020);
    expect(quote.snapshot.glass_type).toBe("DOOR_GLASS");
    expect(quote.snapshot.glass_cost_cents).toBe(calc.glass_cost_cents);
    expect(quote.snapshot.labor_cents).toBe(12500);
    expect(quote.snapshot.profit_cents).toBe(25000);
    expect(quote.snapshot.tax_cents).toBe(calc.tax_cents);
    expect(quote.snapshot.sell_price_cents).toBe(calc.sell_price_cents);
    expect(quote.snapshot.price_calculation_id).toBe(calc.id);

    const events = await getEvents(f, caseId).expect(200);
    const generated = events.body.filter((e: any) => e.event_type === "QUOTE_GENERATED");
    expect(generated).toHaveLength(1);
    expect(generated[0].payload.quote_id).toBe(quote.id);
    expect(generated[0].payload.expires_at).toBe(quote.expires_at);
    expect(generated[0].payload.auto).toBe(true);
    expect(generated[0].payload.trigger).toBe("price_approved");

    // A manual generate_quote from QUOTE_SENT still works: new version,
    // and the still-unsigned v1 is marked SUPERSEDED.
    const regen = await act(f, caseId, "generate_quote").expect(200);
    expect(regen.body.quote.version).toBe(2);
    const quotes = await f.store.listQuotes(caseId);
    expect(quotes.map(q => q.status)).toEqual(["SUPERSEDED", "SENT"]);
  });

  it("rejects generate_quote from a non-approved state", async () => {
    const f = await fixture();
    const created = await f.createCase().expect(201);
    const res = await act(f, created.body.id, "generate_quote").expect(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("signs the quote (approval), idempotently", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);

    const name = "Lou Customer";
    const dataUrl = signatureDataUrl();
    const expectedHash = createHash("sha256")
      .update(Buffer.from(dataUrl.split(",")[1], "base64"))
      .digest("hex");
    expect(hashSignatureBytes(Buffer.from(dataUrl.split(",")[1], "base64"))).toBe(expectedHash);

    const signed = await act(f, caseId, "sign_quote", {
      name,
      signature_data_url: dataUrl,
      attribution: "signed on staff tablet at counter"
    }).expect(200);
    expect(signed.body.current_state).toBe("QUOTE_APPROVED");
    const quote = signed.body.quote;
    expect(quote.status).toBe("APPROVED");
    expect(quote.signature.name).toBe(name);
    expect(quote.signature.signature_hash).toBe(expectedHash);
    expect(quote.signature.signed_at).toBeTruthy();
    expect(quote.signature.attribution).toBe("signed on staff tablet at counter");
    expect(quote.signature.signature_data_url).toBe(dataUrl);
    // A submitted data URL is a legacy DRAWN signature.
    expect(quote.signature.method).toBe("drawn");

    // Idempotent re-sign: returns the current record, no duplicate event.
    const eventsBefore = (await getEvents(f, caseId).expect(200)).body.length;
    const again = await act(f, caseId, "sign_quote", {
      name: "Someone Else",
      signature_data_url: signatureDataUrl(2048),
      attribution: ""
    }).expect(200);
    expect(again.body.quote.signature.name).toBe(name);
    const eventsAfter = (await getEvents(f, caseId).expect(200)).body.length;
    expect(eventsAfter).toBe(eventsBefore);

    const events = await getEvents(f, caseId).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    expect(types).toContain("QUOTE_SIGNED");
  });

  it("signs with a typed name only — the typed name IS the signature", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);

    // No signature_data_url at all: the typed first + last name signs.
    const signed = await act(f, caseId, "sign_quote", {
      name: "  Lou   Customer ",
      attribution: "typed signature captured in-app"
    }).expect(200);
    expect(signed.body.current_state).toBe("QUOTE_APPROVED");
    const quote = signed.body.quote;
    expect(quote.status).toBe("APPROVED");
    // The stored name is normalized (trimmed, single-spaced).
    expect(quote.signature.name).toBe("Lou Customer");
    expect(quote.signature.method).toBe("typed");
    expect(quote.signature.signature_data_url).toBe("");
    expect(quote.signature.signature_hash).toBe(hashTypedSignature("Lou Customer"));
    expect(quote.signature.signed_at).toBeTruthy();

    const events = await getEvents(f, caseId).expect(200);
    const signedEvent = events.body.find((e: any) => e.event_type === "QUOTE_SIGNED");
    expect(signedEvent.payload.signer_name).toBe("Lou Customer");
    expect(signedEvent.payload.signature_method).toBe("typed");
  });

  it("rejects signing an expired quote and marks it QUOTE_EXPIRED", async () => {
    // 36ms validity: the quote is born expired for practical purposes.
    const f = await fixture({ expiry_hours: 0.00001 });
    const caseId = await approvedCase(f);
    await new Promise(rr => setTimeout(rr, 100));

    const res = await act(f, caseId, "sign_quote", signBody()).expect(410);
    expect(res.body.error.code).toBe("QUOTE_EXPIRED");

    const after = await getCase(f, caseId).expect(200);
    expect(after.body.current_state).toBe("QUOTE_EXPIRED");
    expect(after.body.quote.status).toBe("EXPIRED");

    const events = await getEvents(f, caseId).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    expect(types).toContain("QUOTE_EXPIRED");
  });

  it("declines a quote and requotes as a new version", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);

    const declined = await act(f, caseId, "decline_quote").expect(200);
    expect(declined.body.current_state).toBe("QUOTE_DECLINED");
    expect(declined.body.quote.status).toBe("DECLINED");

    const requoted = await act(f, caseId, "requote").expect(200);
    expect(requoted.body.current_state).toBe("QUOTE_SENT");
    expect(requoted.body.quote.version).toBe(2);
    expect(requoted.body.quote.status).toBe("SENT");
    expect(requoted.body.quote.signature).toBeNull();

    const quotes = await f.store.listQuotes(caseId);
    expect(quotes.map(q => q.version)).toEqual([1, 2]);
    expect(quotes[0].status).toBe("DECLINED");
  });

  it("requotes an expired quote as a new version", async () => {
    const f = await fixture({ expiry_hours: 0.00001 });
    const caseId = await approvedCase(f);
    await new Promise(rr => setTimeout(rr, 100));
    await act(f, caseId, "sign_quote", signBody()).expect(410);

    const requoted = await act(f, caseId, "requote").expect(200);
    expect(requoted.body.current_state).toBe("QUOTE_SENT");
    expect(requoted.body.quote.version).toBe(2);
  });

  it("validates the signature payload", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);

    await act(f, caseId, "sign_quote", {
      name: "   ",
      signature_data_url: signatureDataUrl()
    }).expect(422);
    await act(f, caseId, "sign_quote", {
      name: "Lou",
      signature_data_url: "not-a-data-url"
    }).expect(422);
    await act(f, caseId, "sign_quote", {
      name: "Lou",
      signature_data_url: "data:image/png;base64," + Buffer.alloc(100).toString("base64")
    }).expect(422);

    const still = await getCase(f, caseId).expect(200);
    expect(still.body.quote.status).toBe("SENT");
    expect(still.body.current_state).toBe("QUOTE_SENT");
  });

  it("rejects typed signatures without a first AND last name", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);

    // One word is not a signature.
    const oneWord = await act(f, caseId, "sign_quote", { name: "Lou" }).expect(422);
    expect(oneWord.body.error.code).toBe("VALIDATION_ERROR");
    expect(oneWord.body.error.message).toMatch(/first and last name/);
    // Empty / whitespace-only names are rejected the same way.
    const blank = await act(f, caseId, "sign_quote", { name: "   " }).expect(422);
    expect(blank.body.error.code).toBe("VALIDATION_ERROR");
    const missing = await act(f, caseId, "sign_quote", {}).expect(422);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");

    const still = await getCase(f, caseId).expect(200);
    expect(still.body.quote.status).toBe("SENT");
    expect(still.body.quote.signature).toBeNull();
  });

  it("rejects generate_invoice unless the quote is signed", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    // Unsigned (auto-generated) quote: invoicing is not a legal action yet.
    const r1 = await act(f, caseId, "generate_invoice").expect(409);
    expect(r1.body.error.code).toBe("INVALID_TRANSITION");

    // Unsigned (sent) quote: still not a legal action.
    await act(f, caseId, "generate_quote").expect(200);
    const r2 = await act(f, caseId, "generate_invoice").expect(409);
    expect(r2.body.error.code).toBe("INVALID_TRANSITION");

    // Defense in depth: if the case ever sits in QUOTE_APPROVED with an
    // unsigned latest quote, invoicing is refused with QUOTE_NOT_SIGNED.
    await act(f, caseId, "sign_quote", signBody()).expect(200);
    const signed = await getCase(f, caseId).expect(200);
    await f.store.updateQuoteStatus(signed.body.quote.id, "SENT");
    const r3 = await act(f, caseId, "generate_invoice").expect(409);
    expect(r3.body.error.code).toBe("QUOTE_NOT_SIGNED");
  });

  it("generates the invoice off the signed quote's snapshot", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "sign_quote", signBody()).expect(200);

    const res = await act(f, caseId, "generate_invoice").expect(200);
    expect(res.body.current_state).toBe("INVOICED");
    const invoice = res.body.invoice;
    expect(invoice.version).toBe(1);
    const quote = res.body.quote;
    // Line items come from the signed quote's snapshot.
    expect(invoice.actuals.glass_cost_cents).toBe(quote.snapshot.glass_cost_cents);
    expect(invoice.actuals.sell_price_cents).toBe(quote.snapshot.sell_price_cents);
    expect(invoice.actuals.quote_id).toBe(quote.id);
    expect(invoice.actuals.quote_version).toBe(quote.version);
    expect(invoice.actuals.source).toBe("signed_quote");
    for (const v of Object.values(invoice.actuals)) {
      if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }

    const events = await getEvents(f, caseId).expect(200);
    const generated = events.body.filter((e: any) => e.event_type === "INVOICE_GENERATED");
    expect(generated).toHaveLength(1);
    expect(generated[0].payload.quote_version).toBe(quote.version);
  });

  it("runs the full flow: quote -> sign -> invoice -> fulfillment -> close", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "sign_quote", signBody()).expect(200);
    await act(f, caseId, "generate_invoice").expect(200);

    // Close is blocked until the service is actually done.
    await act(f, caseId, "close_case").expect(409);
    await act(f, caseId, "order_parts").expect(200);
    await act(f, caseId, "schedule_installation", { scheduled_at: "2026-10-21T14:00:00Z" }).expect(200);
    await act(f, caseId, "dispatch_technician", { technician_name: "Lou" }).expect(200);
    await act(f, caseId, "start_service").expect(200);
    await act(f, caseId, "complete_service").expect(200);

    // Slice D close rule: a completed service with an UNPAID invoice
    // cannot close — the case stays open, awaiting payment.
    const blocked = await act(f, caseId, "close_case").expect(409);
    expect(blocked.body.error.code).toBe("INVOICE_NOT_PAID");

    // Recording the payment auto-closes the case.
    const paid = await act(f, caseId, "mark_invoice_paid", {
      method: "card",
      ref: "txn-1"
    }).expect(200);
    expect(paid.body.current_state).toBe("CLOSED");
    expect(paid.body.invoice.payment_status).toBe("PAID");

    const events = await getEvents(f, caseId).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    for (const t of ["QUOTE_GENERATED", "QUOTE_SIGNED", "INVOICE_GENERATED", "INVOICE_PAID", "CASE_CLOSED"]) {
      expect(types).toContain(t);
    }
    const closeEvent = events.body.find((e: any) => e.event_type === "CASE_CLOSED");
    expect(closeEvent.payload.signed_by).toBe("Lou Customer");
    expect(closeEvent.payload.quote_version).toBe(1);
    expect(closeEvent.payload.auto).toBe(true);
    expect(closeEvent.payload.trigger).toBe("invoice_paid");
  });

  it("rejects close_case without a signed quote", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "sign_quote", signBody()).expect(200);
    // Invoice generated, then a re-invoice... still fine (quote is signed).
    // But without any invoice at all:
    const f2 = await fixture();
    const caseId2 = await approvedCase(f2);
    await act(f2, caseId2, "sign_quote", signBody()).expect(200);
    const res = await act(f2, caseId2, "close_case").expect(409);
    expect(["QUOTE_NOT_SIGNED", "NO_SIGNED_QUOTE", "INVALID_TRANSITION"]).toContain(res.body.error.code);
  });

  it("re-invoicing creates a new version without mutating history", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "sign_quote", signBody()).expect(200);
    const first = await act(f, caseId, "generate_invoice").expect(200);
    const v1id = first.body.invoice.id as string;
    const second = await act(f, caseId, "generate_invoice").expect(200);
    expect(second.body.invoice.version).toBe(2);
    expect(second.body.invoice.id).not.toBe(v1id);
    expect(second.body.current_state).toBe("INVOICED");

    const invoices = await f.store.listInvoices(caseId);
    expect(invoices.map(i => i.version)).toEqual([1, 2]);
  });

  it("rejects sign_quote after the quote was already declined", async () => {
    const f = await fixture();
    const caseId = await approvedCase(f);
    await act(f, caseId, "decline_quote").expect(200);
    const res = await act(f, caseId, "sign_quote", signBody()).expect(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });
});
