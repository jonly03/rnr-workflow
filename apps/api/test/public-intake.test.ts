import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type SecurityConfig } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { JsonCaseStore } from "../src/store.js";

const TEST_AUTH_SECRET = "<redacted>";
const VIN_17 = "1HGCM82633A004352";
const OTHER_VIN = "1C4HJXEG3JW224862";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };

/** 1x1 transparent PNG — a stand-in photo upload for intake tests. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64"
);

interface Fixture {
  app: ReturnType<typeof createApp>;
  token: string;
}

async function fixture(
  securityConfig: SecurityConfig = {},
  deps: { vinOcr?: (image: Buffer) => Promise<{ vin: string | null; rawText: string }> } = {}
): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-public-intake-"));
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
    securityConfig,
    {
      glassCatalog: new MockGlassCatalogProvider(),
      sourcingProvider: new MockSourcingProvider(),
      pricingConfig: PRICING,
      ...deps
    }
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  return { app, token: login.body.token as string };
}

const staffGet = (f: Fixture, url: string) =>
  request(f.app).get(url).set("Authorization", `Bearer ${f.token}`);

const intake = (f: Fixture, body: Record<string, unknown>) =>
  request(f.app).post("/api/v1/public/intake").send(body);

/** A picked service address, in the mock provider's fixture shape. */
const SERVICE_ADDRESS = {
  place_id: "mock:terrace-118",
  formatted: "118 Terrace St, Boston, MA 02120",
  street: "118 Terrace St",
  city: "Boston",
  state: "Massachusetts",
  zip: "02120",
  lat: 42.3349,
  lon: -71.0828
};

const VALID = {
  customer_name: "Jane Customer",
  customer_phone: "(617) 555-0142",
  glass_type: "WINDSHIELD",
  vin: VIN_17,
  year: 2020,
  make: "Honda",
  model: "Accord",
  service_address: SERVICE_ADDRESS
};

describe("Public client intake (QR front door)", () => {
  it("creates a well-formed DIRECT case flagged CLIENT_QR with customer contact for staff", async () => {
    const f = await fixture();
    const res = await intake(f, { ...VALID, note: "Cracked on the highway" }).expect(201);

    // Client-safe confirmation ONLY: reference + what happens next +
    // the view-only status token the confirmation page polls behind.
    expect(Object.keys(res.body).sort()).toEqual(["message", "ok", "reference", "status_token"]);
    expect(res.body.status_token).toMatch(/^rnappr_/);
    expect(res.body.ok).toBe(true);
    expect(res.body.reference).toMatch(/^RRA-\d{6}$/);
    expect(res.body.message).toContain("text a quote link");

    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(1);
    const c = list.body[0];
    expect(c.reference).toBe(res.body.reference);
    expect(c.channel).toBe("DIRECT");
    // The submission drives itself through identification → pricing →
    // auto-quote: no staff click happens anywhere in this test.
    expect(c.current_state).toBe("QUOTE_SENT");
    expect(c.quote).not.toBeNull();
    expect(c.quote.status).toBe("SENT");
    expect(c.vehicle).toMatchObject({ year: 2020, make: "Honda", model: "Accord", vin: VIN_17 });
    expect(c.glass_request.glass_type).toBe("WINDSHIELD");
    // Staff see who sent it and how to reach them (quote link goes by text).
    expect(c.client_intake).toMatchObject({
      source: "CLIENT_QR",
      customer_name: "Jane Customer",
      customer_phone: "(617) 555-0142",
      note: "Cracked on the highway",
      vin_ocr_suggestion: null,
      photo_count: 0,
      // …and where the car will be serviced (the picked address).
      service_address: SERVICE_ADDRESS
    });

    const events = await staffGet(f, `/api/v1/cases/${c.id}/events`).expect(200);
    const created = events.body.find((e: { event_type: string }) => e.event_type === "CASE_CREATED");
    expect(created.actor_type).toBe("CUSTOMER");
    const submitted = events.body.find(
      (e: { event_type: string }) => e.event_type === "CLIENT_INTAKE_SUBMITTED"
    );
    expect(submitted).toBeDefined();
    expect(submitted.payload.source).toBe("CLIENT_QR");
    expect(submitted.payload.customer_phone).toBe("(617) 555-0142");
  });

  it("accepts an intake with no note (3-card flow) and projects note as null; a legacy note is still honored", async () => {
    const f = await fixture();
    const res = await intake(f, VALID).expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    expect(c.client_intake.note).toBeNull();

    // Backward compatibility: a client still sending the removed field
    // (older cached page) is accepted and staff still see the note.
    const legacy = await intake(f, { ...VALID, note: "Legacy client note" }).expect(201);
    const list2 = await staffGet(f, "/api/v1/cases").expect(200);
    const legacyCase = list2.body.find(
      (x: { reference: string }) => x.reference === legacy.body.reference
    );
    expect(legacyCase.client_intake.note).toBe("Legacy client note");
  });

  it("accepts exactly 6 damage photos (the one-per-glass cap)", async () => {
    const f = await fixture();
    let req = request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jane Customer")
      .field("customer_phone", "6175550142")
      .field("glass_type", "WINDSHIELD")
      .field("vin", VIN_17)
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord")
      .field("service_address", JSON.stringify(SERVICE_ADDRESS));
    for (let i = 0; i < 6; i++) {
      req = req.attach("photos", TINY_PNG, `p${i}.jpg`);
    }
    const res = await req.expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    expect(c.client_intake.photo_count).toBe(6);
  });

  it("accepts a YMM-only intake (no VIN) and stores an empty VIN", async () => {
    const f = await fixture();
    const { vin: _vin, ...ymmOnly } = VALID;
    const res = await intake(f, ymmOnly).expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    expect(c.vehicle.vin).toBe("");
    expect(c.client_intake.source).toBe("CLIENT_QR");
  });

  it("leaks nothing internal and nothing about other cases", async () => {
    const f = await fixture();
    // A pre-existing staff case with a distinctive VIN.
    await request(f.app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${f.token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2018, make: "Jeep", model: "Wrangler", vin: OTHER_VIN },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);

    const res = await intake(f, VALID).expect(201);
    const raw = JSON.stringify(res.body);
    for (const forbidden of [
      "supplier",
      "glass_cost",
      "profit",
      "sell_price",
      "current_state",
      "REQUEST_RECEIVED",
      VIN_17,
      OTHER_VIN
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("rejects a VIN with a bad check digit and creates no case", async () => {
    const f = await fixture();
    await intake(f, { ...VALID, vin: "1HGCM82633A004353" }).expect(422);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(0);
  });

  it("rejects missing name, missing/unusable phone, bad glass type, and no vehicle info", async () => {
    const f = await fixture();
    const { customer_name: _n, ...noName } = VALID;
    await intake(f, noName).expect(422);
    const { customer_phone: _p, ...noPhone } = VALID;
    await intake(f, noPhone).expect(422);
    await intake(f, { ...VALID, customer_phone: "call me" }).expect(422);
    await intake(f, { ...VALID, glass_type: "SUNROOF" }).expect(422);
    const { vin: _v, year: _y, make: _mk, model: _md, ...noVehicle } = VALID;
    await intake(f, noVehicle).expect(422);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(0);
  });

  it("service address: a missing one is a 400 naming the field; free text is accepted (demo relaxation 2026-10-22)", async () => {
    const f = await fixture();
    const { service_address: _sa, ...noAddress } = VALID;
    const missing = await intake(f, noAddress).expect(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
    expect(missing.body.error.details.field).toBe("service_address");

    // Free text is accepted while no live address provider is
    // configured: a plain typed string, and an object carrying only
    // the formatted address (no place id), both create the case.
    await intake(f, {
      ...VALID,
      service_address: "118 Terrace St, Boston, MA 02120"
    }).expect(201);
    const { place_id: _pid, ...noPlaceId } = SERVICE_ADDRESS;
    await intake(f, { ...VALID, service_address: noPlaceId }).expect(201);

    // Structured fields that ARE supplied are still validated.
    await intake(f, {
      ...VALID,
      service_address: { ...SERVICE_ADDRESS, zip: "0212" }
    }).expect(400);
    await intake(f, {
      ...VALID,
      service_address: { ...SERVICE_ADDRESS, city: "" }
    }).expect(400);

    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(2);
  });

  it("stores the picked service address on the intake event for staff", async () => {
    const f = await fixture();
    const res = await intake(f, VALID).expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    const events = await staffGet(f, `/api/v1/cases/${c.id}/events`).expect(200);
    const submitted = events.body.find(
      (e: { event_type: string }) => e.event_type === "CLIENT_INTAKE_SUBMITTED"
    );
    expect(submitted.payload.service_address).toEqual(SERVICE_ADDRESS);
  });

  it("tightened field validation: 1-char name, non-10-digit phones, out-of-range YMM years are rejected", async () => {
    const f = await fixture();
    await intake(f, { ...VALID, customer_name: "J" }).expect(422);
    // 7-digit local number: not a textable US mobile.
    await intake(f, { ...VALID, customer_phone: "555-0142" }).expect(422);
    await intake(f, { ...VALID, customer_phone: "016-555-0142" }).expect(422);
    // Country-code and punctuation formats ARE accepted.
    await intake(f, { ...VALID, customer_phone: "+1 (617) 555-0142" }).expect(201);
    await intake(f, { ...VALID, customer_phone: "617.555.0142" }).expect(201);
    // YMM path year bounds: 1950..next year.
    const { vin: _v, ...ymm } = VALID;
    await intake(f, { ...ymm, year: 1949 }).expect(422);
    await intake(f, { ...ymm, year: new Date().getFullYear() + 2 }).expect(422);
    await intake(f, { ...ymm, year: 1950 }).expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(3);
  });

  it("ignores smuggled internal fields (channel, state, pricing)", async () => {
    const f = await fixture();
    const res = await intake(f, {
      ...VALID,
      channel: "INSURANCE",
      current_state: "PRICE_APPROVED",
      customer_id: "00000000-0000-0000-0000-000000000000"
    }).expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    expect(c.channel).toBe("DIRECT");
    // The smuggled PRICE_APPROVED was not honored: the case reached
    // QUOTE_SENT by driving the real flow itself, not by fiat.
    expect(c.current_state).toBe("QUOTE_SENT");
    expect(c.customer_id).toBeNull();
  });

  it("accepts multipart damage photos and records metadata only", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jane Customer")
      .field("customer_phone", "6175550142")
      .field("glass_type", "WINDSHIELD")
      .field("vin", VIN_17)
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord")
      .field("service_address", JSON.stringify(SERVICE_ADDRESS))
      .attach("photos", TINY_PNG, "crack.jpg")
      .expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    expect(c.client_intake.photo_count).toBe(1);
    const events = await staffGet(f, `/api/v1/cases/${c.id}/events`).expect(200);
    const submitted = events.body.find(
      (e: { event_type: string }) => e.event_type === "CLIENT_INTAKE_SUBMITTED"
    );
    expect(submitted.payload.photos).toEqual([
      { kind: "damage", size_bytes: TINY_PNG.length, content_type: "image/jpeg" }
    ]);
  });

  it("rejects an oversized photo with 413 and too many photos with 400", async () => {
    const f = await fixture();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    await request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jane Customer")
      .field("customer_phone", "6175550142")
      .field("glass_type", "WINDSHIELD")
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord")
      .attach("photos", big, "huge.jpg")
      .expect(413);

    let tooMany = request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jane Customer")
      .field("customer_phone", "6175550142")
      .field("glass_type", "WINDSHIELD")
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord");
    for (let i = 0; i < 7; i++) {
      tooMany = tooMany.attach("photos", TINY_PNG, `p${i}.jpg`);
    }
    await tooMany.expect(400);

    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(0);
  });

  it("rate-limits repeated submissions per IP", async () => {
    const f = await fixture({ intakeRateLimitMax: 3 });
    await intake(f, VALID).expect(201);
    await intake(f, VALID).expect(201);
    await intake(f, VALID).expect(201);
    const limited = await intake(f, VALID).expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("runs VIN-photo OCR as a suggestion only — it never overwrites a typed VIN and never fills an untyped one", async () => {
    // OCR "reads" a completely different VIN from the photo. Neither
    // case may adopt it as the vehicle VIN: it is staff-suggestion only.
    const OCR_VIN = "1FTFW1ET5DFC10312";
    const f = await fixture({}, {
      vinOcr: async () => ({ vin: OCR_VIN, rawText: `plate ${OCR_VIN}` })
    });
    const typed = await request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jane Customer")
      .field("customer_phone", "6175550142")
      .field("glass_type", "WINDSHIELD")
      .field("vin", VIN_17)
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord")
      .field("service_address", JSON.stringify(SERVICE_ADDRESS))
      .attach("vin_photo", TINY_PNG, "vin.jpg")
      .expect(201);
    const untyped = await request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "John Customer")
      .field("customer_phone", "6175550143")
      .field("glass_type", "BACK_GLASS")
      .field("year", "2021")
      .field("make", "Ford")
      .field("model", "F-150")
      .field("service_address", JSON.stringify(SERVICE_ADDRESS))
      .attach("vin_photo", TINY_PNG, "vin.jpg")
      .expect(201);

    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const typedCase = list.body.find(
      (x: { reference: string }) => x.reference === typed.body.reference
    );
    expect(typedCase.vehicle.vin).toBe(VIN_17);
    expect(typedCase.client_intake.vin_ocr_suggestion).toBe(OCR_VIN);
    expect(typedCase.client_intake.photo_count).toBe(1);
    const untypedCase = list.body.find(
      (x: { reference: string }) => x.reference === untyped.body.reference
    );
    expect(untypedCase.vehicle.vin).toBe("");
    expect(untypedCase.client_intake.vin_ocr_suggestion).toBe(OCR_VIN);
  });

  it("still creates the case when VIN-photo OCR itself fails", async () => {
    const f = await fixture({}, {
      vinOcr: async () => {
        throw new Error("tesseract exploded");
      }
    });
    const res = await request(f.app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jane Customer")
      .field("customer_phone", "6175550142")
      .field("glass_type", "WINDSHIELD")
      .field("vin", VIN_17)
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord")
      .field("service_address", JSON.stringify(SERVICE_ADDRESS))
      .attach("vin_photo", TINY_PNG, "vin.jpg")
      .expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    const c = list.body.find((x: { reference: string }) => x.reference === res.body.reference);
    expect(c.vehicle.vin).toBe(VIN_17);
    expect(c.client_intake.vin_ocr_suggestion).toBeNull();
  });

  it("staff-created cases project client_intake as null (no badge data)", async () => {
    const f = await fixture();
    await request(f.app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${f.token}`)
      .send({
        channel: "DIRECT",
        vehicle: { year: 2020, make: "Honda", model: "Accord", vin: VIN_17 },
        glass_request: { glass_type: "WINDSHIELD" }
      })
      .expect(201);
    const list = await staffGet(f, "/api/v1/cases").expect(200);
    expect(list.body[0].client_intake).toBeNull();
  });
});
