import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { notifyJobCompleted } from "../src/notifications.js";
import {
  createSmsSender,
  normalizePhoneE164,
  type SmsSender
} from "../src/sms.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

const TEST_AUTH_SECRET = "test-auth-secret-0123456789";
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };
const WEB_BASE = "https://example.test";
const REVIEW_URL = "https://g.page/r/CZOjkKSvodOTEBM/review";

class CapturingSender implements SmsSender {
  readonly name = "capture";
  sent: { to: string; body: string }[] = [];
  async send(message: { to: string; body: string }) {
    this.sent.push(message);
    return { providerMessageId: `capture-${this.sent.length}` };
  }
}

class FailingSender implements SmsSender {
  readonly name = "failing";
  async send(): Promise<{ providerMessageId: string }> {
    throw new Error("provider exploded");
  }
}

interface Fixture {
  app: ReturnType<typeof createApp>;
  token: string;
  store: JsonCaseStore;
}

async function fixture(sender: SmsSender): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-notifications-"));
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
      quotingConfig: { expiry_hours: 72 },
      smsSender: sender
    }
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  return { app, token: login.body.token as string, store };
}

const staff = (f: Fixture) => ({
  post: (url: string) => request(f.app).post(url).set("Authorization", `Bearer ${f.token}`),
  get: (url: string) => request(f.app).get(url).set("Authorization", `Bearer ${f.token}`)
});

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  staff(f).post(`/api/v1/cases/${caseId}/actions`).send({ action, ...body });

/** Creates a DIRECT case and drives it to PRICE_APPROVED (quote auto-sent). */
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
  expect(priced.body.current_state).toBe("QUOTE_SENT");
  return caseId;
}

const signatureDataUrl = () =>
  "data:image/png;base64," + Buffer.alloc(1024, 7).toString("base64");

/** Signs the quote; returns the case id + the sign-time tracking token. */
async function signedCase(f: Fixture): Promise<{ caseId: string; trackingToken: string }> {
  const caseId = await approvedCase(f);
  const link = await staff(f).post(`/api/v1/cases/${caseId}/quote-link`).expect(200);
  const signed = await request(f.app)
    .post(`/api/v1/public/quote/${link.body.token}/sign`)
    .send({ name: "Jane Customer", signature_data_url: signatureDataUrl() })
    .expect(200);
  return { caseId, trackingToken: signed.body.tracking_token as string };
}

/** Records the intake contact the way the public intake flow does. */
async function seedIntakeContact(
  f: Fixture,
  caseId: string,
  phone: string | null = "6175550123"
): Promise<void> {
  await f.store.appendEvent({
    caseId,
    eventType: "CLIENT_INTAKE_SUBMITTED",
    actor: { type: "CUSTOMER", id: null },
    payload: {
      customer_name: "Jane Customer",
      ...(phone ? { customer_phone: phone } : {})
    }
  });
}

async function walkToServiceStarted(f: Fixture, caseId: string): Promise<void> {
  await act(f, caseId, "order_parts").expect(200);
  await act(f, caseId, "schedule_installation", { scheduled_at: "2026-11-04T14:00:00Z" }).expect(200);
  await act(f, caseId, "dispatch_technician", { technician_name: "Lou" }).expect(200);
  await act(f, caseId, "start_service").expect(200);
}

beforeEach(() => {
  process.env.WEB_BASE_URL = WEB_BASE;
});

afterEach(() => {
  delete process.env.WEB_BASE_URL;
  vi.restoreAllMocks();
});

describe("Job-completion text (Nelly, 2026-11-03)", () => {
  it("texts the client once on completion — tracker link + review link in the body", async () => {
    const sender = new CapturingSender();
    const f = await fixture(sender);
    const { caseId, trackingToken } = await signedCase(f);
    await seedIntakeContact(f, caseId);
    await walkToServiceStarted(f, caseId);

    // Before completion the tracker carries NO review link.
    const before = await request(f.app).get(`/api/v1/public/track/${trackingToken}`).expect(200);
    expect(before.body.current_state).toBe("INSTALLATION_IN_PROGRESS");
    expect(before.body.review_url).toBeNull();

    await act(f, caseId, "complete_service").expect(200);

    // Exactly one text, to the intake phone in E.164, carrying both links.
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toBe("+16175550123");
    expect(sender.sent[0].body).toContain("Hi Jane");
    expect(sender.sent[0].body).toContain(REVIEW_URL);
    const trackerMatch = sender.sent[0].body.match(/https:\/\/example\.test\/track\/rnappr_[0-9a-f]+/);
    expect(trackerMatch).not.toBeNull();
    // The link in the text actually opens the tracker.
    const smsToken = trackerMatch![0].split("/track/")[1];
    await request(f.app).get(`/api/v1/public/track/${smsToken}`).expect(200);

    // The durable record: sent, by the injected driver, with the audit
    // note that its link was minted at completion over an active one.
    const record = await f.store.getNotification(caseId, "job_completed");
    expect(record?.status).toBe("sent");
    expect(record?.provider).toBe("capture");
    expect(record?.provider_message_id).toBe("capture-1");
    expect(record?.sent_at).toBeTruthy();
    expect(record?.note).toMatch(/earlier tracking link was already active/);

    // Staff see the status on the case detail.
    const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    expect(detail.body.completion_notification.status).toBe("sent");
    expect(detail.body.completion_notification.sent_at).toBeTruthy();

    // The tracker now shows the completion state + review link.
    const after = await request(f.app).get(`/api/v1/public/track/${trackingToken}`).expect(200);
    expect(after.body.current_state).toBe("SERVICE_COMPLETED");
    expect(after.body.review_url).toBe(REVIEW_URL);

    // A duplicate completion attempt is rejected and sends nothing new.
    await act(f, caseId, "complete_service").expect(409);
    expect(sender.sent).toHaveLength(1);
    // And the domain function itself is idempotent on the same row.
    const again = await notifyJobCompleted(f.store, caseId, { sender });
    expect(again?.id).toBe(record?.id);
    expect(sender.sent).toHaveLength(1);
  });

  it("records 'failed' when the provider errors — completion still succeeds", async () => {
    const sender = new FailingSender();
    const f = await fixture(sender);
    const { caseId } = await signedCase(f);
    await seedIntakeContact(f, caseId);
    await walkToServiceStarted(f, caseId);

    const done = await act(f, caseId, "complete_service").expect(200);
    expect(done.body.current_state).toBe("SERVICE_COMPLETED");

    const record = await f.store.getNotification(caseId, "job_completed");
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("provider exploded");
    expect(record?.sent_at).toBeNull();

    const detail = await staff(f).get(`/api/v1/cases/${caseId}`).expect(200);
    expect(detail.body.completion_notification.status).toBe("failed");
  });

  it("records 'skipped' when the case carries no client phone", async () => {
    const sender = new CapturingSender();
    const f = await fixture(sender);
    const { caseId } = await signedCase(f);
    // No intake contact seeded — a staff-created case has no phone.
    await walkToServiceStarted(f, caseId);

    await act(f, caseId, "complete_service").expect(200);
    expect(sender.sent).toHaveLength(0);

    const record = await f.store.getNotification(caseId, "job_completed");
    expect(record?.status).toBe("skipped");
    expect(record?.note).toMatch(/No client phone/);
  });
});

describe("SMS seam", () => {
  it("normalizes client phones to E.164", () => {
    expect(normalizePhoneE164("6175550123")).toBe("+16175550123");
    expect(normalizePhoneE164("617-555-0123")).toBe("+16175550123");
    expect(normalizePhoneE164("1 (617) 555-0123")).toBe("+16175550123");
    expect(normalizePhoneE164("+16175550123")).toBe("+16175550123");
    expect(normalizePhoneE164("555-0123")).toBeNull();
    expect(normalizePhoneE164("")).toBeNull();
    expect(normalizePhoneE164(null)).toBeNull();
    expect(normalizePhoneE164(undefined)).toBeNull();
  });

  it("falls back to the mock driver when Twilio is half-configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sender = createSmsSender({ SMS_PROVIDER: "twilio" });
    expect(sender.name).toBe("mock");
    expect(warn).toHaveBeenCalled();
    expect(createSmsSender({}).name).toBe("mock");
  });

  it("sends through Twilio's Messages API when fully configured", async () => {
    const calls: { url: string; init?: Record<string, unknown> }[] = [];
    const fakeFetch = async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ sid: "SM123" }),
        text: async () => ""
      };
    };
    const sender = createSmsSender(
      {
        SMS_PROVIDER: "twilio",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "token-xyz",
        TWILIO_FROM_NUMBER: "+16175550000"
      },
      fakeFetch as never
    );
    expect(sender.name).toBe("twilio");
    const result = await sender.send({ to: "+16175550123", body: "hello" });
    expect(result.providerMessageId).toBe("SM123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"
    );
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("AC123:token-xyz").toString("base64")}`
    );
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get("To")).toBe("+16175550123");
    expect(form.get("From")).toBe("+16175550000");
    expect(form.get("Body")).toBe("hello");
  });

  it("throws Twilio's own error detail on a rejected send", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: "The 'To' number is not valid.", code: 21211 }),
      text: async () => ""
    });
    const sender = createSmsSender(
      {
        SMS_PROVIDER: "twilio",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "token-xyz",
        TWILIO_FROM_NUMBER: "+16175550000"
      },
      fakeFetch as never
    );
    await expect(sender.send({ to: "+1", body: "hi" })).rejects.toThrow(
      /Twilio send failed: The 'To' number is not valid\. \(Twilio code 21211\)/
    );
  });
});
