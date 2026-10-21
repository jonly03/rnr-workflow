import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { agingDays } from "../src/payments.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType, Invoice } from "../src/types.js";

const TEST_AUTH_SECRET = ["test", "auth", "secret", "invoice", "payments", "0123456789"].join("-");
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };
const MOCK_SUPPLIERS = [
  "National Glass Supply",
  "Allied Auto Glass",
  "Regional Glass Depot",
  "Local Auto Glass"
];

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  token: string;
  adminToken: string;
  createCase: () => request.Test;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-invoice-payments-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  await store.createStaffUser({
    email: "admin@example.com",
    name: "Test Admin",
    role: "admin",
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
  const login = (email: string) =>
    request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "password123" })
      .expect(200);
  const token = (await login("staff@example.com")).body.token as string;
  const adminToken = (await login("admin@example.com")).body.token as string;
  const createCase = () =>
    request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Ambiguous", vin: VIN_17 },
        glass_request: { glass_type: "DOOR_GLASS" as GlassType }
      });
  return { app, store, token, adminToken, createCase };
}

const act = (
  f: Fixture,
  caseId: string,
  action: string,
  body: Record<string, unknown> = {},
  token: string = f.token
) =>
  request(f.app)
    .post(`/api/v1/cases/${caseId}/actions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ action, ...body });

const getCase = (f: Fixture, caseId: string) =>
  request(f.app)
    .get(`/api/v1/cases/${caseId}`)
    .set("Authorization", `Bearer ${f.token}`);

const getEvents = (f: Fixture, caseId: string) =>
  request(f.app)
    .get(`/api/v1/cases/${caseId}/events`)
    .set("Authorization", `Bearer ${f.token}`);

/** Binary-safe GET (the PDF endpoints return application/pdf). */
const getBinary = (f: Fixture, url: string, token?: string) => {
  let r = request(f.app)
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  if (token) r = r.set("Authorization", `Bearer ${token}`);
  return r;
};

const signatureDataUrl = (bytes = 1024) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

const signBody = (name = "Lou Customer") => ({
  name,
  signature_data_url: signatureDataUrl(),
  attribution: "signed on staff tablet at counter"
});

/** Creates a case and drives it to QUOTE_SENT (auto-quote on approval). */
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
  expect(priced.body.current_state).toBe("QUOTE_SENT");
  return caseId;
}

/** Signed + invoiced case (state INVOICED, invoice UNSENT). */
async function invoicedCase(f: Fixture): Promise<string> {
  const caseId = await approvedCase(f);
  await act(f, caseId, "sign_quote", signBody()).expect(200);
  await act(f, caseId, "generate_invoice").expect(200);
  return caseId;
}

/** Walks fulfillment to SERVICE_COMPLETED. */
async function completeService(f: Fixture, caseId: string): Promise<void> {
  await act(f, caseId, "order_parts").expect(200);
  await act(f, caseId, "schedule_installation", { scheduled_at: "2026-10-21T14:00:00Z" }).expect(200);
  await act(f, caseId, "dispatch_technician", { technician_name: "Lou" }).expect(200);
  await act(f, caseId, "start_service").expect(200);
  await act(f, caseId, "complete_service").expect(200);
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

function fakeInvoice(partial: Partial<Invoice>): Invoice {
  return {
    id: "inv-1",
    case_id: "case-1",
    version: 1,
    actuals: {
      glass_cost_cents: 0, labor_cents: 0, profit_cents: 0, tax_cents: 0,
      sell_price_cents: 0, price_calculation_id: "", quote_id: "", quote_version: 1,
      source: "signed_quote"
    },
    created_at: new Date().toISOString(),
    payment_status: "UNSENT",
    sent_at: null, sent_via: null, sent_to: null,
    paid_at: null, paid_method: null, paid_ref: null, paid_by: null,
    dispute_reason_code: null, dispute_reason: null, disputed_at: null,
    dispute_resolution: null, dispute_resolved_at: null,
    ...partial
  };
}

describe("agingDays", () => {
  it("counts whole days from the send while SENT, clamps at zero", () => {
    expect(agingDays(fakeInvoice({ payment_status: "SENT", sent_at: new Date().toISOString() }))).toBe(0);
    expect(agingDays(fakeInvoice({ payment_status: "SENT", sent_at: daysAgo(2.9) }))).toBe(2);
    expect(agingDays(fakeInvoice({ payment_status: "SENT", sent_at: daysAgo(-1) }))).toBe(0);
  });

  it("ages a disputed invoice from its send (or dispute) date", () => {
    expect(agingDays(fakeInvoice({
      payment_status: "DISPUTED", sent_at: daysAgo(4.2), disputed_at: daysAgo(1)
    }))).toBe(4);
    expect(agingDays(fakeInvoice({
      payment_status: "DISPUTED", sent_at: null, disputed_at: daysAgo(3.5)
    }))).toBe(3);
  });

  it("does not apply to UNSENT or PAID", () => {
    expect(agingDays(fakeInvoice({ payment_status: "UNSENT" }))).toBeNull();
    expect(agingDays(fakeInvoice({ payment_status: "PAID", sent_at: daysAgo(9), paid_at: daysAgo(1) }))).toBeNull();
    expect(agingDays(fakeInvoice({ payment_status: "SENT", sent_at: null }))).toBeNull();
  });
});

describe("Invoice payment lifecycle (Slice D)", () => {
  it("starts UNSENT; mark sent records who/how/when and the invoice ages", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);

    const before = await getCase(f, caseId).expect(200);
    expect(before.body.invoice.payment_status).toBe("UNSENT");
    expect(before.body.invoice.aging_days).toBeNull();
    expect(before.body.invoice.sent_at).toBeNull();

    const sent = await act(f, caseId, "mark_invoice_sent", {
      sent_via: "text",
      sent_to: "6175550123"
    }).expect(200);
    expect(sent.body.invoice.payment_status).toBe("SENT");
    expect(sent.body.invoice.sent_via).toBe("text");
    expect(sent.body.invoice.sent_to).toBe("6175550123");
    expect(sent.body.invoice.sent_at).toBeTruthy();
    expect(sent.body.invoice_events.map((e: any) => e.kind)).toEqual(["SENT"]);

    // Backdate the send: the detail view ages the invoice.
    await f.store.updateInvoicePayment(sent.body.invoice.id, { sent_at: daysAgo(6.3) });
    const aged = await getCase(f, caseId).expect(200);
    expect(aged.body.invoice.aging_days).toBe(6);

    const events = await getEvents(f, caseId).expect(200);
    expect(events.body.map((e: any) => e.event_type)).toContain("INVOICE_SENT");
  });

  it("payment before completion keeps the case open; manual close works after", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);

    // UNSENT -> PAID (paid on delivery) is legal and does not close early.
    const paid = await act(f, caseId, "mark_invoice_paid", {
      method: "cash",
      paid_by: "Lou Customer"
    }).expect(200);
    expect(paid.body.invoice.payment_status).toBe("PAID");
    expect(paid.body.invoice.paid_method).toBe("cash");
    expect(paid.body.invoice.paid_by).toBe("Lou Customer");
    expect(paid.body.invoice.paid_at).toBeTruthy();
    expect(paid.body.current_state).toBe("INVOICED");

    await completeService(f, caseId);
    const closed = await act(f, caseId, "close_case").expect(200);
    expect(closed.body.current_state).toBe("CLOSED");
    const events = await getEvents(f, caseId).expect(200);
    const closeEvent = events.body.find((e: any) => e.event_type === "CASE_CLOSED");
    expect(closeEvent.payload.auto).toBeUndefined();
    expect(closeEvent.payload.invoice_payment_status).toBe("PAID");
  });

  it("a completed case is visibly awaiting payment, then auto-closes when paid", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);
    await completeService(f, caseId);

    const waiting = await getCase(f, caseId).expect(200);
    expect(waiting.body.current_state).toBe("SERVICE_COMPLETED");
    expect(waiting.body.awaiting_payment).toBe(true);

    const paid = await act(f, caseId, "mark_invoice_paid", { method: "card" }).expect(200);
    expect(paid.body.current_state).toBe("CLOSED");
    expect(paid.body.awaiting_payment).toBe(false);

    const events = await getEvents(f, caseId).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    expect(types.indexOf("INVOICE_PAID")).toBeLessThan(types.indexOf("CASE_CLOSED"));
  });

  it("rejects illegal transitions and unauthenticated calls", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);

    // Dispute needs a reason before anything else.
    const noReason = await act(f, caseId, "dispute_invoice", {}).expect(422);
    expect(noReason.body.error.code).toBe("DISPUTE_REASON_REQUIRED");
    // No open dispute yet: updates and resolutions are illegal.
    await act(f, caseId, "invoice_dispute_update", { note: "hello" }).expect(409);
    await act(f, caseId, "resolve_invoice_dispute", { outcome: "PAID" }).expect(409);
    const badOutcome = await act(f, caseId, "resolve_invoice_dispute", { outcome: "LATER" }).expect(422);
    expect(badOutcome.body.error.code).toBe("OUTCOME_INVALID");

    await act(f, caseId, "mark_invoice_paid", { method: "card" }).expect(200);
    // PAID is terminal for the payment machine.
    await act(f, caseId, "mark_invoice_paid", {}).expect(409);
    await act(f, caseId, "mark_invoice_sent", {}).expect(409);
    await act(f, caseId, "dispute_invoice", { reason: "too late" }).expect(409);

    // No invoice at all -> NO_INVOICE.
    const bare = await approvedCase(f);
    const noInv = await act(f, bare, "mark_invoice_paid", {}).expect(409);
    expect(noInv.body.error.code).toBe("NO_INVOICE");

    // Staff auth is required everywhere.
    await request(f.app)
      .post(`/api/v1/cases/${caseId}/actions`)
      .send({ action: "mark_invoice_sent" })
      .expect(401);
    await request(f.app).get("/api/v1/invoices").expect(401);
    await request(f.app).get(`/api/v1/cases/${caseId}/invoice.pdf`).expect(401);
  });

  it("dispute thread: open from UNSENT, updates append, re-send clears it", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);

    // Brief §3.6: a client can dispute a hand-delivered (UNSENT) copy.
    const disputed = await act(f, caseId, "dispute_invoice", {
      reason_code: "AMOUNT",
      reason: "Customer says the total is wrong"
    }).expect(200);
    expect(disputed.body.invoice.payment_status).toBe("DISPUTED");
    expect(disputed.body.invoice.dispute_reason).toBe("Customer says the total is wrong");
    expect(disputed.body.invoice.dispute_reason_code).toBe("AMOUNT");
    expect(disputed.body.invoice.disputed_at).toBeTruthy();

    const noNote = await act(f, caseId, "invoice_dispute_update", {}).expect(422);
    expect(noNote.body.error.code).toBe("NOTE_REQUIRED");
    const updated = await act(f, caseId, "invoice_dispute_update", {
      note: "Called the customer; reviewing the before photos"
    }).expect(200);
    expect(updated.body.invoice_events.map((e: any) => e.kind)).toEqual([
      "DISPUTE_OPENED",
      "DISPUTE_UPDATE"
    ]);
    expect(updated.body.invoice_events[0].note).toBe("Customer says the total is wrong");

    // Re-send after resolution: back to SENT, dispute fields cleared,
    // the thread keeps the full history.
    const resent = await act(f, caseId, "mark_invoice_sent", { sent_via: "email" }).expect(200);
    expect(resent.body.invoice.payment_status).toBe("SENT");
    expect(resent.body.invoice.dispute_reason).toBeNull();
    expect(resent.body.invoice_events.map((e: any) => e.kind)).toEqual([
      "DISPUTE_OPENED",
      "DISPUTE_UPDATE",
      "SENT"
    ]);

    const events = await getEvents(f, caseId).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    for (const t of ["INVOICE_DISPUTED", "INVOICE_DISPUTE_UPDATED", "INVOICE_SENT"]) {
      expect(types).toContain(t);
    }
    // The dispute free text never rides a case event payload.
    expect(JSON.stringify(events.body)).not.toContain("total is wrong");
  });

  it("dispute resolved ADJUSTED: re-invoice supersedes and governs closing", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);
    await act(f, caseId, "mark_invoice_sent", { sent_via: "text" }).expect(200);
    await act(f, caseId, "dispute_invoice", { reason: "Wrong glass billed" }).expect(200);

    const resolved = await act(f, caseId, "resolve_invoice_dispute", {
      outcome: "ADJUSTED",
      note: "Re-issuing with the corrected amount"
    }).expect(200);
    expect(resolved.body.invoice.payment_status).toBe("DISPUTED");
    expect(resolved.body.invoice.dispute_resolution).toBe("RESOLVED_ADJUSTED");

    const reinvoiced = await act(f, caseId, "generate_invoice").expect(200);
    expect(reinvoiced.body.invoice.version).toBe(2);
    expect(reinvoiced.body.invoice.payment_status).toBe("UNSENT");

    await completeService(f, caseId);
    await act(f, caseId, "close_case").expect(409);
    const paid = await act(f, caseId, "mark_invoice_paid", { method: "card" }).expect(200);
    expect(paid.body.current_state).toBe("CLOSED");
    expect(paid.body.invoice.version).toBe(2);
  });

  it("dispute resolved PAID settles the dispute and auto-closes", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);
    await completeService(f, caseId);
    await act(f, caseId, "mark_invoice_sent", { sent_via: "text" }).expect(200);
    await act(f, caseId, "dispute_invoice", { reason: "Waiting on the check" }).expect(200);

    const resolved = await act(f, caseId, "resolve_invoice_dispute", {
      outcome: "PAID",
      method: "check",
      ref: "1042"
    }).expect(200);
    expect(resolved.body.invoice.payment_status).toBe("PAID");
    expect(resolved.body.invoice.dispute_resolution).toBe("RESOLVED_PAID");
    expect(resolved.body.invoice.paid_method).toBe("check");
    expect(resolved.body.invoice.paid_ref).toBe("1042");
    expect(resolved.body.current_state).toBe("CLOSED");
    expect(resolved.body.invoice_events.map((e: any) => e.kind)).toEqual([
      "SENT",
      "DISPUTE_OPENED",
      "DISPUTE_RESOLVED",
      "PAID"
    ]);
  });

  it("write-off is admin-only, never auto-closes, and closes flagged", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);
    await act(f, caseId, "mark_invoice_sent", { sent_via: "mail" }).expect(200);
    await act(f, caseId, "dispute_invoice", { reason: "Customer vanished" }).expect(200);

    const staffAttempt = await act(
      f, caseId, "resolve_invoice_dispute", { outcome: "WRITTEN_OFF" }
    ).expect(403);
    expect(staffAttempt.body.error.code).toBe("FORBIDDEN_ROLE");

    const writtenOff = await act(
      f, caseId, "resolve_invoice_dispute", { outcome: "WRITTEN_OFF" }, f.adminToken
    ).expect(200);
    expect(writtenOff.body.invoice.dispute_resolution).toBe("RESOLVED_WRITTEN_OFF");
    expect(writtenOff.body.invoice.payment_status).toBe("DISPUTED");
    expect(writtenOff.body.current_state).toBe("INVOICED");

    await completeService(f, caseId);
    const closed = await act(f, caseId, "close_case").expect(200);
    expect(closed.body.current_state).toBe("CLOSED");
    const events = await getEvents(f, caseId).expect(200);
    const closeEvent = events.body.find((e: any) => e.event_type === "CASE_CLOSED");
    expect(closeEvent.payload.invoice_written_off).toBe(true);
    expect(events.body.map((e: any) => e.event_type)).toContain("INVOICE_WRITTEN_OFF");
  });
});

describe("Staff invoice board", () => {
  it("orders for collections, computes aging, filters, and flags awaiting payment", async () => {
    const f = await fixture();
    const caseA = await invoicedCase(f); // stays UNSENT
    const caseB = await invoicedCase(f); // SENT, backdated
    const caseC = await invoicedCase(f); // SENT + completed -> awaiting payment

    const invB = (await getCase(f, caseB).expect(200)).body.invoice;
    await act(f, caseB, "mark_invoice_sent", { sent_via: "text" }).expect(200);
    await f.store.updateInvoicePayment(invB.id, { sent_at: daysAgo(6.3) });
    await act(f, caseC, "mark_invoice_sent", { sent_via: "email" }).expect(200);
    await completeService(f, caseC);

    const board = await request(f.app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const refs = board.body.map((i: any) => i.case_reference);
    const refOf = async (id: string) => (await getCase(f, id).expect(200)).body.reference;
    expect(refs).toEqual([await refOf(caseA), await refOf(caseB), await refOf(caseC)]);

    const itemB = board.body.find((i: any) => i.case_id === caseB);
    expect(itemB.payment_status).toBe("SENT");
    expect(itemB.aging_days).toBe(6);
    expect(itemB.awaiting_payment).toBe(false);
    const itemC = board.body.find((i: any) => i.case_id === caseC);
    expect(itemC.awaiting_payment).toBe(true);
    expect(itemC.case_state).toBe("SERVICE_COMPLETED");
    expect(itemC.bill_to).toBe("Lou Customer");
    // Staff surface: rows carry the invoice record (totals included),
    // exactly like the case detail staff already see.
    expect(itemB.actuals.sell_price_cents).toBeGreaterThan(0);

    const sentOnly = await request(f.app)
      .get("/api/v1/invoices?payment_status=SENT")
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    expect(sentOnly.body.map((i: any) => i.case_id).sort()).toEqual([caseB, caseC].sort());
    const unsentOnly = await request(f.app)
      .get("/api/v1/invoices?payment_status=UNSENT")
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    expect(unsentOnly.body.map((i: any) => i.case_id)).toEqual([caseA]);
  });
});

describe("Invoice PDF", () => {
  /** Shared leak assertions for a rendered invoice PDF. */
  function expectLeakFree(pdfText: string, detail: any) {
    const snap = detail.quote.snapshot;
    for (const name of MOCK_SUPPLIERS) expect(pdfText).not.toContain(name);
    expect(pdfText.toLowerCase()).not.toContain("profit");
    // Raw glass cost must not appear as a figure; the client sees the
    // baked glass line (cost + profit) instead. (Skipped only if the
    // raw figure coincidentally equals a legitimate printed amount.)
    const legit = new Set([
      snap.glass_cost_cents + snap.profit_cents,
      snap.labor_cents,
      snap.tax_cents,
      snap.glass_cost_cents + snap.profit_cents + snap.labor_cents,
      snap.sell_price_cents,
      30000
    ].map(fmt));
    if (!legit.has(fmt(snap.glass_cost_cents))) {
      expect(pdfText).not.toContain(fmt(snap.glass_cost_cents));
    }
    expect(pdfText).not.toContain(fmt(snap.profit_cents));
    expect(pdfText).toContain(fmt(snap.glass_cost_cents + snap.profit_cents));
    expect(pdfText).toContain(fmt(snap.sell_price_cents));
  }

  it("staff download: confirmed R&R format, built from the client projection", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);
    const detail = (await getCase(f, caseId).expect(200)).body;

    const res = await getBinary(f, `/api/v1/cases/${caseId}/invoice.pdf`, f.token);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain(
      `invoice-${detail.reference}-v1.pdf`
    );
    const text = (res.body as Buffer).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("R&R'S FINEST");
    expect(text).toContain("Auto glass");
    expect(text).toContain("857-266-1284");
    expect(text).toContain("RRsFinest1@gmail.com");
    expect(text).toContain(detail.reference);
    expect(text).toContain("Calibration");
    expect(text).toContain("$300.00");
    expect(text).toContain("Thank you for your business");
    expect(text).toContain("R&R's FINEST,");
    expect(text).toContain(detail.quote.snapshot.vehicle.vin);
    expectLeakFree(text, detail);
  });

  it("client download rides the tracking link: hidden while UNSENT, served once sent", async () => {
    const f = await fixture();
    const caseId = await invoicedCase(f);
    const link = await request(f.app)
      .post(`/api/v1/cases/${caseId}/tracking-link`)
      .set("Authorization", `Bearer ${f.token}`)
      .expect(200);
    const trackToken = link.body.token as string;

    // UNSENT: the file does not exist for the client yet.
    const hidden = await getBinary(f, `/api/v1/public/track/${trackToken}/invoice.pdf`);
    expect(hidden.status).toBe(404);
    const trackBefore = await request(f.app)
      .get(`/api/v1/public/track/${trackToken}`)
      .expect(200);
    expect(trackBefore.body.invoice.payment).toBeNull();

    await act(f, caseId, "mark_invoice_sent", { sent_via: "text" }).expect(200);
    const served = await getBinary(f, `/api/v1/public/track/${trackToken}/invoice.pdf`);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toContain("application/pdf");
    const detail = (await getCase(f, caseId).expect(200)).body;
    expectLeakFree((served.body as Buffer).toString("latin1"), detail);

    const trackSent = await request(f.app)
      .get(`/api/v1/public/track/${trackToken}`)
      .expect(200);
    expect(trackSent.body.invoice.payment).toEqual({
      status: "DUE",
      label: "Payment due"
    });
    // The tracking projection itself stays leak-free.
    const raw = JSON.stringify(trackSent.body);
    for (const name of MOCK_SUPPLIERS) expect(raw).not.toContain(name);
    expect(raw).not.toContain("dispute");

    // A bogus token gets nothing.
    const bogus = await getBinary(f, `/api/v1/public/track/rnappr_${"0".repeat(64)}/invoice.pdf`);
    expect(bogus.status).toBe(404);
  });
});
