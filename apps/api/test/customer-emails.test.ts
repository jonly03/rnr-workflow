import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import {
  dispatchQuoteEmail,
  processQuoteReminders
} from "../src/customer-emails.js";
import type { EmailMessage, EmailSender } from "../src/email.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { signQuote } from "../src/quoting.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

/**
 * Customer quote / invoice emails + 24h reminders (Nelly, 2026-11-23):
 * quote emailed when generated, invoice emailed when generated —
 * with invoice generation WIRED to signing on both sign paths — and
 * a reminder every 24h while a quote sits unsigned.
 */

const TEST_AUTH_SECRET = "test-auth-secret-for-invoicing-tests-0123456789";
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };
const WEB_BASE = "https://app.example.test";

class CapturingSender implements EmailSender {
  readonly name = "fake-smtp";
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return { providerMessageId: `fake-${this.sent.length}` };
  }
}

interface Fixture {
  app: ReturnType<typeof createApp>;
  token: string;
  store: JsonCaseStore;
  storeFile: string;
  sender: CapturingSender;
}

async function fixture(
  sender: EmailSender | undefined = new CapturingSender()
): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-customer-emails-"));
  const storeFile = path.join(dir, "cases.json");
  const store = new JsonCaseStore(storeFile);
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
      quotingConfig: { expiry_hours: 120 },
      ...(sender ? { emailSender: sender } : {})
    }
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  return {
    app,
    token: login.body.token as string,
    store,
    storeFile,
    sender: sender as CapturingSender
  };
}

const staff = (f: Fixture) => ({
  post: (url: string) =>
    request(f.app).post(url).set("Authorization", `Bearer ${f.token}`),
  get: (url: string) =>
    request(f.app).get(url).set("Authorization", `Bearer ${f.token}`)
});

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  staff(f).post(`/api/v1/cases/${caseId}/actions`).send({ action, ...body });

/** Seeds the customer's email the way the public intake records it. */
async function seedIntakeEmail(f: Fixture, caseId: string, email = "jane@example.com") {
  const c = await f.store.getCase(caseId);
  await f.store.appendEvent({
    caseId,
    channel: c!.channel,
    actor: { type: "CUSTOMER", id: null },
    eventType: "CLIENT_INTAKE_SUBMITTED",
    fromState: null,
    toState: null,
    payload: {
      customer_name: "Jane Customer",
      customer_email: email,
      customer_phone: null,
      service_address: { formatted: "1 Main St, Boston, MA" },
      vehicle: {},
      glass_request: {}
    }
  });
}

/** Drives a DIRECT case to QUOTE_SENT (auto-quote on price approval). */
async function quotedCase(f: Fixture, withEmail = true): Promise<string> {
  const created = await staff(f)
    .post("/api/v1/cases")
    .send({
      channel: "DIRECT",
      vehicle: { year: 2020, make: "Honda", model: "Ambiguous", vin: VIN_17 },
      glass_request: { glass_type: "DOOR_GLASS" as GlassType }
    })
    .expect(201);
  const caseId = created.body.id as string;
  if (withEmail) await seedIntakeEmail(f, caseId);
  await act(f, caseId, "start_identification").expect(200);
  const start = Date.now();
  let settled: request.Response | null = null;
  for (;;) {
    const r = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    if (r.body.current_state === "HUMAN_GLASS_REVIEW_REQUIRED") {
      settled = r;
      break;
    }
    if (Date.now() - start > 15000) throw new Error("timed out waiting for review state");
    await new Promise(rr => setTimeout(rr, 100));
  }
  const ident = settled!.body.glass_identification;
  await act(f, caseId, "select_glass_candidate", {
    part_number: ident.candidates[0].part_number
  }).expect(200);
  const priced = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
  expect(priced.body.current_state).toBe("QUOTE_SENT");
  return caseId;
}

describe("customer quote + invoice emails", () => {
  beforeEach(() => {
    process.env.WEB_BASE_URL = WEB_BASE;
  });
  afterEach(() => {
    delete process.env.WEB_BASE_URL;
    delete process.env.QUOTE_REMINDER_CRON_SECRET;
  });

  it("emails the quote when it is generated, once per version, with the sign link", async () => {
    const f = await fixture();
    const caseId = await quotedCase(f);
    const quoteMails = f.sender.sent.filter(m => m.subject.includes("quote is ready"));
    expect(quoteMails).toHaveLength(1);
    expect(quoteMails[0].to).toBe("jane@example.com");
    expect(quoteMails[0].body).toContain(`${WEB_BASE}/quote/rnappr_`);
    const row = await f.store.getNotification(caseId, "quote_sent_v1");
    expect(row?.status).toBe("sent");
    expect(row?.channel).toBe("email");

    // Idempotent: re-dispatching does not send a second copy.
    await dispatchQuoteEmail(f.store, caseId, { sender: f.sender });
    expect(f.sender.sent.filter(m => m.subject.includes("quote is ready"))).toHaveLength(1);
  });

  it("staff sign_quote generates the invoice AND emails it (signing is wired to invoicing)", async () => {
    const f = await fixture();
    const caseId = await quotedCase(f);
    await act(f, caseId, "sign_quote", { name: "Jane Customer" }).expect(200);
    const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    // Before this change the staff sign left the case at
    // QUOTE_APPROVED with no invoice until a separate manual action.
    expect(detail.body.current_state).toBe("INVOICED");
    expect(await f.store.getLatestInvoice(caseId)).not.toBeNull();
    const invoiceMails = f.sender.sent.filter(m => m.subject.includes("invoice is ready"));
    expect(invoiceMails).toHaveLength(1);
    expect(invoiceMails[0].to).toBe("jane@example.com");
    expect(invoiceMails[0].body).toContain(`${WEB_BASE}/track/rnappr_`);
    const row = await f.store.getNotification(caseId, "invoice_sent_v1");
    expect(row?.status).toBe("sent");
  });

  it("records a loud failure (never a fake send) when email is unconfigured, without breaking the flow", async () => {
    const f = await fixture(undefined);
    const caseId = await quotedCase(f);
    const row = await f.store.getNotification(caseId, "quote_sent_v1");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("EMAIL_NOT_CONFIGURED");
    const health = await request(f.app).get("/api/v1/health").expect(200);
    expect(health.body.email_provider).toBe("unconfigured");
  });

  it("records the owed email as skipped when the case has no customer email", async () => {
    const f = await fixture();
    const caseId = await quotedCase(f, false);
    const row = await f.store.getNotification(caseId, "quote_sent_v1");
    expect(row?.status).toBe("skipped");
    expect(f.sender.sent).toHaveLength(0);
  });
});

/** Shifts every quote + notification timestamp in the store file back by N hours, then reloads. */
function backdate(
  storeFile: string,
  hours: number,
  opts: { shiftExpiry?: boolean } = {}
): JsonCaseStore {
  const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  const shift = (iso: string) => new Date(Date.parse(iso) - hours * 3600_000).toISOString();
  for (const q of data.quotes ?? []) {
    q.created_at = shift(q.created_at);
    if (opts.shiftExpiry) q.expires_at = shift(q.expires_at);
  }
  for (const n of data.notifications ?? []) n.created_at = shift(n.created_at);
  fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
  return new JsonCaseStore(storeFile);
}

describe("unsigned-quote reminders (24h cadence)", () => {
  beforeEach(() => {
    process.env.WEB_BASE_URL = WEB_BASE;
  });
  afterEach(() => {
    delete process.env.WEB_BASE_URL;
    delete process.env.QUOTE_REMINDER_CRON_SECRET;
  });

  it("sends at 24h intervals, at most 4, and stops at signature", async () => {
    const f = await fixture();
    const caseId = await quotedCase(f);
    const reminders = new CapturingSender();
    const deps = { sender: reminders, env: process.env };

    // Not yet due (quote is fresh).
    let store = f.store;
    let summary = await processQuoteReminders(store, deps);
    expect(summary.sent).toBe(0);

    // +25h: reminder 1. Then keep ageing the record by a day at a
    // time: reminders 2, 3, 4 land, and the 5th pass is capped.
    for (let k = 1; k <= 4; k++) {
      store = backdate(f.storeFile, 25);
      summary = await processQuoteReminders(store, deps);
      expect(summary.sent).toBe(1);
      const row = await store.getNotification(caseId, `quote_reminder_v1_${k}`);
      expect(row?.status).toBe("sent");
    }
    expect(reminders.sent).toHaveLength(4);
    expect(reminders.sent[0].subject).toContain("Reminder");
    expect(reminders.sent[0].body).toContain(`${WEB_BASE}/quote/rnappr_`); store = backdate(f.storeFile, 25);
    summary = await processQuoteReminders(store, deps);
    expect(summary.sent).toBe(0);
    expect(summary.capped).toBe(1);

    // Signing stops the cadence entirely.
    await signQuote(
      store,
      caseId,
      { name: "Jane Customer", attribution: "" },
      { type: "STAFF", id: "staff-1" }
    );
    summary = await processQuoteReminders(store, deps);
    expect(summary.examined).toBe(0);
    expect(reminders.sent).toHaveLength(4);
  });

  it("sends nothing for an expired quote", async () => {
    const f = await fixture();
    const caseId = await quotedCase(f);
    const reminders = new CapturingSender();
    // Age the quote past its 5-day validity (created AND expiry).
    const store = backdate(f.storeFile, 24 * 6, { shiftExpiry: true });
    const summary = await processQuoteReminders(store, {
      sender: reminders,
      env: process.env
    });
    expect(summary.examined).toBe(0);
    expect(reminders.sent).toHaveLength(0);
    void caseId;
  });

  it("the reminder endpoint requires staff auth or the cron secret", async () => {
    const f = await fixture();
    await quotedCase(f);
    await request(f.app).post("/api/v1/jobs/quote-reminders").send({}).expect(401);

    process.env.QUOTE_REMINDER_CRON_SECRET = "test-cron-secret";
    const viaCron = await request(f.app)
      .post("/api/v1/jobs/quote-reminders")
      .set("x-cron-secret", "test-cron-secret")
      .send({})
      .expect(200);
    expect(viaCron.body.ok).toBe(true);

    const viaStaff = await staff(f).post("/api/v1/jobs/quote-reminders").send({}).expect(200);
    expect(viaStaff.body.ok).toBe(true);
  });
});
