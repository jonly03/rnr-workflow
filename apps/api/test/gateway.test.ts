import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { JsonCaseStore } from "../src/store.js";
import { createBrainRouter, mountBrainGateway } from "../src/gateway.js";
import { loadBrainPricing } from "../src/gateway-pricing.js";
import { clearAuditRing } from "../src/gateway-audit.js";

const TEST_AUTH_SECRET = "test-brain-gateway-secret";
const API_KEY = "test-key";
const STAFF_KEY = "staff-key";
const VIN_ACCORD = "1HGCM82633A004352";
const VIN_CLA35 = "WDD5J5BB2LN065797";
const PRICING = { labor_cents: 12500, target_profit_cents: 25000, tax_rate: 0.0625 };
const BRAIN_PRICING = loadBrainPricing();

interface Fixture {
  app: ReturnType<typeof createApp>;
  auditPath: string;
}

function nhtsaPayload(year: string, make: string, model: string, trim: string) {
  const valueOf = (variable: string, value: string) => ({ Variable: variable, Value: value });
  return {
    Results: [
      valueOf("Model Year", year),
      valueOf("Make", make),
      valueOf("Model", model),
      valueOf("Trim", trim),
      valueOf("Body Class", "Sedan")
    ]
  };
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-brain-gateway-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const glassCatalog = new MockGlassCatalogProvider();
  const sourcingProvider = new MockSourcingProvider();
  const app = createApp(
    store,
    { authSecret: TEST_AUTH_SECRET },
    {},
    { glassCatalog, sourcingProvider, pricingConfig: PRICING }
  );
  const auditPath = path.join(dir, "audit.jsonl");
  mountBrainGateway(app, {
    store,
    glassCatalog,
    sourcingProvider,
    pricingConfig: PRICING,
    quotingConfig: { expiry_hours: 72 },
    apiKeys: [API_KEY],
    staffApiKeys: [STAFF_KEY],
    auditLogPath: auditPath,
    rateLimitMax: 1000
  });
  return { app, auditPath };
}

const brain = (f: Fixture, body: Record<string, unknown>, key: string | null = API_KEY) => {
  const req = request(f.app).post("/api/v1/brain").send(body);
  return key === null ? req : req.set("X-API-Key", key);
};

const createCaseBody = (overrides: Record<string, unknown> = {}) => ({
  tool: "create_case",
  channel: "web",
  arguments: {
    customer_name: "Test Driver",
    customer_phone: "(857) 266-1284",
    glass_type: "WINDSHIELD",
    vin: VIN_ACCORD,
    service_address: { formatted: "118 Terrace St, Roxbury MA 02120" },
    ...overrides
  }
});

describe("Brain Gateway", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearAuditRing();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(VIN_ACCORD)) {
          return { ok: true, json: async () => nhtsaPayload("2003", "Honda", "Accord", "EX-V6") };
        }
        if (url.includes(VIN_CLA35)) {
          return { ok: true, json: async () => nhtsaPayload("2020", "Mercedes-Benz", "CLA-Class", "AMG CLA 35") };
        }
        return { ok: true, json: async () => ({ Results: [] }) };
      })
    );
  });

  afterEach(() => {
    vi.stubGlobal("fetch", realFetch);
    vi.unstubAllGlobals();
  });

  it("rejects calls without an API key", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "decode_vin", arguments: { vin: VIN_ACCORD } }, null);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a wrong API key", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "decode_vin", arguments: { vin: VIN_ACCORD } }, "nope");
    expect(res.status).toBe(401);
  });

  it("lists the MCP tool definitions with config-driven prices", async () => {
    const f = await fixture();
    const res = await request(f.app).get("/api/v1/brain/tools").set("X-API-Key", API_KEY);
    expect(res.status).toBe(200);
    const names = res.body.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "decode_vin",
      "get_vehicle",
      "create_case",
      "get_case_status",
      "lookup_part",
      "quote",
      "order_glass"
    ]);
    const tools = res.body.tools as { name: string; price_usd: number | null; approvalRequired: boolean }[];
    const byName = new Map(tools.map(t => [t.name, t]));
    expect(byName.get("decode_vin")?.price_usd).toBe(BRAIN_PRICING.decode);
    expect(byName.get("lookup_part")?.price_usd).toBe(BRAIN_PRICING.fullVehicle);
    expect(byName.get("order_glass")?.approvalRequired).toBe(true);
    for (const tool of res.body.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.access).toMatch(/^(read|write)$/);
    }
  });

  it("decodes a VIN and charges the configured decode price", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "decode_vin", arguments: { vin: VIN_ACCORD } });
    expect(res.status).toBe(200);
    expect(res.body.result.vehicle).toMatchObject({ year: 2003, make: "Honda", model: "Accord" });
    expect(res.body.price_usd_charged).toBe(BRAIN_PRICING.decode);
  });

  it("decodes the CLA35 test VIN to 2020 Mercedes-Benz CLA-Class", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "decode_vin", arguments: { vin: VIN_CLA35 } });
    expect(res.status).toBe(200);
    expect(res.body.result.vehicle).toMatchObject({ year: 2020, make: "Mercedes-Benz", model: "CLA-Class" });
  });

  it("rejects an invalid VIN with 400 and charges nothing", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "decode_vin", arguments: { vin: "NOTAVIN" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VIN");
    expect(res.body.price_usd_charged).toBeUndefined();
  });

  it("rejects an unknown tool", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "teleport_car", arguments: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_TOOL");
  });

  it("rejects an unknown channel", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "decode_vin", arguments: { vin: VIN_ACCORD }, channel: "smoke-signal" });
    expect(res.status).toBe(422);
  });

  it("creates a case (201) and strips smuggled state/pricing keys", async () => {
    const f = await fixture();
    const res = await brain(
      f,
      createCaseBody({ state: "CLOSED", price_usd: 0.01, channel: "INSURANCE" })
    );
    expect(res.status).toBe(201);
    expect(res.body.result.reference).toMatch(/^RRA-\d+$/);
    expect(res.body.result.status_token).toBeTruthy();
    expect(res.body.result.state).toBeUndefined();
    expect(res.body.result.price_usd).toBeUndefined();
    expect(res.body.price_usd_charged).toBe(0);
  });

  it("creates a case from YMM alone, no VIN", async () => {
    const f = await fixture();
    const res = await brain(f, createCaseBody({ vin: undefined, year: 2016, make: "Toyota", model: "Tacoma" }));
    expect(res.status).toBe(201);
    expect(res.body.result.reference).toMatch(/^RRA-\d+$/);
  });

  it("rejects a case without a service address", async () => {
    const f = await fixture();
    const body = createCaseBody();
    delete (body.arguments as Record<string, unknown>).service_address;
    const res = await brain(f, body);
    expect(res.status).toBe(422);
  });

  it("asks variant follow-ups on a windshield case instead of guessing", async () => {
    const f = await fixture();
    const res = await brain(f, createCaseBody({ vin: VIN_CLA35 }));
    expect(res.status).toBe(201);
    expect(res.body.result.variant_questions).toEqual(
      expect.arrayContaining([
        "Does the windshield have a rain sensor near the mirror?",
        "Is there a camera behind the windshield (lane assist / ADAS)?"
      ])
    );
    expect(res.body.result.glass_identified.candidates).toBe(1);
  });

  it("reports case status by reference and by status token", async () => {
    const f = await fixture();
    const created = await brain(f, createCaseBody());
    expect(created.status).toBe(201);
    const reference = created.body.result.reference as string;
    const byRef = await brain(f, { tool: "get_case_status", arguments: { reference } });
    expect(byRef.status).toBe(200);
    expect(byRef.body.result.reference).toBe(reference);
    expect(byRef.body.result.phase).toBe("quote_ready");
    expect(byRef.body.result.quote_ready).toBe(true);
    expect(byRef.body.result).not.toHaveProperty("current_state");
    const byToken = await brain(f, {
      tool: "get_case_status",
      arguments: { status_token: created.body.result.status_token }
    });
    expect(byToken.status).toBe(200);
    expect(byToken.body.result.reference).toBe(reference);
  });

  it("returns 400 for an unknown reference", async () => {
    const f = await fixture();
    const res = await brain(f, { tool: "get_case_status", arguments: { reference: "RRA-999999" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CASE_NOT_FOUND");
  });

  it("looks up whole-car parts and charges the full-vehicle price", async () => {
    const f = await fixture();
    const res = await brain(f, {
      tool: "lookup_part",
      arguments: { year: 2016, make: "Toyota", model: "Tacoma", category: "engine" }
    });
    expect(res.status).toBe(200);
    expect(res.body.result.catalog_match).toBe(true);
    const paths = res.body.result.parts.map((p: { path: string }) => p.path);
    expect(paths).toContain("oil");
    expect(res.body.result.variant_status).toBe("variant_ambiguous");
    expect(res.body.price_usd_charged).toBe(BRAIN_PRICING.fullVehicle);
  });

  it("filters parts and never guesses an uncatalogued vehicle", async () => {
    const f = await fixture();
    const filtered = await brain(f, {
      tool: "lookup_part",
      arguments: { year: 2016, make: "Toyota", model: "Tacoma", category: "engine", part: "oil" }
    });
    expect(filtered.body.result.parts.map((p: { path: string }) => p.path)).toEqual([
      "oil",
      "oil_filter"
    ]);
    const missing = await brain(f, {
      tool: "lookup_part",
      arguments: { year: 1999, make: "Unknown", model: "Unknown", category: "engine" }
    });
    expect(missing.status).toBe(200);
    expect(missing.body.result.catalog_match).toBe(false);
    expect(missing.body.result.variant_status).toBe("not_in_catalog");
    expect(missing.body.price_usd_charged).toBe(0);
  });

  it("estimates a quote from the catalog and flags ambiguous glass", async () => {
    const f = await fixture();
    const res = await brain(f, {
      tool: "quote",
      arguments: { year: 2016, make: "Toyota", model: "Tacoma", glass_type: "WINDSHIELD" }
    });
    expect(res.status).toBe(200);
    expect(res.body.result.estimate).toBe(true);
    expect(res.body.result.sell_price_cents).toBe(
      res.body.result.glass_cost_cents +
        res.body.result.labor_cents +
        res.body.result.profit_cents +
        res.body.result.tax_cents
    );
    const ambiguous = await brain(f, {
      tool: "quote",
      arguments: { year: 2020, make: "Honda", model: "Ambiguous", glass_type: "WINDSHIELD" }
    });
    expect(ambiguous.body.result.estimate).toBeNull();
    expect(ambiguous.body.result.variant_status).toBe("variant_ambiguous");
    expect(ambiguous.body.result.candidates).toHaveLength(3);
  });

  it("returns the case quote by reference once created", async () => {
    const f = await fixture();
    const created = await brain(f, createCaseBody());
    const reference = created.body.result.reference as string;
    const res = await brain(f, { tool: "quote", arguments: { reference } });
    expect(res.status).toBe(200);
    expect(res.body.result.quote_ready).toBe(true);
    expect(typeof res.body.result.quote.sell_price_cents).toBe("number");
  });

  it("refuses order_glass to non-staff keys and to non-invoiced cases", async () => {
    const f = await fixture();
    const created = await brain(f, createCaseBody());
    const reference = created.body.result.reference as string;
    const nonStaff = await brain(f, { tool: "order_glass", arguments: { reference } });
    expect(nonStaff.status).toBe(403);
    expect(nonStaff.body.error.code).toBe("STAFF_ONLY");
    const staff = await brain(f, { tool: "order_glass", arguments: { reference } }, STAFF_KEY);
    expect(staff.status).toBe(409);
    expect(staff.body.error.code).toBe("INVALID_STATE");
  });

  it("serves gateway health with pricing, catalog and audit counts", async () => {
    const f = await fixture();
    await brain(f, { tool: "decode_vin", arguments: { vin: VIN_ACCORD } });
    const res = await request(f.app).get("/api/v1/brain/health").set("X-API-Key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.gateway).toBe("brain-door");
    expect(res.body.pricing).toEqual(BRAIN_PRICING);
    expect(res.body.catalog.vehicles).toBe(4);
    expect(res.body.catalog.parts).toBeGreaterThan(30);
    expect(res.body.audit.total).toBeGreaterThan(0);
  });

  it("audit-logs every call without PII", async () => {
    const f = await fixture();
    await brain(f, { tool: "decode_vin", arguments: { vin: VIN_ACCORD } });
    await brain(f, createCaseBody());
    await brain(f, { tool: "decode_vin", arguments: { vin: "BAD" } });
    const lines = fs.readFileSync(f.auditPath, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.length).toBe(3);
    for (const entry of lines) {
      expect(entry.tool).toBeTruthy();
      expect(entry.channel).toBeTruthy();
      expect(typeof entry.ok).toBe("boolean");
      expect(typeof entry.price_usd_charged).toBe("number");
      expect(entry).not.toHaveProperty("customer_name");
      expect(entry).not.toHaveProperty("customer_phone");
      expect(entry).not.toHaveProperty("arguments");
    }
    expect(lines.filter(e => e.tool === "decode_vin" && e.ok).length).toBe(1);
    expect(lines.filter(e => e.tool === "create_case" && e.ok).length).toBe(1);
    expect(lines.filter(e => !e.ok).length).toBe(1);
  });

  it("createBrainRouter is mountable on a bare app", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-brain-router-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    const express = (await import("express")).default;
    const bare = express();
    bare.use(express.json());
    bare.use(
      "/api/v1/brain",
      createBrainRouter({ store, apiKeys: [API_KEY], auditLogPath: path.join(dir, "a.jsonl") })
    );
    const res = await request(bare)
      .post("/api/v1/brain")
      .set("X-API-Key", API_KEY)
      .send({ tool: "decode_vin", arguments: { vin: VIN_ACCORD } });
    expect(res.status).toBe(200);
    expect(res.body.result.vehicle.make).toBe("Honda");
  });
});
