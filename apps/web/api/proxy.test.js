import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import handler, { config } from "./proxy.js";

function mockReq({ method = "POST", headers = {}, bodyBytes = Buffer.alloc(0), query = {} }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.query = query;
  // Emit the body on next tick to simulate a stream.
  process.nextTick(() => {
    if (bodyBytes.length > 0) req.emit("data", bodyBytes);
    req.emit("end");
  });
  return req;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(p) { this.payload = p; return this; },
    json(o) { this.payload = o; return this; }
  };
  return res;
}

describe("staging API proxy", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env.UPSTREAM_API_URL = "https://api.example.test";
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  });

  it("disables Vercel body parsing so uploads stream raw", () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it("forwards multipart photo bytes untouched", async () => {
    const boundary = "----testboundary123";
    const fileBytes = Buffer.from("fake-jpeg-bytes");
    const rawBody = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="vin.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    );
    const multipart = Buffer.concat([rawBody, fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);

    let captured;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      captured = { url, init };
      return {
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () => Buffer.from(JSON.stringify({ vin: "TESTVIN12345678901" }))
      };
    }));

    const req = mockReq({
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      bodyBytes: multipart,
      query: { path: ["vin", "ocr"] }
    });
    const res = mockRes();
    await handler(req, res);

    expect(captured.url).toBe("https://api.example.test/api/v1/vin/ocr");
    // Exact bytes forwarded, boundary content-type preserved.
    expect(Buffer.isBuffer(captured.init.body)).toBe(true);
    expect(captured.init.body.equals(multipart)).toBe(true);
    expect(captured.init.headers["content-type"]).toBe(
      `multipart/form-data; boundary=${boundary}`
    );
    expect(res.statusCode).toBe(200);
  });

  it("forwards JSON bodies as raw bytes too", async () => {
    const jsonBytes = Buffer.from(JSON.stringify({ email: "a@b.c", password: "x" }));
    vi.stubGlobal("fetch", vi.fn(async (url, init) => ({
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => Buffer.from("{}")
    })));

    const req = mockReq({
      headers: { "content-type": "application/json" },
      bodyBytes: jsonBytes,
      query: { path: "auth/login" }
    });
    const res = mockRes();
    let captured;
    // re-capture via the stub
    await handler(req, res);
    captured = vi.mocked(fetch).mock.calls[0][1];

    expect(captured.body.equals(jsonBytes)).toBe(true);
    expect(captured.headers["content-type"]).toBe("application/json");
  });

  it("sends no body for GET", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.alloc(0)
    })));
    const req = mockReq({ method: "GET", query: { path: "health" } });
    const res = mockRes();
    await handler(req, res);
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init.body).toBeUndefined();
  });
});
