import express from "express";
import cors from "cors";
import { z } from "zod";
import type { CaseRecord } from "./types.js";
import { JsonCaseStore } from "./store.js";

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

export function createApp(store: JsonCaseStore) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const detail = (c: CaseRecord) => {
    const vehicle = store.getVehicle(c.vehicle_id);
    const glass_request = store.getGlassRequest(c.glass_request_id);
    return { ...c, vehicle, glass_request };
  };

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/v1/cases", (req, res) => {
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
    const result = store.createCase({
      channel: parsed.data.channel,
      customer_id: parsed.data.customer_id,
      vehicle: parsed.data.vehicle,
      glass_type: parsed.data.glass_request.glass_type,
      idempotencyKey
    });

    return res.status(result.reused ? 200 : 201).json(detail(result.caseRecord));
  });

  app.get("/api/v1/cases", (_req, res) => {
    res.json(store.listCases().map(detail));
  });

  app.get("/api/v1/cases/:caseId", (req, res) => {
    const c = store.getCase(req.params.caseId);
    if (!c) {
      return res.status(404).json({
        error: { code: "CASE_NOT_FOUND", message: "Case not found." }
      });
    }
    res.json(detail(c));
  });

  app.get("/api/v1/cases/:caseId/events", (req, res) => {
    const c = store.getCase(req.params.caseId);
    if (!c) {
      return res.status(404).json({
        error: { code: "CASE_NOT_FOUND", message: "Case not found." }
      });
    }
    res.json(store.getEvents(c.id));
  });

  app.post("/api/v1/cases/:caseId/actions", (req, res) => {
    const c = store.getCase(req.params.caseId);
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

  return app;
}
