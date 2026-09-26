import express from "express";
import cors from "cors";
import { z } from "zod";
import type { CaseRecord } from "./types.js";
import type { CaseStore } from "./store.js";

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

export function createApp(store: CaseStore) {
  const app = express();
  app.use(cors());
  app.use(express.json());

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

    const idempotencyKey = req.header("Idempotency-Key") || undefined;
    const result = await store.createCase({
      channel: parsed.data.channel,
      customer_id: parsed.data.customer_id,
      vehicle: parsed.data.vehicle,
      glass_type: parsed.data.glass_request.glass_type,
      idempotencyKey
    });

    return res.status(result.reused ? 200 : 201).json(await detail(result.caseRecord));
  });

  app.get("/api/v1/cases", async (_req, res) => {
    const cases = await store.listCases();
    res.json(await Promise.all(cases.map(detail)));
  });

  app.get("/api/v1/cases/:caseId", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c) {
      return res.status(404).json({
        error: { code: "CASE_NOT_FOUND", message: "Case not found." }
      });
    }
    res.json(await detail(c));
  });

  app.get("/api/v1/cases/:caseId/events", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c) {
      return res.status(404).json({
        error: { code: "CASE_NOT_FOUND", message: "Case not found." }
      });
    }
    res.json(await store.getEvents(c.id));
  });

  app.post("/api/v1/cases/:caseId/actions", async (req, res) => {
    const c = await store.getCase(req.params.caseId);
    if (!c) {
      return res.status(404).json({
        error: { code: "CASE_NOT_FOUND", message: "Case not found." }
      });
    }

    return res.status(409).json({
      error: {
        code: "ACTION_NOT_ALLOWED",
        message: `Action ${String(req.body?.action ?? "") || "(missing)"} is not implemented in Case Core v0.1.`
      }
    });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
