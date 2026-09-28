import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { JsonCaseStore } from "../src/store.js";

const TEST_AUTH_SECRET = "test-secret-for-security-tests";

async function fixture(securityConfig: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-security-"));
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
    securityConfig
  );
  return { app };
}

describe("Security hardening", () => {
  it("sets baseline security headers", async () => {
    const { app } = await fixture();
    const res = await request(app).get("/health").expect(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("restricts CORS to the configured origins", async () => {
    const { app } = await fixture({
      corsOrigins: ["https://app.example.com"]
    });

    const allowed = await request(app)
      .get("/health")
      .set("Origin", "https://app.example.com")
      .expect(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );

    const denied = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.com")
      .expect(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate-limits repeated login attempts", async () => {
    const { app } = await fixture({
      loginRateLimitMax: 2,
      loginRateLimitWindowMs: 60_000
    });
    const attempt = () =>
      request(app)
        .post("/api/v1/auth/login")
        .send({ email: "staff@example.com", password: "wrong" });

    await attempt().expect(401);
    await attempt().expect(401);

    const limited = await attempt().expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("allows a successful login under the rate limit", async () => {
    const { app } = await fixture({
      loginRateLimitMax: 2,
      loginRateLimitWindowMs: 60_000
    });
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
  });

  it("rejects malformed JSON with 400, not 500", async () => {
    const { app } = await fixture();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{not valid json")
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects oversized JSON bodies with 413", async () => {
    const { app } = await fixture();
    const big = "x".repeat(300 * 1024);
    await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "staff@example.com", password: big }))
      .expect(413);
  });

  it("requires authentication on every case route", async () => {
    const { app } = await fixture();
    await request(app).get("/api/v1/cases").expect(401);
    await request(app).get("/api/v1/cases/whatever").expect(401);
    await request(app)
      .get("/api/v1/cases")
      .set("Authorization", "Bearer garbage.token.here")
      .expect(401);
  });

  it("does not leak stack traces or internals on errors", async () => {
    const { app } = await fixture();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{broken")
      .expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|at /i);
  });
});
