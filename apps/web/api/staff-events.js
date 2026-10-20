// Vercel Serverless Function: staff realtime WebSocket endpoint.
//
// Staff dashboards hold a socket open here and receive a lightweight
// {type: "case_event", case_id, event_type, occurred_at, sequence}
// message every time any case event lands — most importantly the
// moment a client submits the QR intake, so a new case appears in the
// queue with no manual refresh. Messages carry no case data; the
// dashboard refetches through the authenticated REST API as usual.
//
// Why this lives in the WEB project: staff browsers work on the web
// origin (the API deployment sits behind its own deployment-protection
// wall), so the socket is same-origin with the page. The bus is the
// shared Postgres: the API issues pg_notify('case_events', ...) after
// every committed event append, and this function LISTENs and fans
// out. Any API instance can publish; any web instance can serve
// sockets; neither needs to know about the other.
//
// Auth is the staff session JWT, verified exactly like the API does
// (HS256 HMAC — see verifyStaffToken, a mirror of
// apps/api/src/auth.ts verifyToken). Browsers cannot set headers on a
// WebSocket handshake, so the token rides as a ?token= query param.
//
// A connection dies when the function hits its max duration; the
// client reconnects with backoff and refetches on every (re)connect,
// so a dropped socket costs seconds, never a missed case.

import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import pg from "pg";

const HEARTBEAT_MS = 25_000;

function b64urlDecode(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Mirror of apps/api/src/auth.ts verifyToken — keep the checks in step:
// HMAC-SHA256 signature, exp in the future, sub + email present.
export function verifyStaffToken(token, secret) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest();
  const actual = b64urlDecode(signature);
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// Postgres LISTEN bus: one dedicated client, shared by every socket on
// this instance. Mirrors the API pool's SSL rule (apps/api/src/db.ts).
function createPgBus(env) {
  const listeners = new Set();
  let client = null;
  let connecting = null;

  async function ensureListening() {
    if (client || connecting) return connecting;
    connecting = (async () => {
      const connectionString = env.DATABASE_URL;
      const local = /localhost|127\.0\.0\.1/.test(connectionString);
      const ssl =
        local || env.DATABASE_SSL_MODE === "disable"
          ? false
          : { rejectUnauthorized: false };
      const next = new pg.Client({ connectionString, ssl });
      next.on("notification", (message) => {
        if (message.channel !== "case_events" || !message.payload) return;
        let notification;
        try {
          notification = JSON.parse(message.payload);
        } catch {
          return;
        }
        for (const listener of listeners) {
          try {
            listener(notification);
          } catch {
            // One bad listener must never break the fan-out.
          }
        }
      });
      next.on("error", (error) => {
        console.error("staff-events LISTEN client error:", error);
        if (client === next) client = null;
      });
      await next.connect();
      await next.query("listen case_events");
      client = next;
    })();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
    return undefined;
  }

  return {
    async subscribe(listener) {
      listeners.add(listener);
      try {
        await ensureListening();
      } catch (error) {
        console.error("staff-events LISTEN setup failed:", error);
      }
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function createStaffEventsServer(env = process.env, busOverride) {
  const secret = env["AUTH_SECRET"];
  const bus =
    busOverride ?? (env.DATABASE_URL ? createPgBus(env) : null);

  const server = http.createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    let token = null;
    try {
      token = new URL(
        request.url ?? "",
        "http://localhost"
      ).searchParams.get("token");
    } catch {
      socket.destroy();
      return;
    }
    const staff = token && secret ? verifyStaffToken(token, secret) : null;
    if (!staff) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void serveSocket(ws, bus);
    });
  });

  return server;
}

async function serveSocket(ws, bus) {
  ws.send(JSON.stringify({ type: "ready" }));

  let unsubscribe;
  if (bus) {
    try {
      unsubscribe = await bus.subscribe((notification) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "case_event", ...notification }));
        }
      });
    } catch (error) {
      console.error("staff-events subscribe failed:", error);
    }
  } else {
    console.error("staff-events: no DATABASE_URL — socket will idle");
  }

  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

export default createStaffEventsServer();
