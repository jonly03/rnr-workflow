import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";
import { MockSourcingProvider } from "../src/sourcing.js";
import { JsonCaseStore } from "../src/store.js";
import type { GlassType } from "../src/types.js";

const TEST_AUTH_SECRET = "test-secret-for-override-tests";
const VIN_17 = "1HGCM82633A004352";

const PRICING = {
  labor_cents: 12500,
  target_profit_cents: 25000,
  tax_rate: 0.0625
};

interface Fixture {
  app: ReturnType<typeof createApp>;
  store: JsonCaseStore;
  token: string;
  createCase: (overrides?: {
    model?: string;
    make?: string;
    glassType?: GlassType;
    vin?: string;
  }) => request.Test;
}

async function fixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-override-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("password123")
  });
  const app = createApp(
    store,
    { authSecret: TEST_AUTH_SECRET },
    {},
    {
      glassCatalog: new MockGlassCatalogProvider(),
      sourcingProvider: new MockSourcingProvider(),
      pricingConfig: PRICING
    }
  );

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "staff@example.com", password: "password123" })
    .expect(200);
  const token = login.body.token as string;

  const createCase = (overrides: { model?: string; make?: string; glassType?: GlassType; vin?: string } = {}) =>
    request(app)
      .post("/api/v1/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        channel: "DIRECT",
        vehicle: {
          year: 2020,
          make: overrides.make ?? "Honda",
          model: overrides.model ?? "Ambiguous",
          vin: overrides.vin ?? VIN_17
        },
        // Door glass is not VIN-eligible, so the ambiguous mock candidates
        // route to human review; staff picks one and the chain auto-runs.
        glass_request: { glass_type: overrides.glassType ?? "DOOR_GLASS" }
      });

  return { app, store, token, createCase };
}

const act = (f: Fixture, caseId: string, action: string, body: Record<string, unknown> = {}) =>
  request(f.app)
    .post(`/api/v1/cases/${caseId}/actions`)
    .set("Authorization", `Bearer ${f.token}`)
    .send({ action, ...body });

const getCase = (f: Fixture, caseId: string) =>
  request(f.app)
    .get(`/api/v1/cases/${caseId}`)
    .set("Authorization", `Bearer ${f.token}`);

const getEvents = (f: Fixture, caseId: string) =>
  request(f.app)
    .get(`/api/v1/cases/${caseId}/events`)
    .set("Authorization", `Bearer ${f.token}`);

/** Creates a case and drives it to PRICE_APPROVED via human candidate selection. */
async function approvedCase(f: Fixture): Promise<{ caseId: string; created: request.Response }> {
  const created = await f.createCase().expect(201);
  const caseId = created.body.id as string;
  expect(created.body.current_state).toBe("HUMAN_GLASS_REVIEW_REQUIRED");

  const ident = created.body.glass_identification;
  expect(ident.candidates.length).toBeGreaterThan(1);

  // Staff resolves the ambiguity by picking the first candidate.
  await act(f, caseId, "select_glass_candidate", {
    part_number: ident.candidates[0].part_number
  }).expect(200);

  const priced = await getCase(f, caseId).expect(200);
  expect(priced.body.current_state).toBe("PRICE_APPROVED");
  return { caseId, created: priced };
}

describe("Staff overrides (editable cards)", () => {
  describe("override_glass_candidate", () => {
    it("swaps the part, re-runs sourcing + pricing, and records the audit event", async () => {
      const f = await fixture();
      const { caseId, created } = await approvedCase(f);

      const ident = created.body.glass_identification;
      const oldPart = ident.selected_candidate.part_number as string;
      const newCandidate = ident.candidates.find(
        (c: any) => c.part_number !== oldPart
      );
      expect(newCandidate).toBeDefined();

      await act(f, caseId, "override_glass_candidate", {
        part_number: newCandidate.part_number
      }).expect(200);

      const updated = await getCase(f, caseId).expect(200);
      // Downstream re-ran: new part selected, offers re-sourced, price recalculated.
      expect(updated.body.glass_identification.selected_candidate.part_number).toBe(
        newCandidate.part_number
      );
      expect(updated.body.current_state).toBe("PRICE_APPROVED");
      const offers = updated.body.supplier_offers as any[];
      expect(offers.every((o: any) => o.part_number === newCandidate.part_number)).toBe(true);

      const events = await getEvents(f, caseId).expect(200);
      const override = (events.body as any[]).find(
        e => e.event_type === "GLASS_CANDIDATE_OVERRIDDEN"
      );
      expect(override).toBeDefined();
      expect(override.payload.old_part_number).toBe(oldPart);
      expect(override.payload.new_part_number).toBe(newCandidate.part_number);
      expect(override.actor_type).toBe("RNR_STAFF");
    });

    it("rejects a part number that is not a candidate", async () => {
      const f = await fixture();
      const { caseId } = await approvedCase(f);
      const res = await act(f, caseId, "override_glass_candidate", {
        part_number: "NOT-A-REAL-PART"
      }).expect(422);
      expect(res.body.error.code).toBe("INVALID_CANDIDATE");
    });

    it("rejects overriding to the already-selected part", async () => {
      const f = await fixture();
      const { caseId, created } = await approvedCase(f);
      const selected = created.body.glass_identification.selected_candidate.part_number;
      const res = await act(f, caseId, "override_glass_candidate", {
        part_number: selected
      }).expect(422);
      expect(res.body.error.code).toBe("INVALID_CANDIDATE");
    });

    it("requires part_number", async () => {
      const f = await fixture();
      const { caseId } = await approvedCase(f);
      await act(f, caseId, "override_glass_candidate", {}).expect(422);
    });
  });

  describe("override_supplier_offer", () => {
    it("swaps the supplier, re-runs pricing, and records the audit event", async () => {
      const f = await fixture();
      const { caseId, created } = await approvedCase(f);

      const offers = created.body.supplier_offers as any[];
      const current = offers.find((o: any) => o.selected);
      const replacement = offers.find(
        (o: any) => !o.selected && !o.excluded_reason
      );
      expect(replacement).toBeDefined();

      const oldCalc = created.body.price_calculation;

      await act(f, caseId, "override_supplier_offer", {
        offer_id: replacement.id
      }).expect(200);

      const updated = await getCase(f, caseId).expect(200);
      const newSelected = (updated.body.supplier_offers as any[]).find(
        (o: any) => o.selected
      );
      expect(newSelected.id).toBe(replacement.id);
      expect(updated.body.current_state).toBe("PRICE_APPROVED");
      // Pricing re-ran against the new offer's cost.
      expect(updated.body.price_calculation.glass_cost_cents).toBe(
        replacement.price_cents
      );
      expect(updated.body.price_calculation.id).not.toBe(oldCalc.id);

      const events = await getEvents(f, caseId).expect(200);
      const override = (events.body as any[]).find(
        e => e.event_type === "SUPPLIER_OFFER_OVERRIDDEN"
      );
      expect(override).toBeDefined();
      expect(override.payload.old_supplier_name).toBe(current.supplier_name);
      expect(override.payload.new_supplier_name).toBe(replacement.supplier_name);
      expect(override.actor_type).toBe("RNR_STAFF");
    });

    it("rejects an excluded offer", async () => {
      const f = await fixture();
      const { caseId, created } = await approvedCase(f);
      const offers = created.body.supplier_offers as any[];
      const excluded = offers.find((o: any) => o.excluded_reason);
      expect(excluded).toBeDefined();
      const res = await act(f, caseId, "override_supplier_offer", {
        offer_id: excluded.id
      }).expect(422);
      expect(res.body.error.code).toBe("INVALID_OFFER");
    });

    it("rejects an unknown offer id", async () => {
      const f = await fixture();
      const { caseId } = await approvedCase(f);
      const res = await act(f, caseId, "override_supplier_offer", {
        offer_id: "no-such-offer"
      }).expect(422);
      expect(res.body.error.code).toBe("INVALID_OFFER");
    });

    it("rejects the already-selected offer", async () => {
      const f = await fixture();
      const { caseId, created } = await approvedCase(f);
      const offers = created.body.supplier_offers as any[];
      const current = offers.find((o: any) => o.selected);
      const res = await act(f, caseId, "override_supplier_offer", {
        offer_id: current.id
      }).expect(422);
      expect(res.body.error.code).toBe("INVALID_OFFER");
    });

    it("requires offer_id", async () => {
      const f = await fixture();
      const { caseId } = await approvedCase(f);
      await act(f, caseId, "override_supplier_offer", {}).expect(422);
    });
  });
});
