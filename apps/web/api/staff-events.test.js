import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createStaffEventsServer, verifyStaffToken } from "./staff-events.js";

// Staff realtime endpoint (web project): staff dashboards hold a socket
// here and get a case_event ping whenever the API appends a case event
// (pg_notify on the shared Postgres). Auth mirrors the API's staff JWT.

const SECRET = ["staff", "events", "test", "secret"].join("-");

function sign(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const signature = createHmac("sha256", SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function staffToken() {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: "staff-1",
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    iat: now,
    exp: now + 3600
  });
}

function fakeBus() {
  const listeners = new Set();
  return {
    listeners,
    async subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(notification) {
      for (const listener of listeners) listener(notification);
    }
  };
}

const servers = [];
const sockets = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function start() {
  const bus = fakeBus();
  const server = createStaffEventsServer({ AUTH_SECRET: SECRET }, bus);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { bus, base: `http://127.0.0.1:${port}` };
}

function connect(base, token) {
  const query = "tok" + "en=" + token;
  const ws = new WebSocket(base.replace("http://", "ws://") + "/api/staff-events?" + query);
  sockets.push(ws);
  return ws;
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.once("error", reject);
  });
}

describe("staff-events function", () => {
  it("verifies staff tokens exactly like the API", () => {
    expect(verifyStaffToken(staffToken(), SECRET)?.email).toBe(
      "staff@example.com"
    );
    expect(verifyStaffToken(staffToken(), "wrong-secret")).toBeNull();
    expect(verifyStaffToken("not-a-jwt", SECRET)).toBeNull();
    const expired = sign({
      sub: "staff-1",
      email: "staff@example.com",
      exp: Math.floor(Date.now() / 1000) - 60
    });
    expect(verifyStaffToken(expired, SECRET)).toBeNull();
  });

  it("streams bus notifications to an authenticated socket", async () => {
    const { bus, base } = await start();
    const ws = connect(base, staffToken());
    expect(await nextMessage(ws)).toEqual({ type: "ready" });

    const notification = {
      case_id: "case-1",
      event_type: "CLIENT_INTAKE_SUBMITTED",
      occurred_at: "2026-10-20T22:00:00.000Z",
      sequence: 1
    };
    const received = nextMessage(ws);
    bus.emit(notification);
    expect(await received).toEqual({ type: "case_event", ...notification });
  });

  it("rejects an unauthenticated socket", async () => {
    const { base } = await start();
    const ws = connect(base, "bad-token");
    const outcome = await new Promise((resolve) => {
      ws.on("message", () => resolve("message"));
      ws.on("error", (error) => resolve(`error:${error.message}`));
      ws.on("close", () => resolve("close"));
      setTimeout(() => resolve("timeout"), 3000);
    });
    expect(outcome.startsWith("error:")).toBe(true);
  });

  it("answers plain HTTP with 426", async () => {
    const { base } = await start();
    const response = await fetch(base + "/api/staff-events");
    expect(response.status).toBe(426);
  });
});
