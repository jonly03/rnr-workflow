import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ocrVinPhoto,
  setToken,
  staffEventsSocketUrl,
  subscribeStaffEvents,
  type StaffCaseEventMessage,
  type StaffEventsStatus
} from "./api";

describe("ocrVinPhoto", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    // jsdom has no createImageBitmap: exercises the original-file fallback.
    (globalThis as any).createImageBitmap = undefined;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("uploads the photo as multipart form data", async () => {
    const seen = new Map<string, unknown>();
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/vin\/ocr$/);
      expect(init.method).toBe("POST");
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const photo = form.get("photo");
      expect(photo).toBeInstanceOf(File);
      seen.set("name", (photo as File).name);
      return new Response(JSON.stringify({ vin: "1HGCM82633A004352" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const file = new File(["fake-image"], "vin.jpg", { type: "image/jpeg" });
    const result = await ocrVinPhoto(file);
    expect(result.vin).toBe("1HGCM82633A004352");
    expect(seen.get("name")).toBe("vin.jpg");
  });

  it("surfaces the API error message on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: "VIN_OCR_NOT_FOUND", message: "No VIN found in the photo." } }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const file = new File(["fake-image"], "vin.jpg", { type: "image/jpeg" });
    await expect(ocrVinPhoto(file)).rejects.toThrow("No VIN found in the photo.");
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("staff realtime subscription", () => {
  beforeEach(() => {
    localStorage.clear();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds the socket URL from the API origin with the staff token", () => {
    expect(staffEventsSocketUrl()).toBeNull();
    setToken("staff-jwt");
    expect(staffEventsSocketUrl()).toBe(
      "ws://localhost:3001/api/v1/staff/events?" + "token" + "=staff-jwt"
    );
  });

  it("goes live on open, syncs, and forwards case events", () => {
    setToken("staff-jwt");
    const events: StaffCaseEventMessage[] = [];
    const statuses: StaffEventsStatus[] = [];
    const unsubscribe = subscribeStaffEvents({
      onEvent: (m) => events.push(m),
      onStatus: (s) => statuses.push(s)
    });

    const socket = FakeWebSocket.instances[0];
    socket.open();
    expect(statuses).toEqual(["live"]);
    expect(events).toEqual([{ type: "sync" }]);

    socket.message({
      type: "case_event",
      case_id: "case-1",
      event_type: "CLIENT_INTAKE_SUBMITTED",
      occurred_at: "2026-10-20T22:00:00.000Z",
      sequence: 1
    });
    expect(events[1]).toMatchObject({
      type: "case_event",
      event_type: "CLIENT_INTAKE_SUBMITTED"
    });
    unsubscribe();
  });

  it("falls back to polling while disconnected and reconnects", () => {
    setToken("staff-jwt");
    const events: StaffCaseEventMessage[] = [];
    const statuses: StaffEventsStatus[] = [];
    const unsubscribe = subscribeStaffEvents({
      onEvent: (m) => events.push(m),
      onStatus: (s) => statuses.push(s)
    });

    const first = FakeWebSocket.instances[0];
    first.open();
    first.close();
    expect(statuses).toEqual(["live", "reconnecting"]);

    // Poll fallback ticks a sync every 10s while the socket is down.
    vi.advanceTimersByTime(10_000);
    expect(events.filter((e) => e.type === "sync").length).toBe(2);

    // The reconnect attempt (1s backoff) created a fresh socket.
    expect(FakeWebSocket.instances.length).toBe(2);
    FakeWebSocket.instances[1].open();
    expect(statuses[statuses.length - 1]).toBe("live");

    unsubscribe();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});
