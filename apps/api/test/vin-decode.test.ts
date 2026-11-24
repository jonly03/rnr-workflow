import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { JsonCaseStore } from "../src/store.js";
import { hashPassword } from "../src/auth.js";

const TEST_AUTH_SECRET = "test-secret-for-vin-decode";

async function authedFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-vin-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const app = createApp(store, { authSecret: TEST_AUTH_SECRET });
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  return { app, token: login.body.token as string };
}

describe("VIN decode (NHTSA vPIC)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // Mock NHTSA response for a known test VIN.
        if (url.includes("1HGCM82633A004352")) {
          return {
            ok: true,
            json: async () => ({
              Results: [
                { Variable: "Model Year", Value: "2003" },
                { Variable: "Make", Value: "Honda" },
                { Variable: "Model", Value: "Accord" },
                { Variable: "Trim", Value: "EX" },
                { Variable: "Body Class", Value: "Sedan" }
              ]
            })
          } as Response;
        }
        // Unknown VIN: NHTSA returns empty values.
        return {
          ok: true,
          json: async () => ({
            Results: [
              { Variable: "Model Year", Value: "" },
              { Variable: "Make", Value: "" },
              { Variable: "Model", Value: "" }
            ]
          })
        } as Response;
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("decodes a valid VIN to YMM via NHTSA", async () => {
    const { app, token } = await authedFixture();
    const res = await request(app)
      .post("/api/v1/vin/decode")
      .set("Authorization", `Bearer ${token}`)
      .send({ vin: "1HGCM82633A004352" })
      .expect(200);

    expect(res.body.vehicle).toMatchObject({
      vin: "1HGCM82633A004352",
      year: 2003,
      make: "Honda",
      model: "Accord",
      trim: "EX"
    });
  });

  it("rejects a malformed VIN with 422", async () => {
    const { app, token } = await authedFixture();
    const res = await request(app)
      .post("/api/v1/vin/decode")
      .set("Authorization", `Bearer ${token}`)
      .send({ vin: "TOOSHORT" })
      .expect(422);

    expect(res.body.error.code).toBe("VIN_DECODE_FAILED");
  });

  it("rejects a VIN with an invalid check digit with 422", async () => {
    const { app, token } = await authedFixture();
    // All-A is format-valid but fails the ISO 3779 check digit, so it is
    // rejected by the shared VIN gate before NHTSA is ever called.
    const res = await request(app)
      .post("/api/v1/vin/decode")
      .set("Authorization", `Bearer ${token}`)
      .send({ vin: "AAAAAAAAAAAAAAAAA" })
      .expect(422);

    expect(res.body.error.code).toBe("VIN_DECODE_FAILED");
    expect(res.body.error.message).toMatch(/check digit/);
  });

  it("requires authentication", async () => {
    const { app } = await authedFixture();
    await request(app)
      .post("/api/v1/vin/decode")
      .send({ vin: "1HGCM82633A004352" })
      .expect(401);
  });
});

describe("vehicle descriptor + customer part line (Nelly, 2026-11-23)", () => {
  it("composes the bZ4X descriptor exactly as specified", async () => {
    const { composeVehicleDescriptor, composeGlassLineDescription } = await import(
      "../src/vin-decode.js"
    );
    // A 2023 Toyota bZ4X as vPIC reports it.
    const descriptor = composeVehicleDescriptor({
      bodyClass: "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)",
      driveType: "AWD/All-Wheel Drive",
      doors: "5",
      fuelType: "Electric",
      electrificationLevel: "BEV (Battery Electric Vehicle)",
      plantCountry: "JAPAN"
    });
    expect(descriptor).toBe("Electric SUV · AWD · 5-door · built in Japan");
    const line = composeGlassLineDescription({
      glassType: "WINDSHIELD",
      vehicle: { year: 2023, make: "Toyota", model: "bZ4X" },
      descriptor
    });
    expect(line).toBe(
      "Glass — windshield for your 2023 Toyota bZ4X · Electric SUV · AWD · 5-door · built in Japan"
    );
  });

  it("omits attributes the decode does not report instead of guessing", async () => {
    const { composeVehicleDescriptor, composeGlassLineDescription } = await import(
      "../src/vin-decode.js"
    );
    expect(composeVehicleDescriptor({})).toBe("");
    expect(
      composeVehicleDescriptor({ bodyClass: "Sedan/Saloon", doors: "4" })
    ).toBe("Sedan · 4-door");
    // No descriptor captured: the line still mirrors year/make/model.
    expect(
      composeGlassLineDescription({
        glassType: "DOOR_GLASS",
        vehicle: { year: 2020, make: "Honda", model: "Accord" },
        descriptor: null
      })
    ).toBe("Glass — door glass for your 2020 Honda Accord");
  });
});
