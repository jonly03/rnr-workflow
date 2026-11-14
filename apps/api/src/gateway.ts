import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { normalizeUsPhone } from "./app.js";
import { decodeVinNhtsa, VinDecodeError } from "./vin-decode.js";
import { isValidVin } from "./vin-validation.js";
import { createGlassCatalogProvider, createSourcingProvider } from "./mygrant.js";
import type { GlassCatalogProvider } from "./glass-catalog.js";
import { runIdentification } from "./glass-identification.js";
import { loadPricingConfig, runPricing, type PricingConfig } from "./pricing.js";
import { generateQuote, loadQuotingConfig, type QuotingConfig } from "./quoting.js";
import { runSourcing, type SourcingProvider } from "./sourcing.js";
import { advanceLifecycle } from "./lifecycle.js";
import { mintApprovalToken, verifyApprovalToken } from "./approval-tokens.js";
import type { CaseStore } from "./store.js";
import type { CaseRecord } from "./types.js";
import { createRateLimiter } from "./rate-limit.js";
import { loadBrainPricing, type BrainPriceKey, type BrainPricing } from "./gateway-pricing.js";
import {
  appendAudit,
  auditStats,
  keyFingerprint,
  type BrainChannel
} from "./gateway-audit.js";
import {
  findCatalogVehicle,
  loadVehicleCatalog,
  partsInCategory,
  worstVariantStatus,
  PART_CATEGORIES,
  type PartCategory,
  type VehicleCatalog
} from "./gateway-catalog.js";

/**
 * Brain Gateway ("the Door") — ONE endpoint in front of Muse.
 *
 * Web, WhatsApp, Siri and phone all call POST /api/v1/brain with an
 * X-API-Key. The gateway dispatches to MCP-style tools that wrap the
 * existing Case Core engine (apps/api): the NHTSA VIN decode, the
 * public intake, the whole-car parts catalog, quoting, and the
 * staff-only glass order. Nothing here re-implements case logic — the
 * tools call the same library functions the staff API and the public
 * intake use (runIdentification, runSourcing, runPricing,
 * generateQuote, advanceLifecycle).
 *
 * Hard rules (from the map):
 * - Never guess a variant: ambiguous glass/parts return
 *   variant_ambiguous + follow-up questions, never a picked part.
 * - Never charge on a failed lookup: price_usd_charged is $0 unless
 *   the tool succeeded, and every price comes from the pricing config.
 * - Never smuggle pricing/state via unknown keys: zod strips unknown
 *   argument keys; channel/state/pricing are pinned server-side.
 * - order_glass is staff-only and never triggers a paid VIN lookup.
 */

export const BRAIN_VERSION = "0.1.0";
const GATEWAY_RATE_LIMIT_MAX = 20;
const GATEWAY_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function badRequest(code: string, message: string): GatewayError {
  return new GatewayError(code, message, 400);
}

function unprocessable(code: string, message: string): GatewayError {
  return new GatewayError(code, message, 422);
}

function conflict(code: string, message: string): GatewayError {
  return new GatewayError(code, message, 409);
}

// ---------------------------------------------------------------------
// Tool definitions (MCP tools/list shape). Prices are resolved from
// the pricing config at mount time — no price literal lives in code.
// ---------------------------------------------------------------------

export interface BrainToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: "read" | "write";
  approvalRequired: boolean;
  /** Config key funding this tool, or null when the tool is free. */
  priceKey: BrainPriceKey | null;
  price_usd: number | null;
}

const GLASS_TYPES = ["WINDSHIELD", "BACK_GLASS", "DOOR_GLASS", "QUARTER_GLASS", "VENT_GLASS"] as const;

const serviceAddressSchema = z.object({
  place_id: z.string().trim().min(1).max(160).optional(),
  formatted: z.string().trim().min(1).max(400),
  street: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(2).max(80).optional(),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional()
});

export function brainToolDefs(pricing: BrainPricing): BrainToolDef[] {
  const price = (key: BrainPriceKey | null): number | null =>
    key === null ? null : pricing[key];
  return [
    {
      name: "decode_vin",
      description:
        "Decode a 17-character VIN to year/make/model/trim via the free NHTSA vPIC API. " +
        "Invalid VINs return 400 and are never charged.",
      inputSchema: {
        type: "object",
        properties: { vin: { type: "string", description: "17-character VIN" } },
        required: ["vin"],
        additionalProperties: false
      },
      access: "read",
      approvalRequired: false,
      priceKey: "decode",
      price_usd: price("decode")
    },
    {
      name: "get_vehicle",
      description:
        "Resolve a vehicle identity: decode a VIN, or accept year/make/model as given. " +
        "Returns the vehicle only — never a part number or a variant guess.",
      inputSchema: {
        type: "object",
        properties: {
          vin: { type: "string", description: "17-character VIN (preferred)" },
          year: { type: "integer", description: "Model year, when no VIN is given" },
          make: { type: "string" },
          model: { type: "string" }
        },
        additionalProperties: false
      },
      access: "read",
      approvalRequired: false,
      priceKey: null,
      price_usd: null
    },
    {
      name: "create_case",
      description:
        "Create an R&R case from a customer request — the same public intake the web form " +
        "uses (channel DIRECT, state REQUEST_RECEIVED, reference RRA-style, 201 with a " +
        "status token). The case is driven to its quote automatically; where a human is " +
        "needed it waits for staff. For windshields/back glass the result also carries " +
        "variant_questions the channel should ask the customer (rain sensor, ADAS camera, " +
        "HUD, acoustic, heated) — a VIN never settles the variant, so the gateway asks " +
        "instead of guessing. No photo bytes over this JSON door — use the web " +
        "intake for damage/VIN photos.",
      inputSchema: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          customer_phone: { type: "string", description: "10-digit US mobile, for the quote text" },
          glass_type: { type: "string", enum: [...GLASS_TYPES] },
          note: { type: "string", description: "What happened, optional" },
          vin: { type: "string", description: "17-character VIN, when known" },
          year: { type: "integer" },
          make: { type: "string" },
          model: { type: "string" },
          service_address: {
            type: "object",
            properties: {
              formatted: { type: "string", description: "Where the car will be serviced" },
              street: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              zip: { type: "string" },
              lat: { type: "number" },
              lon: { type: "number" },
              place_id: { type: "string" }
            },
            required: ["formatted"],
            additionalProperties: false
          }
        },
        required: ["customer_name", "customer_phone", "glass_type", "service_address"],
        additionalProperties: false
      },
      access: "write",
      approvalRequired: false,
      priceKey: null,
      price_usd: null
    },
    {
      name: "get_case_status",
      description:
        "Client-safe progress for a case: plain-language phase and steps only. " +
        "Never internal state names, never economics. Look up by reference or by " +
        "the intake-status token from create_case.",
      inputSchema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Case reference, e.g. RRA-000001" },
          status_token: { type: "string", description: "Intake-status token from create_case" }
        },
        additionalProperties: false
      },
      access: "read",
      approvalRequired: false,
      priceKey: null,
      price_usd: null
    },
    {
      name: "lookup_part",
      description:
        "Whole-car part lookup for a vehicle (categories: exterior, interior, engine, " +
        "mechanical) from R&R's verified catalog. Every part carries variant_status; " +
        "ambiguous parts return follow-up questions, never a guessed variant. " +
        "Vehicles outside the catalog return not_in_catalog and are never charged.",
      inputSchema: {
        type: "object",
        properties: {
          vin: { type: "string", description: "17-character VIN (preferred)" },
          year: { type: "integer" },
          make: { type: "string" },
          model: { type: "string" },
          category: { type: "string", enum: [...PART_CATEGORIES] },
          part: { type: "string", description: "Optional substring filter, e.g. windshield or oil" }
        },
        required: ["category"],
        additionalProperties: false
      },
      access: "read",
      approvalRequired: false,
      priceKey: "fullVehicle",
      price_usd: price("fullVehicle")
    },
    {
      name: "quote",
      description:
        "Quote for a case or an estimate for a vehicle+glass. By reference: the case's " +
        "latest quote (or quote_ready false when none exists yet). By vehicle: a priced " +
        "estimate from the catalog list price plus configured labor/profit/tax; " +
        "ambiguous glass returns the candidates with no price.",
      inputSchema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Case reference" },
          year: { type: "integer" },
          make: { type: "string" },
          model: { type: "string" },
          glass_type: { type: "string", enum: [...GLASS_TYPES] },
          part_number: { type: "string", description: "Pin one candidate, when known" }
        },
        additionalProperties: false
      },
      access: "read",
      approvalRequired: false,
      priceKey: null,
      price_usd: null
    },
    {
      name: "order_glass",
      description:
        "STAFF ONLY. Order the identified glass for an invoiced case (INVOICED -> " +
        "PARTS_ORDERED). Uses only the already-identified candidate — it never runs a " +
        "paid VIN lookup and never spends the $1 MyGrant credit.",
      inputSchema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Case reference" },
          part_number: { type: "string", description: "Must match the identified candidate or an interchange" }
        },
        required: ["reference"],
        additionalProperties: false
      },
      access: "write",
      approvalRequired: true,
      priceKey: null,
      price_usd: null
    }
  ];
}

// ---------------------------------------------------------------------
// Argument schemas (zod strips unknown keys — a client cannot smuggle
// channel, state, or pricing fields into a tool call).
// ---------------------------------------------------------------------

const channelSchema = z.enum(["web", "whatsapp", "siri", "phone", "direct"]);

const dispatchSchema = z.object({
  tool: z.string().trim().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
  channel: channelSchema.optional().default("direct")
});

const decodeVinArgs = z.object({ vin: z.string().trim().min(1).max(17) });

const getVehicleArgs = z.union([
  z.object({ vin: z.string().trim().min(1).max(17) }),
  z.object({
    year: z.number().int().min(1950).max(new Date().getFullYear() + 1),
    make: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(60)
  })
]);

const createCaseArgs = z.object({
  customer_name: z.string().trim().min(2).max(120),
  customer_phone: z.string().trim().min(7).max(32),
  glass_type: z.enum(GLASS_TYPES),
  note: z.string().trim().max(1000).optional(),
  vin: z.string().trim().max(17).optional(),
  year: z.number().int().min(1950).max(new Date().getFullYear() + 1).optional(),
  make: z.string().trim().min(1).max(60).optional(),
  model: z.string().trim().min(1).max(60).optional(),
  service_address: serviceAddressSchema
});

const getCaseStatusArgs = z.union([
  z.object({ reference: z.string().trim().min(1).max(32) }),
  z.object({ status_token: z.string().trim().min(1) })
]);

const lookupPartArgs = z
  .object({
    vin: z.string().trim().min(1).max(17).optional(),
    year: z.number().int().min(1950).max(new Date().getFullYear() + 1).optional(),
    make: z.string().trim().min(1).max(60).optional(),
    model: z.string().trim().min(1).max(60).optional(),
    category: z.enum(PART_CATEGORIES),
    part: z.string().trim().min(1).max(80).optional()
  })
  .refine(
    data => Boolean(data.vin) || (data.year !== undefined && data.make && data.model),
    { message: "Provide a VIN, or year/make/model." }
  );

const quoteArgs = z.union([
  z.object({ reference: z.string().trim().min(1).max(32) }),
  z.object({
    year: z.number().int().min(1950).max(new Date().getFullYear() + 1),
    make: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(60),
    glass_type: z.enum(GLASS_TYPES),
    part_number: z.string().trim().min(1).max(60).optional()
  })
]);

const orderGlassArgs = z.object({
  reference: z.string().trim().min(1).max(32),
  part_number: z.string().trim().min(1).max(60).optional()
});

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

interface ToolOutcome {
  result: Record<string, unknown>;
  priceCharged: number;
  reference: string | null;
}

async function findCaseByReference(store: CaseStore, reference: string): Promise<CaseRecord> {
  const cases = await store.listCases();
  const found = cases.find(c => c.reference === reference);
  if (!found) throw badRequest("CASE_NOT_FOUND", `No case with reference ${reference}.`);
  return found;
}

/** NHTSA decode with the gateway's failure contract: bad VIN = 400, upstream down = 502. */
async function decodeVinOrThrow(vin: string): Promise<{
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  bodyClass: string;
}> {
  if (!isValidVin(vin)) {
    throw badRequest(
      "INVALID_VIN",
      "That VIN doesn't look right — check the 17 characters and try again."
    );
  }
  try {
    return await decodeVinNhtsa(vin);
  } catch (error) {
    if (error instanceof VinDecodeError && error.message.startsWith("NHTSA VIN decode failed")) {
      throw new GatewayError("UPSTREAM_ERROR", "The VIN decoder is unavailable right now — please try again in a moment.", 502);
    }
    throw badRequest(
      "INVALID_VIN",
      "That VIN could not be decoded to a vehicle — check it and try again, or enter year/make/model instead."
    );
  }
}

/**
 * Client-safe phase projection for a case. Mirrors the public intake
 * status view in app.ts (publicIntakeView): plain-language phases and
 * steps only — never the internal state name, never economics.
 */
const POST_GLASS_STATES = new Set([
  "GLASS_IDENTIFIED", "GLASS_SELECTED", "PRICE_APPROVED", "PROFIT_REVIEW_REQUIRED",
  "QUOTE_SENT", "QUOTE_DECLINED", "QUOTE_EXPIRED", "QUOTE_APPROVED", "INVOICED",
  "PARTS_ORDERED", "INSTALLATION_SCHEDULED", "TECH_DISPATCHED",
  "INSTALLATION_IN_PROGRESS", "SERVICE_COMPLETED", "CLOSED"
]);

async function caseStatusView(store: CaseStore, c: CaseRecord): Promise<Record<string, unknown>> {
  const [vehicle, glassRequest, quote] = await Promise.all([
    store.getVehicle(c.vehicle_id),
    store.getGlassRequest(c.glass_request_id),
    store.getLatestQuote(c.id)
  ]);
  const latestPrice = glassRequest
    ? await store.getLatestPriceCalculation(glassRequest.id)
    : null;
  const priced = latestPrice?.status === "APPROVED";
  const glassDone = POST_GLASS_STATES.has(c.current_state);
  const quoteExpired =
    quote?.status === "EXPIRED" ||
    (quote?.status === "SENT" && Date.parse(quote.expires_at) <= Date.now());

  let phase: string;
  if (quote?.signature) phase = "approved";
  else if (c.current_state === "QUOTE_DECLINED" || quote?.status === "DECLINED") phase = "declined";
  else if (c.current_state === "QUOTE_EXPIRED" || quoteExpired) phase = "expired";
  else if (c.current_state === "SYSTEM_ATTENTION_REQUIRED" || c.current_state === "GLASS_NOT_IDENTIFIED") phase = "needs_attention";
  else if (c.current_state === "QUOTE_SENT" && quote?.status === "SENT") phase = "quote_ready";
  else if (glassDone) phase = "pricing";
  else phase = "identifying";

  const headlines: Record<string, string> = {
    identifying: "We're identifying the exact glass for your vehicle.",
    pricing: "Your glass is identified — we're checking parts and pricing your job.",
    quote_ready: "Your quote is ready. Review it and sign to book your job in.",
    approved: "Thanks — your quote is approved and your job is booked in. We'll text you to schedule your service.",
    declined: "You declined this quote. If that was a mistake, call us and we'll sort it out.",
    expired: "Your quote expired before it was signed. Call us and we'll re-issue it right away.",
    needs_attention: "We need a hand confirming a detail on your vehicle — we'll text you shortly."
  };

  return {
    reference: c.reference,
    vehicle: vehicle ? { year: vehicle.year, make: vehicle.make, model: vehicle.model } : null,
    glass_type: glassRequest?.glass_type ?? null,
    phase,
    headline: headlines[phase],
    steps: [
      { key: "received", label: "Request received", done: true },
      { key: "glass", label: "Identifying your glass", done: glassDone },
      { key: "pricing", label: "Pricing your job", done: priced },
      { key: "quote", label: "Quote ready to sign", done: quote !== null }
    ],
    quote_ready: phase === "quote_ready"
  };
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

export interface BrainGatewayDeps {
  store: CaseStore;
  glassCatalog?: GlassCatalogProvider;
  sourcingProvider?: SourcingProvider;
  /** Job pricing (labor/profit/tax) for quote estimates. Defaults to env. */
  pricingConfig?: PricingConfig;
  quotingConfig?: QuotingConfig;
  /** API keys for the door. Defaults to BRAIN_API_KEYS / BRAIN_API_KEY env. */
  apiKeys?: string[];
  /** Staff keys (order_glass). Defaults to BRAIN_STAFF_API_KEYS env. */
  staffApiKeys?: string[];
  brainPricing?: BrainPricing;
  catalog?: VehicleCatalog;
  auditLogPath?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

function parseKeyList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function keyMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createBrainRouter(deps: BrainGatewayDeps): express.Router {
  const store = deps.store;
  const glassCatalog = deps.glassCatalog ?? createGlassCatalogProvider();
  const sourcingProvider = deps.sourcingProvider ?? createSourcingProvider();
  const pricingConfig = deps.pricingConfig ?? loadPricingConfig();
  const quotingConfig = deps.quotingConfig ?? loadQuotingConfig();
  const brainPricing = deps.brainPricing ?? loadBrainPricing();
  const catalog = deps.catalog ?? loadVehicleCatalog();
  const auditLogPath = deps.auditLogPath;

  let apiKeys = deps.apiKeys ?? [
    ...parseKeyList(process.env.BRAIN_API_KEYS),
    ...parseKeyList(process.env.BRAIN_API_KEY)
  ];
  if (apiKeys.length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BRAIN_API_KEYS must be set in production.");
    }
    apiKeys = ["dev-brain-key"];
    console.warn(
      "WARNING: BRAIN_API_KEYS is not set; the Brain Gateway accepts the development key " +
        "'dev-brain-key'. Set BRAIN_API_KEYS before deploying anywhere shared."
    );
  }
  const staffApiKeys = deps.staffApiKeys ?? parseKeyList(process.env.BRAIN_STAFF_API_KEYS);

  const tools = brainToolDefs(brainPricing);
  const toolNames = new Set(tools.map(t => t.name));

  const router = express.Router();

  const limiter = createRateLimiter({
    windowMs: deps.rateLimitWindowMs ?? Number(process.env.BRAIN_RATE_LIMIT_WINDOW_MS ?? GATEWAY_RATE_LIMIT_WINDOW_MS),
    max: deps.rateLimitMax ?? Number(process.env.BRAIN_RATE_LIMIT_MAX ?? GATEWAY_RATE_LIMIT_MAX),
    key: req => {
      const presented = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
      return `${req.ip ?? "unknown"}:${keyFingerprint(presented) ?? "anon"}`;
    }
  });

  const requireApiKey = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    const presented = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
    // A staff key is an API key with extra privilege: it opens the door
    // like any key, and additionally unlocks staff-only tools.
    const ok =
      presented.length > 0 &&
      (apiKeys.some(k => keyMatches(presented, k)) || staffApiKeys.some(k => keyMatches(presented, k)));
    if (!ok) {
      appendAudit(
        {
          channel: "direct",
          tool: "auth",
          key_fingerprint: keyFingerprint(presented || null),
          ok: false,
          error_code: "UNAUTHORIZED",
          price_usd_charged: 0,
          duration_ms: 0,
          reference: null
        },
        auditLogPath
      );
      res.status(401).json({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "A valid X-API-Key header is required." }
      });
      return;
    }
    (req as express.Request & { brainKey?: string }).brainKey = presented;
    next();
  };

  router.get("/tools", limiter, requireApiKey, (_req, res) => {
    res.json({ tools });
  });

  router.get("/health", limiter, requireApiKey, (_req, res) => {
    let parts = 0;
    for (const vehicle of catalog.vehicles) {
      for (const category of PART_CATEGORIES) {
        parts += partsInCategory(vehicle, category).length;
      }
    }
    res.json({
      ok: true,
      gateway: "brain-door",
      version: BRAIN_VERSION,
      tools: tools.map(t => t.name),
      pricing_source: "config/brain-pricing.json",
      pricing: brainPricing,
      catalog: { version: catalog.version, vehicles: catalog.vehicles.length, parts },
      audit: auditStats()
    });
  });

  // -- tool handlers ---------------------------------------------------

  const handlers: Record<
    string,
    (args: Record<string, unknown>, channel: BrainChannel) => Promise<ToolOutcome>
  > = {
    async decode_vin(args) {
      const parsed = decodeVinArgs.safeParse(args);
      if (!parsed.success) throw unprocessable("VALIDATION_ERROR", "vin (17 characters) is required.");
      const vehicle = await decodeVinOrThrow(parsed.data.vin);
      return {
        result: { vehicle, charged: true, price_usd: brainPricing.decode },
        priceCharged: brainPricing.decode,
        reference: null
      };
    },

    async get_vehicle(args) {
      const parsed = getVehicleArgs.safeParse(args);
      if (!parsed.success) {
        throw unprocessable(
          "VALIDATION_ERROR",
          "Provide a VIN, or year/make/model."
        );
      }
      if ("vin" in parsed.data) {
        const vehicle = await decodeVinOrThrow(parsed.data.vin);
        return {
          result: { vehicle, source: "vin", charged: true, price_usd: brainPricing.decode },
          priceCharged: brainPricing.decode,
          reference: null
        };
      }
      const { year, make, model } = parsed.data;
      return {
        result: {
          vehicle: { vin: "", year, make, model, trim: "", bodyClass: "" },
          source: "ymm",
          charged: false,
          price_usd: 0
        },
        priceCharged: 0,
        reference: null
      };
    },

    async create_case(args, channel) {
      const parsed = createCaseArgs.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw unprocessable(
          "VALIDATION_ERROR",
          first?.message ?? "Invalid case request.",
        );
      }
      const input = parsed.data;
      if (!normalizeUsPhone(input.customer_phone)) {
        throw unprocessable(
          "VALIDATION_ERROR",
          "Enter a valid 10-digit US mobile number so we can text your quote."
        );
      }
      let vin: string | null = null;
      if (input.vin) {
        if (!isValidVin(input.vin)) {
          throw unprocessable(
            "VALIDATION_ERROR",
            "That VIN doesn't look right — check the 17 characters and try again, or enter your vehicle's year, make and model instead."
          );
        }
        vin = input.vin.trim().toUpperCase();
      }
      let { year, make, model } = input;
      if (vin && (year === undefined || !make || !model)) {
        try {
          const decoded = await decodeVinNhtsa(vin);
          year = year ?? decoded.year;
          make = make ?? decoded.make;
          model = model ?? decoded.model;
        } catch {
          throw unprocessable(
            "VALIDATION_ERROR",
            "We couldn't read that VIN. Please add your vehicle's year, make and model."
          );
        }
      }
      if (year === undefined || !make || !model) {
        throw unprocessable(
          "VALIDATION_ERROR",
          "Tell us your vehicle: enter your VIN, or your vehicle's year, make and model."
        );
      }

      const customerActor = { type: "CUSTOMER", id: null };
      const result = await store.createCase({
        channel: "DIRECT",
        customer_id: null,
        vehicle: { year, make, model, vin: vin ?? "" },
        glass_type: input.glass_type,
        actor: customerActor
      });
      const created = result.caseRecord;
      await store.appendEvent({
        caseId: created.id,
        eventType: "CLIENT_INTAKE_SUBMITTED",
        actor: customerActor,
        payload: {
          source: "BRAIN_GATEWAY",
          channel,
          customer_name: input.customer_name,
          customer_phone: input.customer_phone,
          note: input.note ?? null,
          service_address: input.service_address,
          vin_provided: vin !== null,
          vin_ocr_suggestion: null,
          photos: []
        }
      });
      const statusGrant = await mintApprovalToken(store, {
        caseId: created.id,
        channel: "DIRECT",
        purpose: "intake-status",
        ttlSeconds: 7 * 24 * 3600
      });

      // Drive the case to its quote now — the same awaited chain the
      // public intake runs (identification → sourcing → pricing →
      // auto-quote). A failure never loses the request: the case stays
      // queued in SYSTEM_ATTENTION_REQUIRED for staff.
      try {
        await runIdentification(store, glassCatalog, created.id, "START_IDENTIFICATION", customerActor);
        const afterIdentification = await store.getCase(created.id);
        if (afterIdentification?.current_state === "GLASS_IDENTIFIED") {
          await runSourcing(store, sourcingProvider, created.id);
          const afterSourcing = await store.getCase(created.id);
          if (afterSourcing?.current_state === "GLASS_SELECTED") {
            await runPricing(store, pricingConfig, created.id);
          }
        } else if (afterIdentification?.current_state === "GLASS_SELECTED") {
          await runPricing(store, pricingConfig, created.id);
        }
        const priced = await store.getCase(created.id);
        if (priced && (priced.current_state === "PRICE_APPROVED" || priced.current_state === "QUOTE_SENT")) {
          const glassRequest = await store.getGlassRequest(priced.glass_request_id);
          const latestPrice = glassRequest
            ? await store.getLatestPriceCalculation(glassRequest.id)
            : null;
          const latestQuote = await store.getLatestQuote(priced.id);
          if (latestPrice?.status === "APPROVED" && !latestQuote?.signature) {
            if (!latestQuote || latestQuote.snapshot.price_calculation_id !== latestPrice.id) {
              await generateQuote(store, quotingConfig, priced.id, { type: "SYSTEM", id: null }, {
                auto: true,
                trigger: latestQuote ? "reprice" : "price_approved"
              });
            }
          }
        }
      } catch (err) {
        console.error(`brain gateway auto-start failed for case ${created.id}:`, err);
        try {
          await store.appendEvent({
            caseId: created.id,
            eventType: "IDENTIFICATION_ERROR",
            actor: { type: "SYSTEM", id: null },
            nextState: "SYSTEM_ATTENTION_REQUIRED",
            payload: { error: err instanceof Error ? err.message : "Unknown error" }
          });
        } catch (eventErr) {
          console.error(`Failed to record IDENTIFICATION_ERROR for case ${created.id}:`, eventErr);
        }
      }

      // Variant confirmation: a VIN never settles the windshield option
      // set (rain sensor / ADAS camera / HUD / acoustic / heated), so the
      // channel must ask the customer — the gateway returns the questions,
      // never a guessed variant. A question drops out only when the
      // identified candidate's features already settle it.
      let variantQuestions: string[] = [];
      let glassIdentified: { part_number: string | null; candidates: number } | null = null;
      try {
        const gr = await store.getGlassRequest(created.glass_request_id);
        const ident = gr ? await store.getLatestGlassIdentification(gr.id) : null;
        if (ident) {
          glassIdentified = {
            part_number: ident.selected_candidate?.part_number ?? null,
            candidates: ident.candidates.length
          };
        }
        if (input.glass_type === "WINDSHIELD" || input.glass_type === "BACK_GLASS") {
          const features = new Set(
            (ident?.selected_candidate?.features ?? []).map(f => f.toLowerCase())
          );
          const all: { q: string; settledBy: string | null }[] = [
            { q: "Does the windshield have a rain sensor near the mirror?", settledBy: "rain-sensor" },
            { q: "Is there a camera behind the windshield (lane assist / ADAS)?", settledBy: null },
            { q: "Heads-up display?", settledBy: "heads-up-display" },
            { q: "Acoustic glass?", settledBy: "acoustic" },
            { q: "Heated wiper area?", settledBy: "heated" }
          ];
          variantQuestions = all
            .filter(item => !item.settledBy || !features.has(item.settledBy))
            .map(item => item.q);
        }
      } catch {
        // Questions are advisory: a failure here never loses the case.
      }

      return {
        result: {
          reference: created.reference,
          status_token: statusGrant.token,
          message:
            "Thanks — your request is in. We'll review it and text a quote link to the mobile number you gave us.",
          glass_identified: glassIdentified,
          variant_questions: variantQuestions
        },
        priceCharged: 0,
        reference: created.reference
      };
    },

    async get_case_status(args) {
      const parsed = getCaseStatusArgs.safeParse(args);
      if (!parsed.success) {
        throw unprocessable("VALIDATION_ERROR", "Provide a reference or a status_token.");
      }
      let c: CaseRecord;
      if ("status_token" in parsed.data) {
        const grant = await verifyApprovalToken(store, parsed.data.status_token, "intake-status");
        if (!grant) throw badRequest("INVALID_TOKEN", "That status link is invalid or expired.");
        const found = await store.getCase(grant.caseId);
        if (!found || found.channel !== grant.channel) {
          throw badRequest("INVALID_TOKEN", "That status link is invalid or expired.");
        }
        c = found;
      } else {
        c = await findCaseByReference(store, parsed.data.reference);
      }
      return { result: await caseStatusView(store, c), priceCharged: 0, reference: c.reference };
    },

    async lookup_part(args) {
      const parsed = lookupPartArgs.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw unprocessable("VALIDATION_ERROR", first?.message ?? "Invalid part lookup.");
      }
      const input = parsed.data;
      let vehicle: { year: number; make: string; model: string; trim?: string };
      if (input.vin) {
        const decoded = await decodeVinOrThrow(input.vin);
        vehicle = { year: decoded.year, make: decoded.make, model: decoded.model, trim: decoded.trim };
      } else {
        vehicle = { year: input.year as number, make: input.make as string, model: input.model as string };
      }
      const catalogVehicle = findCatalogVehicle(catalog, vehicle.year, vehicle.make, vehicle.model);
      if (!catalogVehicle) {
        return {
          result: {
            vehicle,
            catalog_match: false,
            category: input.category,
            parts: [],
            variant_status: "not_in_catalog",
            needs_followup: [
              "Send the year, make, model and trim — or a photo of the door-jamb label — so we can look this vehicle up."
            ],
            charged: false,
            price_usd: 0
          },
          priceCharged: 0,
          reference: null
        };
      }
      let parts = partsInCategory(catalogVehicle, input.category as PartCategory);
      if (input.part) {
        const needle = input.part.toLowerCase();
        parts = parts.filter(p => p.path.toLowerCase().includes(needle));
      }
      const needsFollowup = [...new Set(parts.flatMap(p => p.variant_questions))];
      return {
        result: {
          vehicle: { ...vehicle, range: catalogVehicle.range },
          catalog_match: true,
          category: input.category,
          parts,
          variant_status: worstVariantStatus(parts),
          needs_followup: needsFollowup,
          charged: true,
          price_usd: brainPricing.fullVehicle
        },
        priceCharged: brainPricing.fullVehicle,
        reference: null
      };
    },

    async quote(args) {
      const parsed = quoteArgs.safeParse(args);
      if (!parsed.success) {
        throw unprocessable("VALIDATION_ERROR", "Provide a reference, or year/make/model/glass_type.");
      }
      if ("reference" in parsed.data) {
        const c = await findCaseByReference(store, parsed.data.reference);
        const latestQuote = await store.getLatestQuote(c.id);
        if (!latestQuote) {
          return {
            result: { reference: c.reference, quote_ready: false, quote: null },
            priceCharged: 0,
            reference: c.reference
          };
        }
        const s = latestQuote.snapshot;
        return {
          result: {
            reference: c.reference,
            quote_ready: latestQuote.status === "SENT",
            quote: {
              status: latestQuote.status,
              expires_at: latestQuote.expires_at,
              vehicle: s.vehicle,
              glass_type: s.glass_type,
              part_number: s.part_number,
              supplier_name: s.supplier_name,
              glass_cost_cents: s.glass_cost_cents,
              labor_cents: s.labor_cents,
              profit_cents: s.profit_cents,
              tax_cents: s.tax_cents,
              sell_price_cents: s.sell_price_cents
            }
          },
          priceCharged: 0,
          reference: c.reference
        };
      }
      const { year, make, model, glass_type, part_number } = parsed.data;
      const candidates = await glassCatalog.searchYmm({ year, make, model, glassType: glass_type });
      if (candidates.length === 0) {
        throw new GatewayError("NO_CATALOG_MATCH", "No glass found for that vehicle — staff will need to identify it.", 404);
      }
      const picked = part_number
        ? candidates.find(cand => cand.part_number === part_number)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!picked) {
        return {
          result: {
            estimate: null,
            variant_status: "variant_ambiguous",
            candidates: candidates.map(cand => ({
              part_number: cand.part_number,
              description: cand.description,
              features: cand.features
            })),
            needs_followup: [
              "Does the windshield have a rain sensor near the mirror?",
              "Is there a camera behind the windshield (lane assist / ADAS)?",
              "Heads-up display? Acoustic glass? Heated wiper area?"
            ]
          },
          priceCharged: 0,
          reference: null
        };
      }
      const glassCost = picked.list_price_cents;
      const labor = pricingConfig.labor_cents;
      const profit = pricingConfig.target_profit_cents;
      const tax = Math.round(glassCost * pricingConfig.tax_rate);
      return {
        result: {
          estimate: true,
          variant_status: "exact",
          part_number: picked.part_number,
          description: picked.description,
          glass_cost_cents: glassCost,
          labor_cents: labor,
          profit_cents: profit,
          tax_cents: tax,
          sell_price_cents: glassCost + labor + profit + tax
        },
        priceCharged: 0,
        reference: null
      };
    },

    async order_glass(args, channel) {
      const parsed = orderGlassArgs.safeParse(args);
      if (!parsed.success) {
        throw unprocessable("VALIDATION_ERROR", "reference is required.");
      }
      const c = await findCaseByReference(store, parsed.data.reference);
      const glassRequest = await store.getGlassRequest(c.glass_request_id);
      if (!glassRequest) throw badRequest("CASE_NOT_FOUND", "Case is missing its glass request.");
      const identification = await store.getLatestGlassIdentification(glassRequest.id);
      const selected = identification?.selected_candidate ?? null;
      if (!selected) {
        throw conflict(
          "GLASS_NOT_IDENTIFIED",
          "No glass has been identified for this case yet — identification must finish before ordering."
        );
      }
      const allowedParts = new Set(
        [selected.part_number, ...(identification?.interchange_part_numbers ?? [])].map(p =>
          p.trim().toUpperCase()
        )
      );
      const partNumber = parsed.data.part_number ?? selected.part_number;
      if (!allowedParts.has(partNumber.trim().toUpperCase())) {
        throw unprocessable(
          "VALIDATION_ERROR",
          "That part number is not among the identified candidates for this case."
        );
      }
      if (c.current_state !== "INVOICED") {
        throw conflict(
          "INVALID_STATE",
          `Glass can only be ordered from INVOICED; this case is ${c.current_state}.`
        );
      }
      // No paid lookup happens here: the part comes from the stored
      // identification, and part-number searches are free. The $1
      // MyGrant VIN credit is never spent by this tool.
      const updated = await advanceLifecycle(store, c.id, "order_parts", { type: "STAFF", id: null }, {
        note: `Ordered via Brain Gateway (${channel}): ${partNumber}`
      });
      const offers = await store.listSupplierOffers(glassRequest.id);
      const offer = offers.find(o => o.selected) ?? null;
      return {
        result: {
          reference: c.reference,
          state: updated.current_state,
          part_number: partNumber,
          supplier_name: offer?.supplier_name ?? null
        },
        priceCharged: 0,
        reference: c.reference
      };
    }
  };

  // -- single dispatch endpoint ----------------------------------------

  router.post("/", limiter, requireApiKey, async (req, res) => {
    const started = Date.now();
    const presentedKey =
      typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
    const fingerprint = keyFingerprint(presentedKey || null);
    const parsedEnvelope = dispatchSchema.safeParse(req.body ?? {});
    if (!parsedEnvelope.success) {
      const first = parsedEnvelope.error.issues[0];
      appendAudit(
        {
          channel: "direct",
          tool: "unknown",
          key_fingerprint: fingerprint,
          ok: false,
          error_code: "VALIDATION_ERROR",
          price_usd_charged: 0,
          duration_ms: Date.now() - started,
          reference: null
        },
        auditLogPath
      );
      return res.status(422).json({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: first?.message ?? "tool, arguments and channel are required."
        }
      });
    }
    const { tool, arguments: args, channel } = parsedEnvelope.data;
    const audit = (ok: boolean, errorCode: string | null, price: number, reference: string | null) =>
      appendAudit(
        {
          channel,
          tool,
          key_fingerprint: fingerprint,
          ok,
          error_code: errorCode,
          price_usd_charged: price,
          duration_ms: Date.now() - started,
          reference
        },
        auditLogPath
      );

    if (!toolNames.has(tool)) {
      audit(false, "UNKNOWN_TOOL", 0, null);
      return res.status(400).json({
        ok: false,
        error: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${tool}.` }
      });
    }
    if (tool === "order_glass" && !staffApiKeys.some(k => keyMatches(presentedKey, k))) {
      audit(false, "STAFF_ONLY", 0, null);
      return res.status(403).json({
        ok: false,
        error: {
          code: "STAFF_ONLY",
          message: "order_glass is staff-only and needs a staff API key."
        }
      });
    }
    try {
      const outcome = await handlers[tool](args, channel);
      audit(true, null, outcome.priceCharged, outcome.reference);
      const status = tool === "create_case" ? 201 : 200;
      return res.status(status).json({
        ok: true,
        tool,
        channel,
        result: outcome.result,
        price_usd_charged: outcome.priceCharged
      });
    } catch (error) {
      if (error instanceof GatewayError) {
        audit(false, error.code, 0, null);
        return res.status(error.httpStatus).json({
          ok: false,
          error: { code: error.code, message: error.message }
        });
      }
      console.error(`brain gateway tool ${tool} failed:`, error);
      audit(false, "INTERNAL_ERROR", 0, null);
      return res.status(500).json({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "The gateway could not complete that tool call." }
      });
    }
  });

  return router;
}

/** Mounts the Brain Gateway at /api/v1/brain on an Express app. */
export function mountBrainGateway(app: express.Express, deps: BrainGatewayDeps): void {
  app.use("/api/v1/brain", createBrainRouter(deps));
}
