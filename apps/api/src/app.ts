import express from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import type { Appointment, CaseRecord, Channel, StaffUser } from "./types.js";
import type { CaseStore } from "./store.js";
import type { GlassCatalogProvider } from "./glass-catalog.js";
import { createGlassCatalogProvider } from "./mygrant.js";
import { decodeVinNhtsa, VinDecodeError } from "./vin-decode.js";
import { isValidVin } from "./vin-validation.js";
import { ocrVinFromImage, OcrError } from "./vin-ocr.js";
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
  ensureSeedAdmin,
  requireAuth,
  signToken,
  verifyPassword,
  type AuthConfig
} from "./auth.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  advanceTracking,
  DispatchError,
  ensureDispatchDemoSeed,
  todayDate,
  type TrackingAction
} from "./dispatch.js";
import {
  mintApprovalToken,
  verifyApprovalToken
} from "./approval-tokens.js";

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

export interface SecurityConfig {
  /** Exact origins allowed by CORS. Defaults to the CORS_ORIGIN env var. */
  corsOrigins?: string[];
  /** Max login attempts per window. Defaults to LOGIN_RATE_LIMIT_MAX (20). */
  loginRateLimitMax?: number;
  /** Rate-limit window in ms. Defaults to LOGIN_RATE_LIMIT_WINDOW_MS (10 min). */
  loginRateLimitWindowMs?: number;
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
}

export function createApp(
  store: CaseStore,
  authConfig: AuthConfig,
  securityConfig: SecurityConfig = {},
  deps: AppDeps = {}
) {
  const glassCatalog = deps.glassCatalog ?? createGlassCatalogProvider();
  const sourcingProvider = deps.sourcingProvider ?? createSourcingProvider();
  const pricingConfig = deps.pricingConfig ?? loadPricingConfig();
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
    return { ...c, vehicle, glass_request, glass_identification, supplier_offers, price_calculation };
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

  // All case routes require staff authentication.
  app.use("/api/v1/cases", auth);

  // --- Phase 4b: dispatch / install tracking -------------------------------
  // One status stream drives the technician view, the dispatcher map
  // monitor, and the Domino's-style client tracker.

  app.use("/api/v1/dispatch", auth);

  /** One appointment shaped for the map monitor / tech view / tracker. */
  const dispatchAppointment = async (a: Appointment) => {
    const c = await store.getCase(a.case_id);
    if (!c) return null;
    const vehicle = await store.getVehicle(c.vehicle_id);
    const glassRequest = await store.getGlassRequest(c.glass_request_id);
    return {
      id: a.id,
      case_id: a.case_id,
      case_ref: c.reference,
      lat: a.lat,
      lng: a.lng,
      status: a.status,
      tech: a.technician_id
        ? { id: a.technician_id, name: a.technician_name }
        : null,
      address: a.service_address,
      time_window: a.time_window,
      customer_name: a.customer_name,
      vehicle: vehicle
        ? { year: vehicle.year, make: vehicle.make, model: vehicle.model }
        : null,
      glass_type: glassRequest?.glass_type ?? null
    };
  };

  const dispatchDay = async (staff: StaffUser | undefined, onlyMine: boolean) => {
    await ensureDispatchDemoSeed(store);
    const date = todayDate();
    const appointments = await store.listAppointmentsByDate(date);
    const shaped = [];
    for (const a of appointments) {
      if (onlyMine && a.technician_id !== staff?.id) continue;
      const c = await store.getCase(a.case_id);
      if (!c || !canAccessChannel(staff, c.channel)) continue;
      const s = await dispatchAppointment(a);
      if (s) shaped.push(s);
    }
    return { date, appointments: shaped };
  };

  app.get("/api/v1/dispatch/today", async (req, res) => {
    // The dispatcher map is a staff view: technicians see only their own
    // jobs, via /dispatch/my-jobs.
    if (req.staff?.role === "technician") {
      return res.status(403).json({
        error: {
          code: "TECHNICIAN_USE_MY_JOBS",
          message: "Technicians see their own jobs at /api/v1/dispatch/my-jobs."
        }
      });
    }
    res.json(await dispatchDay(req.staff, false));
  });

  app.get("/api/v1/dispatch/my-jobs", async (req, res) => {
    res.json(await dispatchDay(req.staff, true));
  });

  /**
   * Client tracking link: mints a read-only, expiring token the customer
   * can open without a staff login (Domino's-style tracker). Tokens are
   * never consumed — the client polls while the job runs.
   */
  app.post("/api/v1/cases/:caseId/tracking-link", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }
    if (req.staff?.role === "technician") {
      const appt = await store.getAppointmentByCaseId(c.id);
      if (!appt || appt.technician_id !== req.staff.id) {
        return res.status(403).json({
          error: {
            code: "NOT_YOUR_JOB",
            message: "Technicians can only share tracking for their own jobs."
          }
        });
      }
    }
    const minted = await mintApprovalToken(store, {
      caseId: c.id,
      channel: c.channel,
      purpose: "job-tracking",
      ttlSeconds: 7 * 24 * 60 * 60
    });
    res.json({
      tracking_token: minted.token,
      tracking_url: `/?track=${minted.token}`,
      expires_at: minted.expiresAt
    });
  });

  /**
   * Public client tracker. No auth: the token is the credential.
   * Returns only what the customer may see — never economics, supplier
   * info, or other customers' data.
   */
  app.get("/api/v1/track/:token", async (req, res) => {
    const grant = await verifyApprovalToken(store, req.params.token, "job-tracking");
    const c = grant ? await store.getCase(grant.caseId) : null;
    const appt = c ? await store.getAppointmentByCaseId(c.id) : null;
    if (!grant || !c || !appt) {
      return res.status(404).json({
        error: {
          code: "TRACKING_NOT_FOUND",
          message: "This tracking link is invalid or expired."
        }
      });
    }
    const vehicle = await store.getVehicle(c.vehicle_id);
    const glassRequest = await store.getGlassRequest(c.glass_request_id);
    const events = await store.getEvents(c.id);
    const at = (type: string) =>
      events.find(e => e.event_type === type)?.occurred_at ?? null;
    res.json({
      case_ref: c.reference,
      vehicle: vehicle
        ? { year: vehicle.year, make: vehicle.make, model: vehicle.model }
        : null,
      glass_type: glassRequest?.glass_type ?? null,
      customer_name: appt.customer_name,
      address: appt.service_address,
      time_window: appt.time_window,
      tech_name: appt.technician_name,
      status: appt.status,
      timeline: [
        { stage: "confirmed", at: at("CASE_CREATED") },
        { stage: "en_route", at: at("TECH_EN_ROUTE") },
        { stage: "arrived", at: at("TECH_ARRIVED") },
        { stage: "done", at: at("JOB_COMPLETE") }
      ]
    });
  });

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

  app.post("/api/v1/cases/:caseId/actions", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c || !canAccessChannel(req.staff, c.channel)) {
      return channelNotFound(res);
    }

    const staffActor = { type: "RNR_STAFF", id: req.staff?.id ?? null };
    const action = String(req.body?.action ?? "");

    try {
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
        case "tech_en_route":
        case "tech_arrived":
        case "tech_complete": {
          // Phase 4b: one status tap updates the tech view, the dispatcher
          // map, and the client tracker. Illegal transitions are 409s;
          // technicians can only move their own jobs (403 otherwise) while
          // other staff may advance on a tech's behalf.
          const appointment = await advanceTracking(
            store,
            c.id,
            action as TrackingAction,
            req.staff
          );
          const updated = await store.getCase(c.id);
          const d = await detail(updated!);
          return res.json({ ...d, appointment });
        }
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
      if (error instanceof DispatchError) {
        return res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message }
        });
      }
      throw error;
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
