import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { JsonCaseStore } from "../src/store.js";

const TEST_AUTH_SECRET = "test-secret-for-auth-tests";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-auth-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const app = createApp(store, { authSecret: TEST_AUTH_SECRET });
  return { app, store };
}

describe("Staff auth", () => {
  it("issues a token for valid credentials and /me returns the staff user", async () => {
    const { app } = await fixture();

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);

    expect(typeof login.body.token).toBe("string");
    expect(login.body.staff).toMatchObject({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff"
    });
    expect(login.body.staff).not.toHaveProperty("password_hash");

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
    expect(me.body.staff.email).toBe("staff@example.com");
  });

  it("rejects wrong password and unknown email with the same generic error", async () => {
    const { app } = await fixture();

    const wrongPassword = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "nope" })
      .expect(401);
    const unknownEmail = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@example.com", password: "password123" })
      .expect(401);

    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknownEmail.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPassword.body.error.message).toBe(
      unknownEmail.body.error.message
    );
  });

  it("email lookup is case-insensitive", async () => {
    const { app } = await fixture();
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "STAFF@EXAMPLE.COM", password: "password123" })
      .expect(200);
  });

  it("rejects case routes without a token", async () => {
    const { app } = await fixture();
    await request(app).get("/api/v1/cases").expect(401);
    await request(app)
      .post("/api/v1/cases")
      .send({ channel: "DIRECT" })
      .expect(401);
  });

  it("rejects tampered and wrong-secret tokens", async () => {
    const { app, store } = await fixture();
    const staff = await store.findStaffByEmail("staff@example.com");

    const wrongSecret = signToken(
      {
        id: staff!.id,
        email: staff!.email,
        name: staff!.name,
        role: staff!.role,
        created_at: staff!.created_at
      },
      "a-different-secret"
    );
    await request(app)
      .get("/api/v1/cases")
      .set("Authorization", `Bearer ${wrongSecret}`)
      .expect(401);

    const valid = signToken(
      {
        id: staff!.id,
        email: staff!.email,
        name: staff!.name,
        role: staff!.role,
        created_at: staff!.created_at
      },
      TEST_AUTH_SECRET
    );
    const tampered = valid.slice(0, -2) + "xx";
    await request(app)
      .get("/api/v1/cases")
      .set("Authorization", `Bearer ${tampered}`)
      .expect(401);
  });

  it("rejects expired tokens", async () => {
    const { app, store } = await fixture();
    const staff = await store.findStaffByEmail("staff@example.com");
    const expired = signToken(
      {
        id: staff!.id,
        email: staff!.email,
        name: staff!.name,
        role: staff!.role,
        created_at: staff!.created_at
      },
      TEST_AUTH_SECRET,
      -10 // already expired
    );
    await request(app)
      .get("/api/v1/cases")
      .set("Authorization", `Bearer ${expired}`)
      .expect(401);
  });

  it("keeps /health public for deploy smoke checks", async () => {
    const { app } = await fixture();
    await request(app).get("/health").expect(200);
  });

  it("seeds the staff admin on first login when seed env vars are set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-auth-seed-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    const app = createApp(store, { authSecret: TEST_AUTH_SECRET });

    process.env.STAFF_ADMIN_EMAIL = "seeded-admin@example.com";
    process.env.STAFF_ADMIN_PASSWORD = "seed-password-123";
    try {
      // No staff user exists yet: the login itself performs the seed.
      const first = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "seeded-admin@example.com", password: "seed-password-123" })
        .expect(200);
      expect(typeof first.body.token).toBe("string");
      expect(first.body.staff.email).toBe("seeded-admin@example.com");

      // Second login is idempotent: no duplicate admin is created.
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "seeded-admin@example.com", password: "seed-password-123" })
        .expect(200);
    } finally {
      delete process.env.STAFF_ADMIN_EMAIL;
      delete process.env.STAFF_ADMIN_PASSWORD;
    }
  });

  it("does not seed when seed env vars are absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-auth-noseed-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    const app = createApp(store, { authSecret: TEST_AUTH_SECRET });

    delete process.env.STAFF_ADMIN_EMAIL;
    delete process.env.STAFF_ADMIN_PASSWORD;
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@example.com", password: "whatever" })
      .expect(401);
    expect(await store.findStaffByEmail("nobody@example.com")).toBeNull();
  });
});
