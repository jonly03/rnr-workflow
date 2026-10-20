import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import type { CaseStore } from "./store.js";

/**
 * Staff realtime feed: pushes a lightweight notification over a
 * WebSocket every time any case event is appended (a client intake
 * submitting, a customer signing, a staff action — anything). The
 * message carries only {case_id, event_type, occurred_at, sequence};
 * dashboards refetch through the normal authenticated REST API, so no
 * case data ever travels over the socket itself.
 *
 * Transport notes:
 * - Auth is the staff session JWT, passed as a `?token=` query param
 *   (browsers cannot set headers on a WebSocket handshake) and verified
 *   with the same HMAC check as REST before the upgrade completes.
 * - The cross-instance bus is the store: Postgres LISTEN/NOTIFY for the
 *   PG store (any API instance's append reaches every socket holder),
 *   an in-process fan-out for the JSON store.
 * - On Vercel, a connection is pinned to one function instance and dies
 *   at the function's max duration (300s here); the client reconnects
 *   with backoff and refetches on every (re)connect, so a dropped
 *   socket costs a few seconds, never a missed case.
 */
export const STAFF_EVENTS_PATH = "/api/v1/staff/events";

const HEARTBEAT_MS = 25_000;

export async function serveStaffSocket(
  ws: WebSocket,
  store: CaseStore
): Promise<void> {
  // Subscribe BEFORE sending "ready": the client treats "ready" as the
  // live signal, and an event appended while the subscription was
  // still arming would otherwise never reach this socket.
  let unsubscribe: (() => void) | undefined;
  if (store.subscribeCaseEvents) {
    try {
      unsubscribe = await store.subscribeCaseEvents((notification) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "case_event", ...notification }));
        }
      });
    } catch (error) {
      console.error("staff events subscribe failed:", error);
    }
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ready" }));
  }

  // Heartbeat: protocol-level pings (browsers answer automatically).
  // A socket that misses a pong is dead — terminate so its cleanup runs.
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

  ws.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe?.();
  });
  ws.on("error", () => {
    clearInterval(heartbeat);
    unsubscribe?.();
  });
}

/**
 * Wrap the Express app in an http.Server that also answers WebSocket
 * upgrades on STAFF_EVENTS_PATH. Used by the long-lived server entry
 * (local dev / standalone runs); the Vercel deployment serves staff
 * sockets from the web project's api/staff-events.js function instead
 * (same protocol, same PG bus), because staff browsers live on the web
 * origin.
 */
export function createRealtimeServer(
  app: Express,
  store: CaseStore,
  authSecret: string
): Server {
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    let token: string | null = null;
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      pathname = url.pathname;
      token = url.searchParams.get("token")
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== STAFF_EVENTS_PATH) {
      socket.destroy();
      return;
    }
    const staff = token ? verifyToken(token, authSecret) : null;
    if (!staff) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void serveStaffSocket(ws, store);
    });
  });

  return server;
}
