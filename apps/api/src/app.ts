import express from "express";
import cors from "cors";
import { z } from "zod";
import type { CaseRecord, Channel, StaffUser } from "./types.js";
import type { CaseStore } from "./store.js";
import {
  ensureSeedAdmin,
  requireAuth,
  signToken,
  verifyPassword,
  type AuthConfig
} from "./auth.js";
import { createRateLimiter } from "./rate-limit.js";

const createCaseSchema = z.object({
  channel: z.enum(["DIRECT", "AUCTION", "INSURANCE"]),
  customer_id: z.string().uuid().nullable().optional(),
  vehicle: z.object({
    year: z.number().int().min(1886).max(2100),
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    vin: z.string().trim().min(1)
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

export function createApp(
  store: CaseStore,
  authConfig: AuthConfig,
  securityConfig: SecurityConfig = {}
) {
  const app = express();

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
    return { ...c, vehicle, glass_request };
  };

  app.get("/health", async (_req, res) => {
    await store.health();
    res.json({
      ok: true,
      storage: process.env.DATABASE_URL ? "postgres" : "json"
    });
  });

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

    return res.status(result.reused ? 200 : 201).json(await detail(result.caseRecord));
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

    return res.status(409).json({
      error: {
        code: "ACTION_NOT_ALLOWED",
        message: `Action ${String(req.body?.action ?? "") || "(missing)"} is not implemented in Case Core v0.1.`
      }
    });
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
