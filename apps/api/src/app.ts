import express from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import { signatureMethodOf, type CaseRecord, type Channel, type StaffUser } from "./types.js";
import type { CaseStore } from "./store.js";
import type { GlassCatalogProvider } from "./glass-catalog.js";
import { createGlassCatalogProvider } from "./mygrant.js";
import { decodeVinNhtsa, VinDecodeError } from "./vin-decode.js";
import { isValidVin } from "./vin-validation.js";
import { ocrVinFromImage, OcrError, type OcrVinResult } from "./vin-ocr.js";
import {
  IdentificationError,
  markGlassUnidentifiable,
  overrideGlassCandidate,
  requestVinLookup,
  runIdentification,
  selectGlassCandidate
} from "./glass-identification.js";
import {
  overrideSupplierOffer,
  runSourcing,
  SourcingError,
  type SourcingProvider
} from "./sourcing.js";
import { createSourcingProvider } from "./mygrant.js";
import {
  approvePrice,
  loadPricingConfig,
  PricingError,
  rejectPrice,
  runPricing,
  type PricingConfig
} from "./pricing.js";
import {
  closeCase,
  declineQuote,
  generateInvoice,
  generateQuote,
  loadQuotingConfig,
  normalizeSignerName,
  QuotingError,
  signQuote,
  type QuotingConfig
} from "./quoting.js";
import {
  ensureSeedAdmin,
  requireAuth,
  signToken,
  verifyPassword,
  type AuthConfig
} from "./auth.js";
import {
  consumeApprovalToken,
  mintApprovalToken,
  verifyApprovalToken
} from "./approval-tokens.js";
import {
  advanceLifecycle,
  LIFECYCLE_STEPS,
  LifecycleError
} from "./lifecycle.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  createAddressProvider,
  type AddressProvider,
  type AddressSuggestion
} from "./address.js";

const createCaseSchema = z.object({
  channel: z.enum(["DIRECT", "AUCTION", "INSURANCE"]),
  customer_id: z.string().uuid().nullable().optional(),
  vehicle: z.object({
    year: z.number().int().min(1886).max(2100),
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    // Shared ISO 3779 gate (format + check digit): the same validation
    // applied to typed VINs at /vin/decode and to photographed VINs when
    // their OCR candidate is confirmed through /vin/decode.
    vin: z
      .string()
      .trim()
      .min(1)
      .refine(isValidVin, {
        message:
          "VIN must be 17 characters (A-Z except I, O, Q, plus digits) with a valid check digit."
      })
  }),
  glass_request: z.object({
    glass_type: z.enum(["WINDSHIELD", "BACK_GLASS", "DOOR_GLASS", "QUARTER_GLASS", "VENT_GLASS"])
  })
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1)
});

/**
 * Public client intake (Slice A, QR front door). Fields arrive as strings
 * (multipart form) or JSON. Empty strings are treated as "not provided"
 * for the optional vehicle fields. Strict: unknown keys are stripped by
 * zod's default object behavior, so a client cannot smuggle internal
 * fields (channel, state, pricing) into case creation — the handler
 * below pins channel DIRECT itself.
 */
/** Newest vehicle year a client may claim: this year or next year's models. */
const MAX_VEHICLE_YEAR = new Date().getFullYear() + 1;

const publicIntakeSchema = z.object({
  customer_name: z.string().trim().min(2).max(120),
  customer_phone: z.string().trim().min(7).max(32),
  glass_type: z.enum(["WINDSHIELD", "BACK_GLASS", "DOOR_GLASS", "QUARTER_GLASS", "VENT_GLASS"]),
  // Legacy: the 3-card intake (2026-10-21) removed the "What happened?"
  // free-text field, and the client no longer sends it. Still accepted
  // (and projected for staff) so older clients in the field don't break.
  note: z.string().trim().max(1000).optional(),
  vin: z.string().trim().max(17).optional(),
  year: z.coerce.number().int().min(1950).max(MAX_VEHICLE_YEAR).optional(),
  make: z.string().trim().min(1).max(60).optional(),
  model: z.string().trim().min(1).max(60).optional()
});

/**
 * The service address the customer PICKED from the suggestion list —
 * never free text. Validated separately from the main schema because
 * the client sends it as a JSON string inside the multipart form, and
 * because its failure mode is its own 400 (see the intake handler).
 */
const serviceAddressSchema = z.object({
  place_id: z.string().trim().min(1).max(160),
  formatted: z.string().trim().min(1).max(400),
  street: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(2).max(80),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180)
});

export type ServiceAddress = z.infer<typeof serviceAddressSchema>;

/**
 * Normalizes a US phone number to its 10 digits, or null when the
 * input isn't one: punctuation/formatting is fine, an 11-digit number
 * with a leading 1 (country code) is fine, anything else is not. The
 * leading digit of the area code must be 2-9 (NANP rule). Mirrored by
 * the web client's pre-check; this server check is the real gate.
 */
export function normalizeUsPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (!/^[2-9]/.test(digits)) return null;
  return digits;
}

export interface ServiceAddressView {
  formatted: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lon: number | null;
  place_id: string | null;
}

export interface ClientIntakeView {
  source: string;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  /** OCR reading of the client's VIN photo — a staff suggestion only. */
  vin_ocr_suggestion: string | null;
  photo_count: number;
  /** Where the car will be serviced — the address the customer picked. */
  service_address: ServiceAddressView | null;
  submitted_at: string;
}

/** Defensive projection of the intake event payload for staff responses. */
function clientIntakeView(payload: Record<string, unknown>, occurredAt: string): ClientIntakeView {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rawAddress =
    payload.service_address && typeof payload.service_address === "object"
      ? (payload.service_address as Record<string, unknown>)
      : null;
  const service_address: ServiceAddressView | null =
    rawAddress && str(rawAddress.formatted)
      ? {
          formatted: str(rawAddress.formatted) as string,
          street: str(rawAddress.street),
          city: str(rawAddress.city),
          state: str(rawAddress.state),
          zip: str(rawAddress.zip),
          lat: num(rawAddress.lat),
          lon: num(rawAddress.lon),
          place_id: str(rawAddress.place_id)
        }
      : null;
  return {
    source: str(payload.source) ?? "CLIENT_QR",
    customer_name: str(payload.customer_name),
    customer_phone: str(payload.customer_phone),
    note: str(payload.note),
    vin_ocr_suggestion: str(payload.vin_ocr_suggestion),
    photo_count: Array.isArray(payload.photos) ? payload.photos.length : 0,
    service_address,
    submitted_at: occurredAt
  };
}

export interface SecurityConfig {
  /** Exact origins allowed by CORS. Defaults to the CORS_ORIGIN env var. */
  corsOrigins?: string[];
  /** Max login attempts per window. Defaults to LOGIN_RATE_LIMIT_MAX (20). */
  loginRateLimitMax?: number;
  /** Rate-limit window in ms. Defaults to LOGIN_RATE_LIMIT_WINDOW_MS (10 min). */
  loginRateLimitWindowMs?: number;
  /** Max public intake submissions per window/IP. Defaults to INTAKE_RATE_LIMIT_MAX (20). */
  intakeRateLimitMax?: number;
  /** Rate-limit window in ms. Defaults to INTAKE_RATE_LIMIT_WINDOW_MS (10 min). */
  intakeRateLimitWindowMs?: number;
  /** Max address-suggest lookups per window/IP. Defaults to ADDRESS_SUGGEST_RATE_LIMIT_MAX (120). */
  addressSuggestRateLimitMax?: number;
  /** Address-suggest rate-limit window in ms. Defaults to ADDRESS_SUGGEST_RATE_LIMIT_WINDOW_MS (10 min). */
  addressSuggestRateLimitWindowMs?: number;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface AppDeps {
  /**
   * Glass catalog provider. Defaults to the deterministic mock (no network,
   * no charges). The live MyGrant provider implements the same interface.
   */
  glassCatalog?: GlassCatalogProvider;
  /**
   * Supplier sourcing provider. Defaults to the deterministic mock (no
   * network, no charges). A live supplier integration implements the same
   * interface.
   */
  sourcingProvider?: SourcingProvider;
  /** Pricing configuration override (for tests). Defaults to env vars. */
  pricingConfig?: PricingConfig;
  /** Quoting configuration override (for tests). Defaults to env vars. */
  quotingConfig?: QuotingConfig;
  /**
   * VIN-photo OCR used by the public intake (staff OCR route keeps the
   * default). Injectable so tests can stub Tesseract, mirroring the
   * recognizer injection inside vin-ocr.ts itself.
   */
  vinOcr?: (image: Buffer) => Promise<OcrVinResult>;
  /**
   * Address-suggestion provider for the intake service-address field.
   * Defaults to the env-selected provider (ADDRESS_PROVIDER=nominatim|mock).
   * Injectable so tests never call the live geocoder.
   */
  addressProvider?: AddressProvider;
}

export function createApp(
  store: CaseStore,
  authConfig: AuthConfig,
  securityConfig: SecurityConfig = {},
  deps: AppDeps = {}
) {
  const glassCatalog = deps.glassCatalog ?? createGlassCatalogProvider();
  const sourcingProvider = deps.sourcingProvider ?? createSourcingProvider();
  const addressProvider = deps.addressProvider ?? createAddressProvider();
  const pricingConfig = deps.pricingConfig ?? loadPricingConfig();
  const quotingConfig = deps.quotingConfig ?? loadQuotingConfig();
  const app = express();

  // Do not fingerprint the framework: Express sets X-Powered-By by default.
  app.disable("x-powered-by");

  // Trust the first proxy hop (Vercel edge / web proxy) so req.ip reflects the
  // real client. Required for the login rate limiter to key on client IPs.
  app.set("trust proxy", 1);

  // Baseline security headers for a JSON API. HSTS is served by the Vercel
  // edge; these cover what the edge does not set.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const corsOrigins =
    securityConfig.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGIN);
  // Browsers reach the API through the web app's same-origin proxy, so CORS
  // is defense in depth. When CORS_ORIGIN is unset we stay permissive (and
  // warn) so preview deployments keep working; production sets it explicitly.
  app.use(cors(corsOrigins.length > 0 ? { origin: corsOrigins } : {}));
  if (corsOrigins.length === 0) {
    console.warn(
      "WARNING: CORS_ORIGIN is not set; allowing all origins. " +
        "Set CORS_ORIGIN to the web app origin in deployed environments."
    );
  }

  app.use(express.json({ limit: "256kb" }));

  const auth = requireAuth(authConfig);

  const loginLimiter = createRateLimiter({
    windowMs:
      securityConfig.loginRateLimitWindowMs ??
      Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000),
    max:
      securityConfig.loginRateLimitMax ??
      Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20)
  });

  const detail = async (c: CaseRecord) => {
    const [vehicle, glass_request] = await Promise.all([
      store.getVehicle(c.vehicle_id),
      store.getGlassRequest(c.glass_request_id)
    ]);
    const glass_identification = glass_request
      ? await store.getLatestGlassIdentification(glass_request.id)
      : null;
    const supplier_offers = glass_request
      ? await store.listSupplierOffers(glass_request.id)
      : [];
    const price_calculation = glass_request
      ? await store.getLatestPriceCalculation(glass_request.id)
      : null;
    const invoice = await store.getLatestInvoice(c.id);
    const quote = await store.getLatestQuote(c.id);
    // Staff-only projection of a client self-service intake (Slice A):
    // the CLIENT_INTAKE_SUBMITTED event is the source of truth for who
    // sent the case in and how staff reach them. Staff-created cases
    // have no such event and project null.
    const events = await store.getEvents(c.id);
    const intakeEvent = [...events]
      .reverse()
      .find(e => e.event_type === "CLIENT_INTAKE_SUBMITTED");
    const client_intake = intakeEvent
      ? clientIntakeView(intakeEvent.payload, intakeEvent.occurred_at)
      : null;
    return { ...c, vehicle, glass_request, glass_identification, supplier_offers, price_calculation, quote, invoice, client_intake };
  };

  /**
   * Advances the automatic workflow chain after a state change:
   * GLASS_IDENTIFIED → sourcing → GLASS_SELECTED → pricing.
   * Staff-driven states (NO_ELIGIBLE_INVENTORY, PROFIT_REVIEW_REQUIRED)
   * wait for explicit R&R actions.
   */
  const advanceWorkflow = async (caseId: string): Promise<void> => {
    const c = await store.getCase(caseId);
    if (!c) return;
    if (c.current_state === "GLASS_IDENTIFIED") {
      await runSourcing(store, sourcingProvider, caseId);
      const after = await store.getCase(caseId);
      if (after?.current_state === "GLASS_SELECTED") {
        await runPricing(store, pricingConfig, caseId);
      }
    } else if (c.current_state === "GLASS_SELECTED") {
      await runPricing(store, pricingConfig, caseId);
    }
  };

  /**
   * Automation (Nelly, 2026-10-19): an approved price IS a quote — staff
   * never click "Generate quote". After any staff action, if the case is
   * sitting at PRICE_APPROVED with no quote yet, generate one. If a
   * reprice (supplier/glass override, sourcing retry) produced a NEWER
   * approved price than the outstanding quote was built from, requote:
   * the new version supersedes the stale one. A signed quote is the
   * customer's contract and is never requoted.
   */
  const autoQuoteIfPriced = async (
    caseId: string,
    actor: { type: string; id: string | null }
  ): Promise<void> => {
    const c = await store.getCase(caseId);
    if (!c) return;
    if (c.current_state !== "PRICE_APPROVED" && c.current_state !== "QUOTE_SENT") return;
    const glassRequest = await store.getGlassRequest(c.glass_request_id);
    if (!glassRequest) return;
    const latestPrice = await store.getLatestPriceCalculation(glassRequest.id);
    if (!latestPrice || latestPrice.status !== "APPROVED") return;
    const latestQuote = await store.getLatestQuote(caseId);
    if (latestQuote?.signature) return;
    if (latestQuote && latestQuote.snapshot.price_calculation_id === latestPrice.id) return;
    await generateQuote(store, quotingConfig, caseId, actor, {
      auto: true,
      trigger: latestQuote ? "reprice" : "price_approved"
    });
  };

  /**
   * NOTE (serverless safety): case creation used to kick off identification
   * as a fire-and-forget promise chain after returning the case shell. On
   * serverless platforms the runtime may freeze the moment the response is
   * sent, silently killing the chain mid-processing. Identification is now
   * started by the client through the awaited `start_identification` action
   * below: the work runs inside that request's lifecycle, so the platform
   * cannot freeze it until the response is sent. The client streams progress
   * by polling the case's event stream independently.
   */

  // Health is served at both /health (deploy monitors, direct API checks)
  // and /api/v1/health (reachable through the web app's same-origin API
  // proxy, which only forwards /api/v1/*).
  const healthHandler = async (_req: express.Request, res: express.Response) => {
    await store.health();
    res.json({
      ok: true,
      storage: process.env.DATABASE_URL ? "postgres" : "json",
      glass_catalog: glassCatalog.name,
      sourcing_provider: sourcingProvider.name,
      // Boolean only: proves the MyGrant secrets reached the runtime without
      // ever exposing their values. Live mode additionally requires
      // GLASS_CATALOG_PROVIDER/SOURCING_PROVIDER=mygrant.
      mygrant_configured: Boolean(process.env.MYGRANT_USERNAME && process.env.MYGRANT_PASSWORD)
    });
  };
  app.get("/health", healthHandler);
  app.get("/api/v1/health", healthHandler);

  app.post("/api/v1/auth/login", loginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Email and password are required."
        }
      });
    }

    // Seed the admin inside the request lifecycle: cold-start seeding is
    // unreliable on serverless (the DB connection can die across the
    // init/request freeze boundary), so guarantee the account exists here.
    await ensureSeedAdmin(store);

    const record = await store.findStaffByEmail(parsed.data.email);
    const valid =
      record !== null &&
      (await verifyPassword(parsed.data.password, record.password_hash));

    if (!valid) {
      // Generic message: do not reveal whether the email exists.
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Email or password is incorrect."
        }
      });
    }

    const { password_hash: _hash, ...staff } = record;
    const token = signToken(staff, authConfig.authSecret, authConfig.tokenTtlSeconds);
    return res.json({ token, staff });
  });

  app.get("/api/v1/auth/me", auth, (req, res) => {
    res.json({ staff: req.staff });
  });

  /**
   * VIN decode via NHTSA vPIC (free, no key). Staff-only.
   * Decodes a 17-character VIN to Year/Make/Model/Trim for VIN-first
   * case creation. This is the free VIN→YMM lookup, distinct from the
   * paid MyGrant VIN→glass-part lookup.
   */
  app.post("/api/v1/vin/decode", auth, async (req, res) => {
    const vin = typeof req.body?.vin === "string" ? req.body.vin : "";
    try {
      const decoded = await decodeVinNhtsa(vin);
      res.json({ vin: decoded.vin, vehicle: decoded });
    } catch (error) {
      if (error instanceof VinDecodeError) {
        return res.status(422).json({
          error: { code: "VIN_DECODE_FAILED", message: error.message }
        });
      }
      throw error;
    }
  });

  /**
   * VIN OCR: extract a VIN candidate from a photo (dashboard plate,
   * registration, etc.). Returns the candidate for staff confirmation —
   * the caller should feed the confirmed VIN into /vin/decode.
   * Staff-only. Multipart upload, field name "photo", max 10MB.
   */
  const vinPhotoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
  });
  app.post(
    "/api/v1/vin/ocr",
    auth,
    vinPhotoUpload.single("photo"),
    async (req, res) => {
      try {
        const buffer = req.file?.buffer;
        if (!buffer) {
          return res.status(422).json({
            error: {
              code: "VIN_OCR_NO_PHOTO",
              message: "Attach a photo in the 'photo' field."
            }
          });
        }
        const result = await ocrVinFromImage(buffer);
        if (!result.vin) {
          return res.status(422).json({
            error: {
              code: "VIN_OCR_NOT_FOUND",
              message:
                "No VIN found in the photo. Try a clearer shot of the VIN plate or type the VIN manually."
            }
          });
        }
        res.json({ vin: result.vin });
      } catch (error) {
        if (error instanceof OcrError) {
          return res.status(422).json({
            error: { code: "VIN_OCR_FAILED", message: error.message }
          });
        }
        throw error;
      }
    }
  );

  // ---------------------------------------------------------------------
  // Customer-facing public routes (no staff session).
  //
  // Access is by opaque approval token only: a `quote-approval` token
  // (single-use, dies with the quote) opens one case's quote so the
  // customer can sign (= approve) or decline it; signing consumes it and
  // mints a long-lived view-only `case-view` token for tracking.
  // Responses are PROJECTIONS built field-by-field — internal state,
  // supplier offers/names, glass cost and profit never leave the server.
  // ---------------------------------------------------------------------

  const publicLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.PUBLIC_RATE_LIMIT_MAX ?? 600)
  });

  const linkInvalid = (res: express.Response) =>
    res.status(404).json({
      error: {
        code: "LINK_INVALID",
        message: "This link is invalid or has already been used."
      }
    });

  const quoteNounFor = (channel: Channel): string =>
    channel === "AUCTION" ? "work request" : channel === "INSURANCE" ? "estimate" : "quote";

  /** Customer projection of a quote: totals the client may see, nothing else. */
  const publicQuoteView = async (c: CaseRecord) => {
    const quote = await store.getLatestQuote(c.id);
    if (!quote) return null;
    const expired =
      quote.status === "EXPIRED" ||
      (quote.status === "SENT" && Date.parse(quote.expires_at) <= Date.now());
    return {
      reference: c.reference,
      channel: c.channel,
      noun: quoteNounFor(c.channel),
      vehicle: {
        year: quote.snapshot.vehicle.year,
        make: quote.snapshot.vehicle.make,
        model: quote.snapshot.vehicle.model
      },
      glass_type: quote.snapshot.glass_type,
      labor_cents: quote.snapshot.labor_cents,
      tax_cents: quote.snapshot.tax_cents,
      total_cents: quote.snapshot.sell_price_cents,
      quote_version: quote.version,
      expires_at: quote.expires_at,
      status: quote.signature
        ? "APPROVED"
        : quote.status === "DECLINED"
          ? "DECLINED"
          : expired
            ? "EXPIRED"
            : "AWAITING_SIGNATURE",
      signed_by: quote.signature?.name ?? null,
      signed_at: quote.signature?.signed_at ?? null,
      // How the signature was captured, so the client page can render a
      // typed signature as the name in a signature style. The drawn image
      // itself never leaves the server (staff-visible only).
      signature_method: quote.signature ? signatureMethodOf(quote.signature) : null
    };
  };

  const TRACKING_EVENT_TYPES = [
    "QUOTE_SIGNED",
    "INVOICE_GENERATED",
    "PARTS_ORDERED",
    "INSTALLATION_SCHEDULED",
    "TECH_DISPATCHED",
    "SERVICE_STARTED",
    "SERVICE_COMPLETED",
    "CASE_CLOSED"
  ] as const;

  const FRIENDLY_STATUS: Record<string, string> = {
    QUOTE_SENT: "Your quote is ready for your signature",
    QUOTE_APPROVED: "Quote approved — your invoice is being prepared",
    INVOICED: "Invoice ready — we're ordering your parts",
    PARTS_ORDERED: "Parts ordered",
    INSTALLATION_SCHEDULED: "Installation scheduled",
    TECH_DISPATCHED: "Your technician is on the way",
    INSTALLATION_IN_PROGRESS: "Service in progress",
    SERVICE_COMPLETED: "Service completed",
    CLOSED: "All done — thank you!",
    QUOTE_DECLINED: "Quote declined",
    QUOTE_EXPIRED: "Quote expired"
  };

  /** Customer tracking projection: milestones + totals, from safe fields only. */
  const publicTrackingView = async (c: CaseRecord) => {
    const [quote, invoice, events] = await Promise.all([
      store.getLatestQuote(c.id),
      store.getLatestInvoice(c.id),
      store.getEvents(c.id)
    ]);
    const latestByType = new Map<string, (typeof events)[number]>();
    for (const e of events) {
      if ((TRACKING_EVENT_TYPES as readonly string[]).includes(e.event_type)) {
        const prev = latestByType.get(e.event_type);
        if (!prev || e.sequence > prev.sequence) latestByType.set(e.event_type, e);
      }
    }
    const milestone = (eventType: string, key: string, label: string) => {
      const e = latestByType.get(eventType);
      if (!e) return { key, label, done: false, at: null as string | null, detail: null as string | null };
      const detail =
        eventType === "INSTALLATION_SCHEDULED" && typeof e.payload.scheduled_at === "string"
          ? e.payload.scheduled_at
          : eventType === "TECH_DISPATCHED" && typeof e.payload.technician_name === "string"
            ? e.payload.technician_name
            : null;
      return { key, label, done: true, at: e.occurred_at, detail };
    };
    const totals = invoice?.actuals ?? quote?.snapshot ?? null;
    return {
      reference: c.reference,
      channel: c.channel,
      vehicle: quote
        ? {
            year: quote.snapshot.vehicle.year,
            make: quote.snapshot.vehicle.make,
            model: quote.snapshot.vehicle.model
          }
        : null,
      glass_type: quote?.snapshot.glass_type ?? null,
      status: FRIENDLY_STATUS[c.current_state] ?? "In progress",
      current_state: c.current_state,
      signed_by: quote?.signature?.name ?? null,
      signed_at: quote?.signature?.signed_at ?? null,
      signature_method: quote?.signature ? signatureMethodOf(quote.signature) : null,
      invoice: invoice
        ? { version: invoice.version, total_cents: invoice.actuals.sell_price_cents }
        : null,
      labor_cents: totals?.labor_cents ?? null,
      tax_cents: totals?.tax_cents ?? null,
      total_cents: totals?.sell_price_cents ?? null,
      milestones: [
        milestone("QUOTE_SIGNED", "quote_signed", "Quote approved"),
        milestone("INVOICE_GENERATED", "invoice_created", "Invoice created from your approved quote"),
        milestone("PARTS_ORDERED", "parts_ordered", "Parts ordered"),
        milestone("INSTALLATION_SCHEDULED", "scheduled", "Installation scheduled"),
        milestone("TECH_DISPATCHED", "tech_dispatched", "Technician dispatched"),
        milestone("SERVICE_STARTED", "service_started", "Service started"),
        milestone("SERVICE_COMPLETED", "service_completed", "Service completed"),
        milestone("CASE_CLOSED", "closed", "Job closed")
      ]
    };
  };

  app.get("/api/v1/public/quote/:token", publicLimiter, async (req, res) => {
    const grant = await verifyApprovalToken(store, String(req.params.token), "quote-approval");
    if (!grant) return linkInvalid(res);
    const c = await store.getCase(grant.caseId);
    if (!c || c.channel !== grant.channel) return linkInvalid(res);
    const view = await publicQuoteView(c);
    if (!view) return linkInvalid(res);
    return res.json(view);
  });

  app.post("/api/v1/public/quote/:token/sign", publicLimiter, async (req, res) => {
    const grant = await verifyApprovalToken(store, String(req.params.token), "quote-approval");
    if (!grant) return linkInvalid(res);
    const c = await store.getCase(grant.caseId);
    if (!c || c.channel !== grant.channel) return linkInvalid(res);
    const name = req.body?.name;
    const signatureDataUrl = req.body?.signature_data_url;
    if (typeof name !== "string" || !name.trim()) {
      return res.status(422).json({
        error: { code: "VALIDATION_ERROR", message: "name is required." }
      });
    }
    // The typed name IS the signature: it must be a first AND last name.
    if (normalizeSignerName(name).split(" ").filter(Boolean).length < 2) {
      return res.status(422).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Enter your first and last name in the signature field."
        }
      });
    }
    const customerActor = { type: "CUSTOMER", id: null };
    try {
      await signQuote(
        store,
        c.id,
        {
          name: name.trim(),
          // Legacy clients may still send a drawn signature image; it is
          // accepted and stored, but no longer required.
          signatureDataUrl:
            typeof signatureDataUrl === "string" && signatureDataUrl.trim()
              ? signatureDataUrl.trim()
              : undefined,
          attribution: "customer signature via shared link"
        },
        customerActor
      );
    } catch (error) {
      if (error instanceof QuotingError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      throw error;
    }
    // The link did its job: consume it so it cannot be replayed.
    await consumeApprovalToken(store, grant.jti);
    // The signed quote becomes the invoice (staff may also generate it
    // manually; this is idempotent because an existing invoice is kept).
    let invoice = await store.getLatestInvoice(c.id);
    if (!invoice) {
      invoice = await generateInvoice(store, c.id, { type: "SYSTEM", id: null });
    }
    // Hand the customer a long-lived, view-only tracking link.
    const tracking = await mintApprovalToken(store, {
      caseId: c.id,
      channel: c.channel,
      purpose: "case-view",
      ttlSeconds: 30 * 24 * 3600
    });
    return res.json({
      ok: true,
      status: "APPROVED",
      invoice_version: invoice.version,
      tracking_token: tracking.token,
      tracking_expires_at: tracking.expiresAt
    });
  });

  app.post("/api/v1/public/quote/:token/decline", publicLimiter, async (req, res) => {
    const grant = await verifyApprovalToken(store, String(req.params.token), "quote-approval");
    if (!grant) return linkInvalid(res);
    const c = await store.getCase(grant.caseId);
    if (!c || c.channel !== grant.channel) return linkInvalid(res);
    try {
      await declineQuote(store, c.id, { type: "CUSTOMER", id: null });
    } catch (error) {
      if (error instanceof QuotingError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      throw error;
    }
    await consumeApprovalToken(store, grant.jti);
    return res.json({ ok: true, status: "DECLINED" });
  });

  app.get("/api/v1/public/track/:token", publicLimiter, async (req, res) => {
    const grant = await verifyApprovalToken(store, String(req.params.token), "case-view");
    if (!grant) return linkInvalid(res);
    const c = await store.getCase(grant.caseId);
    if (!c || c.channel !== grant.channel) return linkInvalid(res);
    return res.json(await publicTrackingView(c));
  });

  // ---------------------------------------------------------------------
  // Public client intake (Slice A — the QR front door).
  //
  // A customer who scanned R&R's QR code creates the case THEMSELVES:
  // no staff session, no account. The case lands as a normal DIRECT case
  // flagged CLIENT_QR via a CLIENT_INTAKE_SUBMITTED event that also
  // carries the customer's name + mobile (staff need the mobile to text
  // the quote link later), the note/photos metadata, and — since the
  // service-address branch — the structured service address the
  // customer picked from the geocoder's suggestions (fulfillment
  // drives to it, so free-typed addresses are rejected). The submission
  // then drives the case to its quote automatically (identification →
  // sourcing → pricing → auto-quote, the same chain staff start by hand)
  // and returns a view-only intake-status token: the confirmation page
  // polls a client-safe progress projection behind it and, once the
  // quote exists, mints the sign link from it — the customer watches
  // their request become a signable quote without staff lifting a finger.
  //
  // Defenses: a strict zod schema (channel/state/pricing fields a client
  // might smuggle in are stripped and never honored), VIN checksum via
  // the shared ISO 3779 gate when a VIN is given, per-IP rate limiting,
  // and photo caps mirrored from the staff VIN-photo upload (10MB each).
  // Photo BYTES are never persisted — the only durable photo artifact is
  // the OCR reading of a VIN photo, stored as a staff-side suggestion;
  // OCR never overwrites what the client typed (same rule as staff OCR).
  // The response is a client-safe confirmation ONLY: case reference +
  // what happens next. No state names, no ids, no economics.
  // ---------------------------------------------------------------------

  const intakeLimiter = createRateLimiter({
    windowMs:
      securityConfig.intakeRateLimitWindowMs ??
      Number(process.env.INTAKE_RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000),
    max:
      securityConfig.intakeRateLimitMax ??
      Number(process.env.INTAKE_RATE_LIMIT_MAX ?? 20)
  });

  const intakeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 7 }
  });

  const intakeValidationError = (
    res: express.Response,
    message: string,
    field?: string
  ) =>
    res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message,
        ...(field ? { details: { field } } : {})
      }
    });

  // ---------------------------------------------------------------------
  // Address suggestions for the intake contact card. The customer types,
  // we proxy the geocoder server-side (proper User-Agent, US-only,
  // short in-memory cache, per-IP rate limit), and the customer MUST
  // pick one of the returned suggestions — the intake POST then carries
  // that structured address, so a made-up address can never be stored.
  // Provider is env-swappable; tests and e2e always run the mock.
  // ---------------------------------------------------------------------

  const suggestLimiter = createRateLimiter({
    windowMs:
      securityConfig.addressSuggestRateLimitWindowMs ??
      Number(process.env.ADDRESS_SUGGEST_RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000),
    max:
      securityConfig.addressSuggestRateLimitMax ??
      Number(process.env.ADDRESS_SUGGEST_RATE_LIMIT_MAX ?? 120)
  });

  const SUGGEST_CACHE_TTL_MS = 60 * 1000;
  const suggestCache = new Map<string, { at: number; suggestions: AddressSuggestion[] }>();

  app.get("/api/v1/public/address/suggest", suggestLimiter, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 3) {
      return res.json({ suggestions: [] });
    }
    const cacheKey = q.toLowerCase().replace(/\s+/g, " ");
    const cached = suggestCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SUGGEST_CACHE_TTL_MS) {
      return res.json({ suggestions: cached.suggestions });
    }
    try {
      const suggestions = await addressProvider.suggest(q);
      suggestCache.set(cacheKey, { at: Date.now(), suggestions });
      return res.json({ suggestions });
    } catch (err) {
      console.error("address suggest failed:", err);
      return res.status(502).json({
        error: {
          code: "ADDRESS_LOOKUP_FAILED",
          message: "Address lookup is unavailable right now — please try again in a moment."
        }
      });
    }
  });

  app.post(
    "/api/v1/public/intake",
    intakeLimiter,
    intakeUpload.fields([
      { name: "vin_photo", maxCount: 1 },
      { name: "photos", maxCount: 6 }
    ]),
    async (req, res) => {
      // Normalize: multipart fields are strings and untouched optional
      // inputs arrive as "" — treat those as "not provided".
      const raw: Record<string, unknown> = { ...(req.body ?? {}) };
      for (const key of ["note", "vin", "year", "make", "model"]) {
        if (typeof raw[key] === "string" && (raw[key] as string).trim() === "") {
          delete raw[key];
        }
      }
      const parsed = publicIntakeSchema.safeParse(raw);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return intakeValidationError(
          res,
          first?.message ?? "Invalid request.",
          first?.path.join(".")
        );
      }
      const input = parsed.data;

      // Service address: REQUIRED, and it must be an address the
      // customer picked from the suggestion list — structured fields
      // with the provider's place id, not free text (a made-up address
      // sends a tech to the wrong place). It arrives as a JSON string
      // in the multipart form (or an object in a JSON body). A missing
      // or malformed one is a 400 with the field named, so the UI can
      // pin the error to the address field.
      let rawAddress: unknown = raw.service_address;
      if (typeof rawAddress === "string") {
        try {
          rawAddress = JSON.parse(rawAddress);
        } catch {
          rawAddress = undefined;
        }
      }
      const parsedAddress = serviceAddressSchema.safeParse(rawAddress);
      if (!parsedAddress.success) {
        return res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Pick the address where we'll find the car from the suggestions, so we have a real address.",
            details: { field: "service_address" }
          }
        });
      }
      const serviceAddress: ServiceAddress = {
        ...parsedAddress.data,
        street: parsedAddress.data.street ?? null
      };

      // Phone: must normalize to a valid 10-digit US number (common
      // formats and a leading 1 are fine; anything else is not a
      // number we can text a quote to).
      if (!normalizeUsPhone(input.customer_phone)) {
        return intakeValidationError(
          res,
          "Enter a valid 10-digit US mobile number so we can text your quote.",
          "customer_phone"
        );
      }

      // Vehicle resolution: VIN preferred. A client who gives only a VIN
      // gets year/make/model from the free NHTSA decode (same source the
      // staff VIN-first flow uses); a client with no VIN must give YMM.
      let vin: string | null = null;
      if (input.vin) {
        if (!isValidVin(input.vin)) {
          return intakeValidationError(
            res,
            "That VIN doesn't look right — check the 17 characters and try again, or enter your vehicle's year, make and model instead.",
            "vin"
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
          return intakeValidationError(
            res,
            "We couldn't read that VIN. Please add your vehicle's year, make and model.",
            "vehicle"
          );
        }
      }
      if (year === undefined || !make || !model) {
        return intakeValidationError(
          res,
          "Tell us your vehicle: enter your VIN, or your vehicle's year, make and model.",
          "vehicle"
        );
      }

      // Uploaded photos: validate count/shape via multer (already run);
      // keep metadata only. A VIN photo additionally goes through the
      // existing OCR pipeline; its reading is a staff suggestion.
      const files = (req.files ?? {}) as {
        vin_photo?: Express.Multer.File[];
        photos?: Express.Multer.File[];
      };
      const photoMeta: { kind: string; size_bytes: number; content_type: string }[] = [];
      for (const f of files.photos ?? []) {
        photoMeta.push({ kind: "damage", size_bytes: f.size, content_type: f.mimetype });
      }
      // Damage photos cap at 6 (one per glass on the car). Multer's
      // maxCount already rejects a 7th upload before this handler runs;
      // this explicit check keeps the rule true even if the upload
      // wiring changes — the cap is a product rule, not a multer detail.
      if (photoMeta.length > 6) {
        return intakeValidationError(
          res,
          "Up to 6 damage photos — please remove the extras and try again.",
          "photos"
        );
      }
      let vinOcrSuggestion: string | null = null;
      const vinPhoto = files.vin_photo?.[0];
      if (vinPhoto) {
        photoMeta.push({ kind: "vin", size_bytes: vinPhoto.size, content_type: vinPhoto.mimetype });
        try {
          const ocr = await (deps.vinOcr ?? ocrVinFromImage)(vinPhoto.buffer);
          vinOcrSuggestion = ocr.vin;
        } catch {
          // OCR is an assist, never a gate: a failed read must not lose
          // the customer's request. Staff see no suggestion and work
          // from the typed vehicle details as usual.
          vinOcrSuggestion = null;
        }
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
          source: "CLIENT_QR",
          customer_name: input.customer_name,
          customer_phone: input.customer_phone,
          note: input.note ?? null,
          service_address: serviceAddress,
          vin_provided: vin !== null,
          vin_ocr_suggestion: vinOcrSuggestion,
          photos: photoMeta
        }
      });

      // The customer's window into this case: a view-only status token
      // (7 days). Minted BEFORE the chain runs so the confirmation page
      // can follow progress even when the chain pauses for staff.
      const statusGrant = await mintApprovalToken(store, {
        caseId: created.id,
        channel: "DIRECT",
        purpose: "intake-status",
        ttlSeconds: 7 * 24 * 3600
      });

      // Drive the case to its quote NOW (Nelly, 2026-10-20): an intake
      // case must not sit in REQUEST_RECEIVED waiting for a staff click.
      // This is the same awaited chain the staff start_identification
      // action runs — identification → sourcing → pricing → auto-quote —
      // inside this request's lifecycle. Identification here only ever
      // runs the free YMM search; the paid VIN lookup remains a
      // staff-confirmed action, so a public submission can never spend
      // money. Where the chain needs a human (multiple glass candidates,
      // a profit review), it simply stops there and staff pick it up;
      // the customer watches either way. A failure never loses the
      // request: the case stays queued and lands in
      // SYSTEM_ATTENTION_REQUIRED, exactly as if staff had started it.
      try {
        await runIdentification(
          store,
          glassCatalog,
          created.id,
          "START_IDENTIFICATION",
          customerActor
        );
        await advanceWorkflow(created.id);
        await autoQuoteIfPriced(created.id, { type: "SYSTEM", id: null });
      } catch (err) {
        console.error(`intake auto-start failed for case ${created.id}:`, err);
        try {
          await store.appendEvent({
            caseId: created.id,
            eventType: "IDENTIFICATION_ERROR",
            actor: { type: "SYSTEM", id: null },
            nextState: "SYSTEM_ATTENTION_REQUIRED",
            payload: { error: err instanceof Error ? err.message : "Unknown error" }
          });
        } catch (eventErr) {
          console.error(
            `Failed to record IDENTIFICATION_ERROR for case ${created.id}:`,
            eventErr
          );
        }
      }

      return res.status(201).json({
        ok: true,
        reference: created.reference,
        status_token: statusGrant.token,
        message:
          "Thanks — your request is in. We'll review it and text a quote link to the mobile number you gave us."
      });
    }
  );

  /**
   * Client-safe progress projection for an intake case: plain-language
   * phases and steps only. Never the internal state name, never any
   * economics (the quote page is where prices live), never supplier data.
   */
  const POST_GLASS_STATES = new Set([
    "GLASS_IDENTIFIED",
    "GLASS_SELECTED",
    "PRICE_APPROVED",
    "PROFIT_REVIEW_REQUIRED",
    "QUOTE_SENT",
    "QUOTE_DECLINED",
    "QUOTE_EXPIRED",
    "QUOTE_APPROVED",
    "INVOICED",
    "PARTS_ORDERED",
    "INSTALLATION_SCHEDULED",
    "TECH_DISPATCHED",
    "INSTALLATION_IN_PROGRESS",
    "SERVICE_COMPLETED",
    "CLOSED"
  ]);

  const publicIntakeView = async (c: CaseRecord) => {
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
      vehicle: vehicle
        ? { year: vehicle.year, make: vehicle.make, model: vehicle.model }
        : null,
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
  };

  app.get("/api/v1/public/intake-status/:token", publicLimiter, async (req, res) => {
    const grant = await verifyApprovalToken(store, String(req.params.token), "intake-status");
    if (!grant) return linkInvalid(res);
    const c = await store.getCase(grant.caseId);
    if (!c || c.channel !== grant.channel) return linkInvalid(res);
    return res.json(await publicIntakeView(c));
  });

  /**
   * Mints the customer's sign link from their intake-status token, once
   * their quote exists. Same semantics as the staff quote-link endpoint:
   * the token's TTL is bound to the quote's own expiry, minting never
   * revokes earlier links, and the quote page shows the newest version.
   */
  app.post("/api/v1/public/intake-status/:token/quote-link", publicLimiter, async (req, res) => {
    const grant = await verifyApprovalToken(store, String(req.params.token), "intake-status");
    if (!grant) return linkInvalid(res);
    const c = await store.getCase(grant.caseId);
    if (!c || c.channel !== grant.channel) return linkInvalid(res);
    const quote = await store.getLatestQuote(c.id);
    if (!quote || quote.status !== "SENT" || c.current_state !== "QUOTE_SENT") {
      return res.status(409).json({
        error: {
          code: "NO_SIGNABLE_QUOTE",
          message: "Your quote isn't ready yet — this page will update when it is."
        }
      });
    }
    const ttlSeconds = Math.floor((Date.parse(quote.expires_at) - Date.now()) / 1000);
    if (ttlSeconds <= 0) {
      return res.status(410).json({
        error: {
          code: "QUOTE_EXPIRED",
          message: "This quote has expired. Call us and we'll re-issue it."
        }
      });
    }
    const minted = await mintApprovalToken(store, {
      caseId: c.id,
      channel: c.channel,
      purpose: "quote-approval",
      ttlSeconds
    });
    return res.json({ path: `/quote/${minted.token}`, expires_at: quote.expires_at });
  });

  // All case routes require staff authentication.
  app.use("/api/v1/cases", auth);

  /**
   * Channel isolation: staff whose token carries a `channels` claim may only
   * touch cases in those channels. Staff without the claim (e.g. the admin)
   * have full access. Denied single-case reads return 404, not 403, so case
   * existence cannot be probed across channels.
   */
  const canAccessChannel = (staff: StaffUser | undefined, channel: Channel): boolean => {
    if (!staff?.channels) return true;
    return staff.channels.includes(channel);
  };

  const channelForbidden = (res: express.Response) =>
    res.status(403).json({
      error: {
        code: "CHANNEL_FORBIDDEN",
        message: "This case channel is outside your access."
      }
    });

  const channelNotFound = (res: express.Response) =>
    res.status(404).json({
      error: { code: "CASE_NOT_FOUND", message: "Case not found." }
    });

  app.post("/api/v1/cases", async (req, res) => {
    const parsed = createCaseSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(422).json({
        error: {
          code: "VALIDATION_ERROR",
          message: first?.message ?? "Invalid request.",
          details: { field: first?.path.join(".") }
        }
      });
    }

    if (!canAccessChannel(req.staff, parsed.data.channel)) {
      return channelForbidden(res);
    }

    const idempotencyKey = req.header("Idempotency-Key") || undefined;
    const result = await store.createCase({
      channel: parsed.data.channel,
      customer_id: parsed.data.customer_id,
      vehicle: parsed.data.vehicle,
      glass_type: parsed.data.glass_request.glass_type,
      idempotencyKey,
      actor: { type: "RNR_STAFF", id: req.staff?.id ?? null }
    });

    // Glass identification starts after valid intake (workflow-spec §4),
    // but NOT inside this request: the case shell is returned immediately
    // and the client starts identification through the awaited
    // `start_identification` action, which keeps the serverless function
    // alive for the whole run. The client polls the case's event stream
    // for live progress. Phase 3: sourcing + pricing advance automatically
    // from GLASS_IDENTIFIED inside that same awaited request.
    const fresh = (await store.getCase(result.caseRecord.id)) ?? result.caseRecord;
    return res.status(result.reused ? 200 : 201).json(await detail(fresh));
  });

  app.get("/api/v1/cases", async (req, res) => {
    const cases = await store.listCases();
    // Channel-scoped staff only see their channels.
    const visible = cases.filter(c => canAccessChannel(req.staff, c.channel));
    res.json(await Promise.all(visible.map(detail)));
  });

  app.get("/api/v1/cases/:caseId", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    // 404 for cross-channel access: do not reveal case existence.
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }
    res.json(await detail(c));
  });

  app.get("/api/v1/cases/:caseId/events", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }
    res.json(await store.getEvents(c.id));
  });

  /**
   * Mints the customer's sign link for the case's current SENT quote.
   * The raw token is returned exactly once (only its hash is stored);
   * staff copy the link and send it by text/WhatsApp. The token dies at
   * the quote's own expiry — a link can never outlive its quote.
   */
  app.post("/api/v1/cases/:caseId/quote-link", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }
    const quote = await store.getLatestQuote(c.id);
    if (!quote || quote.status !== "SENT" || c.current_state !== "QUOTE_SENT") {
      return res.status(409).json({
        error: {
          code: "NO_SIGNABLE_QUOTE",
          message: "Generate a quote before creating a customer sign link."
        }
      });
    }
    const ttlSeconds = Math.floor((Date.parse(quote.expires_at) - Date.now()) / 1000);
    if (ttlSeconds <= 0) {
      return res.status(410).json({
        error: {
          code: "QUOTE_EXPIRED",
          message: "This quote has expired. Re-quote before sending a new link."
        }
      });
    }
    const minted = await mintApprovalToken(store, {
      caseId: c.id,
      channel: c.channel,
      purpose: "quote-approval",
      ttlSeconds
    });
    return res.json({
      token: minted.token,
      purpose: "quote-approval",
      expires_at: quote.expires_at,
      path: `/quote/${minted.token}`
    });
  });

  /**
   * Mints a fresh view-only tracking link for the customer (30 days).
   * Available once the quote is signed; staff can re-issue it any time
   * (e.g. the customer lost the original link from the sign response).
   */
  app.post("/api/v1/cases/:caseId/tracking-link", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }
    const quote = await store.getLatestQuote(c.id);
    if (!quote?.signature) {
      return res.status(409).json({
        error: {
          code: "QUOTE_NOT_SIGNED",
          message: "Tracking links are available once the customer signs the quote."
        }
      });
    }
    const minted = await mintApprovalToken(store, {
      caseId: c.id,
      channel: c.channel,
      purpose: "case-view",
      ttlSeconds: 30 * 24 * 3600
    });
    return res.json({
      token: minted.token,
      purpose: "case-view",
      expires_at: minted.expiresAt,
      path: `/track/${minted.token}`
    });
  });

  app.post("/api/v1/cases/:caseId/actions", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }

    const staffActor = { type: "RNR_STAFF", id: req.staff?.id ?? null };
    const action = String(req.body?.action ?? "");

    try {
      if (action in LIFECYCLE_STEPS) {
        // Fulfillment steps (order → schedule → dispatch → start →
        // complete) live in lifecycle.ts; they share one handler.
        await advanceLifecycle(store, c.id, action, staffActor, req.body ?? {});
        const updated = await store.getCase(c.id);
        return res.json(await detail(updated!));
      }
      switch (action) {
        case "start_identification": {
          // Guard against double-starts (e.g. a retried request): the
          // client fires this once per fresh case, but a second call must
          // not re-run the whole chain. A genuinely stuck case is recovered
          // with `retry_identification`, which is unaffected by this guard.
          const priorEvents = await store.getEvents(c.id);
          if (priorEvents.some(e => e.event_type === "START_IDENTIFICATION")) {
            return res.status(409).json({
              error: {
                code: "IDENTIFICATION_ALREADY_STARTED",
                message:
                  "Identification has already started for this case. Use retry_identification to run it again."
              }
            });
          }
          try {
            await runIdentification(store, glassCatalog, c.id, "START_IDENTIFICATION", staffActor);
            await advanceWorkflow(c.id);
          } catch (err) {
            // Fail loud: an unexpected error must leave a terminal event so
            // the client's progress screen stops polling instead of hanging
            // until its timeout. Expected failures are already recorded by
            // runIdentification / runSourcing themselves (YMM_SEARCH_FAILED,
            // VIN_LOOKUP_FAILED, SOURCING_FAILED, ...).
            console.error(`start_identification failed for case ${c.id}:`, err);
            try {
              await store.appendEvent({
                caseId: c.id,
                eventType: "IDENTIFICATION_ERROR",
                actor: { type: "SYSTEM", id: null },
                nextState: "SYSTEM_ATTENTION_REQUIRED",
                payload: { error: err instanceof Error ? err.message : "Unknown error" }
              });
            } catch (eventErr) {
              console.error(`Failed to record IDENTIFICATION_ERROR for case ${c.id}:`, eventErr);
            }
            throw err;
          }
          break;
        }
        case "retry_identification":
          await runIdentification(store, glassCatalog, c.id, "RETRY_IDENTIFICATION", staffActor);
          await advanceWorkflow(c.id);
          break;
        case "request_vin_lookup":
          await requestVinLookup(store, glassCatalog, c.id, staffActor);
          await advanceWorkflow(c.id);
          break;
        case "select_glass_candidate": {
          const partNumber = req.body?.part_number;
          if (typeof partNumber !== "string" || !partNumber.trim()) {
            return res.status(422).json({
              error: { code: "VALIDATION_ERROR", message: "part_number is required." }
            });
          }
          await selectGlassCandidate(store, c.id, partNumber.trim(), staffActor);
          await advanceWorkflow(c.id);
          break;
        }
        case "mark_glass_unidentifiable":
          await markGlassUnidentifiable(store, c.id, staffActor);
          break;
        case "override_glass_candidate": {
          const partNumber = req.body?.part_number;
          if (typeof partNumber !== "string" || !partNumber.trim()) {
            return res.status(422).json({
              error: { code: "VALIDATION_ERROR", message: "part_number is required." }
            });
          }
          await overrideGlassCandidate(store, c.id, partNumber.trim(), staffActor);
          await advanceWorkflow(c.id);
          break;
        }
        case "override_supplier_offer": {
          const offerId = req.body?.offer_id;
          if (typeof offerId !== "string" || !offerId.trim()) {
            return res.status(422).json({
              error: { code: "VALIDATION_ERROR", message: "offer_id is required." }
            });
          }
          await overrideSupplierOffer(store, c.id, offerId.trim(), staffActor);
          await advanceWorkflow(c.id);
          break;
        }
        case "retry_sourcing":
          await runSourcing(store, sourcingProvider, c.id, "RETRY_SOURCING", staffActor);
          await advanceWorkflow(c.id);
          break;
        case "approve_price": {
          const profit = req.body?.profit_cents;
          const profitCents =
            profit === undefined || profit === null ? null :
            typeof profit === "number" ? profit :
            null;
          if (profit !== undefined && profit !== null && profitCents === null) {
            return res.status(422).json({
              error: { code: "VALIDATION_ERROR", message: "profit_cents must be a number (cents) or omitted." }
            });
          }
          await approvePrice(store, pricingConfig, c.id, profitCents, staffActor);
          break;
        }
        case "reject_price":
          await rejectPrice(store, c.id, staffActor);
          break;
        case "generate_quote":
          await generateQuote(store, quotingConfig, c.id, staffActor);
          break;
        case "requote":
          // Requote = generate a new quote version (from QUOTE_EXPIRED or
          // QUOTE_DECLINED); history is never mutated.
          await generateQuote(store, quotingConfig, c.id, staffActor);
          break;
        case "sign_quote": {
          const name = req.body?.name;
          const signatureDataUrl = req.body?.signature_data_url;
          const attribution = req.body?.attribution;
          if (typeof name !== "string" || !name.trim()) {
            return res.status(422).json({
              error: { code: "VALIDATION_ERROR", message: "name is required." }
            });
          }
          // The typed name IS the signature: first AND last name required.
          if (normalizeSignerName(name).split(" ").filter(Boolean).length < 2) {
            return res.status(422).json({
              error: {
                code: "VALIDATION_ERROR",
                message: "Enter your first and last name in the signature field."
              }
            });
          }
          await signQuote(
            store,
            c.id,
            {
              name: name.trim(),
              // Legacy drawn images are still accepted, never required.
              signatureDataUrl:
                typeof signatureDataUrl === "string" && signatureDataUrl.trim()
                  ? signatureDataUrl.trim()
                  : undefined,
              attribution: typeof attribution === "string" ? attribution : ""
            },
            staffActor
          );
          break;
        }
        case "decline_quote":
          await declineQuote(store, c.id, staffActor);
          break;
        case "generate_invoice":
          await generateInvoice(store, c.id, staffActor);
          break;
        case "close_case":
          await closeCase(store, c.id, staffActor);
          break;
        default:
          return res.status(409).json({
            error: {
              code: "ACTION_NOT_ALLOWED",
              message: `Action ${action || "(missing)"} is not implemented in Case Core v0.1.`
            }
          });
      }
    } catch (error) {
      if (error instanceof IdentificationError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      if (error instanceof SourcingError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      if (error instanceof PricingError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      if (error instanceof QuotingError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      if (error instanceof LifecycleError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      throw error;
    }

    // Auto-quote: an approved price becomes a quote (and a requote after
    // a reprice) without a staff click. A failure here must not fail the
    // action that just succeeded — the case stays at PRICE_APPROVED and
    // the manual Generate button remains as the fallback.
    try {
      await autoQuoteIfPriced(c.id, staffActor);
    } catch (err) {
      console.error(`auto-quote failed for case ${c.id}:`, err);
    }

    const updated = await store.getCase(c.id);
    return res.json(await detail(updated!));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // express.json() reports malformed payloads as SyntaxError and oversized
    // payloads with status 413: answer 4xx, not 500, and never leak details.
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is not valid JSON."
        }
      });
    }
    // multer reports upload problems (e.g. a VIN photo over the 10MB limit)
    // as MulterError, which carries a `code` instead of an HTTP `status`.
    // Answer 413 for oversized files and 400 for other upload rejections —
    // never 500, and never leak internals.
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Uploaded file is too large."
          }
        });
      }
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "File upload was rejected."
        }
      });
    }
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    if (status === 413) {
      return res.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large."
        }
      });
    }
    console.error(error);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed."
      }
    });
  });

  return app;
}
