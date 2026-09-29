import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { JsonCaseStore } from "../src/store.js";
import { expectedCheckDigit } from "../src/vin-validation.js";
import type { Channel } from "../src/types.js";

const TEST_AUTH_SECRET = "test-secret-for-channel-tests";

const vehicle = (n: number) => {
  // Build a VIN with a valid ISO 3779 check digit: position 9 has weight
  // 0, so the check digit is computed over the placeholder form.
  const suffix = String(n).padStart(7, "0");
  const placeholder = `1HGCM8260A${suffix}`;
  const check = expectedCheckDigit(placeholder);
  return {
    year: 2020,
    make: "Honda",
    model: "Accord",
    vin: `1HGCM826${check}A${suffix}`
  };
};

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-channels-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const hash = await hashPassword("password123");

  // Full-access staff (no channels claim).
  await store.createStaffUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    passwordHash: hash
  });
  // Channel-scoped staff: DIRECT only.
  await store.createStaffUser({
    email: "direct@example.com",
    name: "Direct Staff",
    role: "staff",
    passwordHash: hash,
    channels: ["DIRECT"]
  });

  const app = createApp(store, { authSecret: TEST_AUTH_SECRET });

  const login = async (email: string) => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "password123" })
      .expect(200);
    return res.body.token as string;
  };

  const createCase = (token: string, channel: Channel) =>
    request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel,
        vehicle: vehicle(Math.floor(Math.random() * 1e7)),
        glass_request: { glass_type: "WINDSHIELD" }
      });

  return { app, login, createCase };
}

describe("Channel isolation", () => {
  it("lets channel-scoped staff create cases in their channel but not others", async () => {
    const { login, createCase } = await fixture();
    const token = await login("direct@example.com");

    await createCase(token, "DIRECT").expect(201);

    const forbidden = await createCase(token, "INSURANCE").expect(403);
    expect(forbidden.body.error.code).toBe("CHANNEL_FORBIDDEN");
  });

  it("hides cross-channel cases from channel-scoped staff (404, not 403)", async () => {
    const { app, login, createCase } = await fixture();
    const adminToken = await login("admin@example.com");
    const scopedToken = await login("direct@example.com");

    const insurance = await createCase(adminToken, "INSURANCE").expect(201);
    const direct = await createCase(adminToken, "DIRECT").expect(201);

    // Single-case reads do not reveal cross-channel existence.
    await request(app)
      .get(`/api/v1/cases/${insurance.body.id}`)
      .set("Authorization", `Bearer ${scopedToken}`)
      .expect(404);
    await request(app)
      .get(`/api/v1/cases/${direct.body.id}`)
      .set("Authorization", `Bearer ${scopedToken}`)
      .expect(200);

    // Events and actions are equally guarded.
    await request(app)
      .get(`/api/v1/cases/${insurance.body.id}/events`)
      .set("Authorization", `Bearer ${scopedToken}`)
      .expect(404);
    await request(app)
      .post(`/api/v1/cases/${insurance.body.id}/actions`)
      .set("Authorization", `Bearer ${scopedToken}`)
      .send({ action: "noop" })
      .expect(404);
  });

  it("filters the case list to the staff member's channels", async () => {
    const { app, login, createCase } = await fixture();
    const adminToken = await login("admin@example.com");
    const scopedToken = await login("direct@example.com");

    await createCase(adminToken, "INSURANCE").expect(201);
    await createCase(adminToken, "DIRECT").expect(201);
    await createCase(adminToken, "AUCTION").expect(201);

    const scoped = await request(app)
      .get("/api/v1/cases")
      .set("Authorization", `Bearer ${scopedToken}`)
      .expect(200);
    expect(scoped.body.map((c: { channel: string }) => c.channel).sort()).toEqual(["DIRECT"]);

    const admin = await request(app)
      .get("/api/v1/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(admin.body).toHaveLength(3);
  });

  it("keeps full access for staff without a channels claim", async () => {
    const { app, login, createCase } = await fixture();
    const adminToken = await login("admin@example.com");

    const insurance = await createCase(adminToken, "INSURANCE").expect(201);
    await request(app)
      .get(`/api/v1/cases/${insurance.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  it("exposes the channels claim on login and /me for channel-scoped staff", async () => {
    const { app } = await fixture();
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "direct@example.com", password: "password123" })
      .expect(200);
    expect(login.body.staff.channels).toEqual(["DIRECT"]);

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
    expect(me.body.staff.channels).toEqual(["DIRECT"]);
  });
});
