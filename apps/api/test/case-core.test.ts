import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { JsonCaseStore } from "../src/store.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-case-core-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  return { store, app: createApp(store) };
}

const input = {
  channel: "DIRECT",
  vehicle: {
    year: 2018,
    make: "Jeep",
    model: "Wrangler",
    vin: "1C4HJXEG3JW224862"
  },
  glass_request: {
    glass_type: "WINDSHIELD"
  }
};

describe("Case Core API", () => {
  it("creates one canonical Case and durable CASE_CREATED event", async () => {
    const { app } = fixture();
    const create = await request(app).post("/api/v1/cases").send(input).expect(201);

    expect(create.body.reference).toMatch(/^RRA-\d{6}$/);
    expect(create.body.current_state).toBe("REQUEST_RECEIVED");
    expect(create.body.channel).toBe("DIRECT");
    expect(create.body.vehicle.vin).toBe(input.vehicle.vin);

    const events = await request(app)
      .get(`/api/v1/cases/${create.body.id}/events`)
      .expect(200);

    expect(events.body).toHaveLength(1);
    expect(events.body[0]).toMatchObject({
      sequence: 1,
      event_type: "CASE_CREATED"
    });
  });

  it("persists DIRECT, AUCTION and INSURANCE through one model", async () => {
    const { app } = fixture();
    for (const channel of ["DIRECT", "AUCTION", "INSURANCE"]) {
      await request(app).post("/api/v1/cases").send({ ...input, channel }).expect(201);
    }

    const list = await request(app).get("/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(3);
    expect(new Set(list.body.map((c: any) => c.channel))).toEqual(
      new Set(["DIRECT", "AUCTION", "INSURANCE"])
    );
  });

  it("guards duplicate create submission with Idempotency-Key", async () => {
    const { app } = fixture();
    const first = await request(app)
      .post("/api/v1/cases")
      .set("Idempotency-Key", "create-123")
      .send(input)
      .expect(201);

    const second = await request(app)
      .post("/api/v1/cases")
      .set("Idempotency-Key", "create-123")
      .send(input)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);

    const list = await request(app).get("/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("does not allow arbitrary/unimplemented state actions", async () => {
    const { app } = fixture();
    const create = await request(app).post("/api/v1/cases").send(input).expect(201);

    await request(app)
      .post(`/api/v1/cases/${create.body.id}/actions`)
      .send({ action: "SET_STATE", input: { state: "COMPLETED" } })
      .expect(409);

    const detail = await request(app).get(`/api/v1/cases/${create.body.id}`).expect(200);
    expect(detail.body.current_state).toBe("REQUEST_RECEIVED");
  });

  it("returns validation errors without persisting partial data", async () => {
    const { app } = fixture();
    await request(app)
      .post("/api/v1/cases")
      .send({ ...input, vehicle: { ...input.vehicle, vin: "" } })
      .expect(422);

    const list = await request(app).get("/api/v1/cases").expect(200);
    expect(list.body).toHaveLength(0);
  });
});
