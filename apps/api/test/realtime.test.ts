import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { createRealtimeServer, STAFF_EVENTS_PATH } from "../src/realtime.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { JsonCaseStore } from "../src/store.js";

/**
 * Staff realtime feed (Nelly, 2026-10-20): the staff dashboard must not
 * need a manual refresh to see a case a client just submitted. The API
 * pushes a case_event notification over a WebSocket for every appended
 * case event; auth is the staff session JWT, verified before upgrade.
 */

const TEST_AUTH_SECRET = "test-secret";
const VIN_17 = "1HGCM82633A004352";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };

interface Fixture {
  server: Server;
  base: string;
  token: string;
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-realtime-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const staff = await store.createStaffUser({
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
      quotingConfig: { expiry_hours: 72 }
    }
  );
  const server = createRealtimeServer(app, store, TEST_AUTH_SECRET);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    token: signToken(staff, TEST_AUTH_SECRET)
  };
}

function connect(base: string, token: string): WebSocket {
  const ws = new WebSocket(
    `${base.replace("http://", "ws://")}${STAFF_EVENTS_PATH}?token=${token}`
  );
  sockets.push(ws);
  return ws;
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(String(data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", reject);
  });
}

function collectMessages(
  ws: WebSocket,
  until: (messages: Record<string, unknown>[]) => boolean,
  timeoutMs = 5000
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out; got ${JSON.stringify(messages)}`));
    }, timeoutMs);
    const onMessage = (data: unknown) => {
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
      if (until(messages)) {
        cleanup();
        resolve(messages);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

describe("Staff realtime feed", () => {
  it("pushes case_event notifications when a client intake lands", async () => {
    const f = await fixture();
    const ws = connect(f.base, f.token);
    const ready = await nextMessage(ws);
    expect(ready.type).toBe("ready");

    const eventsPromise = collectMessages(
      ws,
      (messages) =>
        messages.some((m) => m.event_type === "CLIENT_INTAKE_SUBMITTED") &&
        messages.filter((m) => m.type === "case_event").length >= 2
    );

    await request(f.server)
      .post("/api/v1/public/intake")
      .send({
        customer_name: "Jane Customer",
        customer_phone: "(617) 555-0142",
        glass_type: "WINDSHIELD",
        vin: VIN_17,
        year: 2020,
        make: "Honda",
        model: "Accord"
      })
      .expect(201);

    const messages = await eventsPromise;
    const caseEvents = messages.filter((m) => m.type === "case_event");
    expect(caseEvents.length).toBeGreaterThanOrEqual(2);
    // Every notification for this intake shares one case_id, and the
    // projection never carries case data — ids and event types only.
    expect(new Set(caseEvents.map((m) => m.case_id)).size).toBe(1);
    for (const message of caseEvents) {
      expect(Object.keys(message).sort()).toEqual(
        ["case_id", "event_type", "occurred_at", "sequence", "type"].sort()
      );
    }
  });

  it("rejects a socket whose token is not a staff session", async () => {
    const f = await fixture();
    const ws = connect(f.base, "not-a-real-token");
    const outcome = await new Promise<string>((resolve) => {
      ws.on("message", () => resolve("message"));
      ws.on("error", (error) => resolve(`error:${error.message}`));
      ws.on("close", () => resolve("close"));
      setTimeout(() => resolve("timeout"), 3000);
    });
    expect(outcome).not.toBe("message");
    expect(outcome.startsWith("error:")).toBe(true);
  });
});
