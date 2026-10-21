import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request, { type Test } from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mintApprovalToken } from "../src/approval-tokens.js";
import { MockAssetStorage } from "../src/asset-storage.js";
import { hashPassword, signToken } from "../src/auth.js";
import { MockCalendarProvider } from "../src/google-calendar.js";
import { JsonCaseStore } from "../src/store.js";
import type { AvailabilityWindow } from "../src/types.js";

const TEST_SECRET = "slice-c-test-secret";

const MONDAY_WINDOW: AvailabilityWindow[] = [
  { day_of_week: 1, start: "08:00", end: "17:00" }
];
// Monday 2026-10-26, 10:00–12:00 America/New_York (EDT, UTC-4).
const JOB_START = "2026-10-26T14:00:00.000Z";
const JOB_END = "2026-10-26T16:00:00.000Z";
const JOB_DAY = "2026-10-26";

// The job site (Boston) and a tech position (Cambridge) — distinctive
// values so a coordinate leak into a client payload is easy to spot.
const SITE = { lat: 42.3601, lon: -71.0589 };
const TECH_POS = { lat: 42.373611, lon: -71.109722 };

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-slice-c-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const staff = await store.createStaffUser({
    email: "staff@example.com",
    name: "Test Staff",
    role: "staff",
    passwordHash: await hashPassword("staff-password")
  });
  const storage = new MockAssetStorage(TEST_SECRET, "/api/v1");
  const app = createApp(
    store,
    { authSecret: TEST_SECRET },
    {},
    { assetStorage: storage, calendarProvider: new MockCalendarProvider() }
  );
  return { app, store, storage, staff };
}

async function login(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string
) {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password })
    .expect(200);
  return res.body.token as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function makeTech(
  store: JsonCaseStore,
  opts: { email: string; name: string; consent?: boolean }
) {
  const user = await store.createStaffUser({
    email: opts.email,
    name: opts.name,
    role: "tech",
    passwordHash: null
  });
  await store.createTechProfile({ userId: user.id });
  await store.updateTechProfile(user.id, {
    status: "ACTIVE",
    qualifications: ["WINDSHIELD"],
    claimed_qualifications: ["WINDSHIELD"],
    availability: MONDAY_WINDOW,
    live_status: "AVAILABLE",
    location_sharing_consent: opts.consent ?? true
  });
  const token = signToken(user, TEST_SECRET, 3600);
  return { user, token };
}

/** A DIRECT case at PARTS_ORDERED; with an intake event when asked. */
async function caseAtPartsOrdered(
  store: JsonCaseStore,
  opts: { withAddress?: boolean } = {}
) {
  const { caseRecord } = await store.createCase({
    channel: "DIRECT",
    vehicle: { year: 2020, make: "Honda", model: "Accord", vin: "1HGCV1F30LA000001" },
    glass_type: "WINDSHIELD"
  });
  if (opts.withAddress) {
    await store.appendEvent({
      caseId: caseRecord.id,
      eventType: "CLIENT_INTAKE_SUBMITTED",
      actor: { type: "CUSTOMER", id: null },
      payload: {
        customer_name: "Casey Client",
        customer_phone: "6175550123",
        service_address: {
          place_id: "test-place-1",
          formatted: "118 Terrace St, Boston, MA 02120",
          street: "118 Terrace St",
          city: "Boston",
          state: "MA",
          zip: "02120",
          lat: SITE.lat,
          lon: SITE.lon
        }
      }
    });
  }
  await store.appendEvent({
    caseId: caseRecord.id,
    eventType: "PARTS_ORDERED",
    actor: { type: "RNR_STAFF", id: null },
    nextState: "PARTS_ORDERED",
    payload: {}
  });
  return caseRecord;
}

async function assignedJob(
  app: ReturnType<typeof createApp>,
  store: JsonCaseStore,
  staffToken: string,
  techId: string,
  opts: { withAddress?: boolean; start?: string; end?: string } = {}
) {
  const caseRecord = await caseAtPartsOrdered(store, opts);
  const res = await request(app)
    .post(`/api/v1/cases/${caseRecord.id}/assignment`)
    .set(bearer(staffToken))
    .send({
      tech_id: techId,
      scheduled_start: opts.start ?? JOB_START,
      scheduled_end: opts.end ?? JOB_END
    })
    .expect(200);
  return { caseRecord, jobId: res.body.job.id as string };
}

function postStep(
  app: ReturnType<typeof createApp>,
  token: string,
  jobId: string,
  step: string,
  payload: Record<string, unknown> = {}
): Test {
  return request(app)
    .post(`/api/v1/tech/jobs/${jobId}/steps`)
    .set(bearer(token))
    .send({ step, ...payload });
}

function postPing(
  app: ReturnType<typeof createApp>,
  token: string,
  jobId: string,
  body: Record<string, unknown> = { lat: TECH_POS.lat, lon: TECH_POS.lon }
): Test {
  return request(app)
    .post(`/api/v1/tech/jobs/${jobId}/location`)
    .set(bearer(token))
    .send(body);
}

async function uploadPhoto(
  app: ReturnType<typeof createApp>,
  token: string,
  jobId: string,
  kind: "BEFORE_PHOTO" | "AFTER_PHOTO"
) {
  const bytes = Buffer.from([1, 2, 3, 4]);
  const res = await request(app)
    .post(`/api/v1/tech/jobs/${jobId}/assets/upload-url`)
    .set(bearer(token))
    .send({
      kind,
      filename: `${kind.toLowerCase()}.jpg`,
      content_type: "image/jpeg",
      size_bytes: bytes.length
    })
    .expect(201);
  const { asset, upload } = res.body;
  await request(app)
    .put(upload.url)
    .set("Content-Type", "image/jpeg")
    .send(bytes)
    .expect(200);
  await request(app)
    .post(`/api/v1/assets/${asset.id}/confirm`)
    .set(bearer(token))
    .expect(200);
}

async function walkToFinish(
  app: ReturnType<typeof createApp>,
  token: string,
  jobId: string
) {
  for (const step of ["PICKUP", "PICKED_UP", "EN_ROUTE", "ARRIVED", "CHECKED_IN"]) {
    await postStep(app, token, jobId, step).expect(200);
  }
  await uploadPhoto(app, token, jobId, "BEFORE_PHOTO");
  await postStep(app, token, jobId, "BEFORE_PHOTOS").expect(200);
  for (const step of ["PREP_STARTED", "PREP_DONE", "INSTALL_STARTED", "INSTALL_DONE"]) {
    await postStep(app, token, jobId, step).expect(200);
  }
  await uploadPhoto(app, token, jobId, "AFTER_PHOTO");
  await postStep(app, token, jobId, "AFTER_PHOTOS").expect(200);
  await postStep(app, token, jobId, "CLIENT_CHECKIN", {
    client_name: "Casey Client"
  }).expect(200);
  await postStep(app, token, jobId, "FINISHED").expect(200);
}

describe("Location ping ingestion (Slice C)", () => {
  it("accepts pings from the assigned tech while the job is in progress", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { jobId } = await assignedJob(app, store, staffToken, tech.user.id);
    await postStep(app, tech.token, jobId, "PICKUP").expect(200);

    const res = await postPing(app, tech.token, jobId, {
      lat: TECH_POS.lat,
      lon: TECH_POS.lon,
      accuracy_m: 12
    }).expect(201);
    expect(res.body.ping.lat).toBe(TECH_POS.lat);
    expect(res.body.ping.lon).toBe(TECH_POS.lon);
    expect(res.body.ping.accuracy_m).toBe(12);
    expect(res.body.ping.tech_id).toBe(tech.user.id);

    const stored = await store.listJobLocationPings(jobId);
    expect(stored).toHaveLength(1);
  });

  it("rejects pings before the job starts and after it finishes", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { jobId } = await assignedJob(app, store, staffToken, tech.user.id);

    // ASSIGNED but not started: nothing is collected before start.
    const early = await postPing(app, tech.token, jobId).expect(409);
    expect(early.body.error.code).toBe("JOB_NOT_ACTIVE");

    await walkToFinish(app, tech.token, jobId);

    // Finished: sharing stopped with the job.
    const late = await postPing(app, tech.token, jobId).expect(409);
    expect(late.body.error.code).toBe("JOB_NOT_ACTIVE");
    expect(await store.listJobLocationPings(jobId)).toHaveLength(0);
  });

  it("rejects other techs (404), staff (403), and invalid coordinates (422)", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const techA = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const techB = await makeTech(store, { email: "b@gmail.com", name: "Tech B" });
    const { jobId } = await assignedJob(app, store, staffToken, techA.user.id);
    await postStep(app, techA.token, jobId, "PICKUP").expect(200);

    // Another tech cannot even confirm the job exists.
    await postPing(app, techB.token, jobId).expect(404);
    // The tech surface is tech-role only.
    await postPing(app, staffToken, jobId).expect(403);
    // Out-of-range coordinates are refused.
    const bad = await postPing(app, techA.token, jobId, { lat: 91, lon: 0 }).expect(422);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    await postPing(app, techA.token, jobId, { lat: "north", lon: 0 }).expect(422);
  });

  it("requires location-sharing consent, and revocation stops ingestion at once", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, {
      email: "a@gmail.com",
      name: "Tech A",
      consent: false
    });
    const { jobId } = await assignedJob(app, store, staffToken, tech.user.id);
    await postStep(app, tech.token, jobId, "PICKUP").expect(200);

    const refused = await postPing(app, tech.token, jobId).expect(403);
    expect(refused.body.error.code).toBe("LOCATION_CONSENT_REQUIRED");

    await store.updateTechProfile(tech.user.id, { location_sharing_consent: true });
    await postPing(app, tech.token, jobId).expect(201);

    // Revoke mid-job: the very next report is refused, nothing recorded.
    await store.updateTechProfile(tech.user.id, { location_sharing_consent: false });
    await postPing(app, tech.token, jobId).expect(403);
    expect(await store.listJobLocationPings(jobId)).toHaveLength(1);
  });

  it("keeps pings out of the case event log", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { caseRecord, jobId } = await assignedJob(app, store, staffToken, tech.user.id);
    await postStep(app, tech.token, jobId, "PICKUP").expect(200);

    const before = (await store.getEvents(caseRecord.id)).length;
    await postPing(app, tech.token, jobId).expect(201);
    await postPing(app, tech.token, jobId).expect(201);
    const events = await store.getEvents(caseRecord.id);
    expect(events).toHaveLength(before);
    expect(JSON.stringify(events)).not.toContain("LOCATION");
  });
});

describe("Staff ops map (Slice C)", () => {
  it("shows today's job pins, the tech's latest position, and the current step", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { jobId } = await assignedJob(app, store, staffToken, tech.user.id, {
      withAddress: true
    });
    // A second job the same day (later window — one tech can't hold two
    // overlapping jobs), with no intake address at all.
    const bare = await assignedJob(app, store, staffToken, tech.user.id, {
      start: "2026-10-26T17:00:00.000Z",
      end: "2026-10-26T19:00:00.000Z"
    });

    await postStep(app, tech.token, jobId, "PICKUP").expect(200);
    await postStep(app, tech.token, jobId, "PICKED_UP").expect(200);
    await postStep(app, tech.token, jobId, "EN_ROUTE").expect(200);
    await postPing(app, tech.token, jobId, { lat: 42.4, lon: -71.1 }).expect(201);
    await postPing(app, tech.token, jobId).expect(201);

    const res = await request(app)
      .get(`/api/v1/ops-map?date=${JOB_DAY}`)
      .set(bearer(staffToken))
      .expect(200);
    expect(res.body.jobs).toHaveLength(2);

    const job = res.body.jobs.find((j: any) => j.job_id === jobId);
    expect(job.service_lat).toBe(SITE.lat);
    expect(job.service_lon).toBe(SITE.lon);
    expect(job.service_address).toContain("Terrace St");
    expect(job.tech_name).toBe("Tech A");
    // EN_ROUTE is done; the tech is currently on ARRIVED.
    expect(job.current_step).toBe("ARRIVED");

    const bareJob = res.body.jobs.find((j: any) => j.job_id === bare.jobId);
    expect(bareJob.service_lat).toBeNull();
    expect(bareJob.service_lon).toBeNull();

    // Latest ping wins; the older one is history.
    expect(res.body.techs).toHaveLength(1);
    expect(res.body.techs[0].lat).toBe(TECH_POS.lat);
    expect(res.body.techs[0].lon).toBe(TECH_POS.lon);
    expect(res.body.techs[0].job_id).toBe(jobId);
    expect(res.body.techs[0].age_seconds).toBeGreaterThanOrEqual(0);
    expect(res.body.techs[0].age_seconds).toBeLessThan(60);
  });

  it("shows no tech position before the first ping — never a fabricated one", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { jobId } = await assignedJob(app, store, staffToken, tech.user.id, {
      withAddress: true
    });
    await postStep(app, tech.token, jobId, "PICKUP").expect(200);

    const res = await request(app)
      .get(`/api/v1/ops-map?date=${JOB_DAY}`)
      .set(bearer(staffToken))
      .expect(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.techs).toHaveLength(0);
  });

  it("is staff-only and honors channel scoping", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    await assignedJob(app, store, staffToken, tech.user.id, { withAddress: true });

    await request(app).get("/api/v1/ops-map").set(bearer(tech.token)).expect(403);
    await request(app).get("/api/v1/ops-map").expect(401);

    // A staff member scoped away from DIRECT sees an empty map.
    await store.createStaffUser({
      email: "insurance@example.com",
      name: "Insurance Only",
      role: "staff",
      passwordHash: await hashPassword("insurance-password"),
      channels: ["INSURANCE"]
    });
    const scopedToken = await login(app, "insurance@example.com", "insurance-password");
    const res = await request(app)
      .get(`/api/v1/ops-map?date=${JOB_DAY}`)
      .set(bearer(scopedToken))
      .expect(200);
    expect(res.body.jobs).toHaveLength(0);
    expect(res.body.techs).toHaveLength(0);
  });
});

describe("Client tracker ETA (Slice C)", () => {
  async function trackingToken(store: JsonCaseStore, caseId: string) {
    const grant = await mintApprovalToken(store, {
      caseId,
      channel: "DIRECT",
      purpose: "case-view",
      ttlSeconds: 3600
    });
    return grant.token;
  }

  function expectNoCoordinates(payload: unknown) {
    const text = JSON.stringify(payload);
    expect(text).not.toContain(String(TECH_POS.lat));
    expect(text).not.toContain(String(TECH_POS.lon));
    expect(text).not.toContain(String(SITE.lat));
    expect(text).not.toContain(String(SITE.lon));
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(payload);
    for (const key of keys) {
      expect(key).not.toMatch(/lat|lon|lng|coord|accur/i);
    }
  }

  it("shows an ETA while the tech is en route — and leaks no coordinates", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { caseRecord, jobId } = await assignedJob(app, store, staffToken, tech.user.id, {
      withAddress: true
    });
    const token = await trackingToken(store, caseRecord.id);

    await postStep(app, tech.token, jobId, "PICKUP").expect(200);
    await postStep(app, tech.token, jobId, "PICKED_UP").expect(200);

    // Not en route yet: a ping exists but there is no ETA to show.
    await postPing(app, tech.token, jobId).expect(201);
    const early = await request(app).get(`/api/v1/public/track/${token}`).expect(200);
    expect(early.body.eta).toBeNull();
    expectNoCoordinates(early.body);

    await postStep(app, tech.token, jobId, "EN_ROUTE").expect(200);
    await postPing(app, tech.token, jobId).expect(201);

    const enRoute = await request(app).get(`/api/v1/public/track/${token}`).expect(200);
    expect(enRoute.body.eta).not.toBeNull();
    expect(enRoute.body.eta.label).toMatch(/^about \d+–\d+ min$/);
    expect(enRoute.body.eta.minutes_low).toBeGreaterThanOrEqual(5);
    expect(enRoute.body.eta.minutes_high).toBeGreaterThan(enRoute.body.eta.minutes_low);
    expectNoCoordinates(enRoute.body);

    // Arrived: the tracker says "arrived"; an ETA would be invented precision.
    await postStep(app, tech.token, jobId, "ARRIVED").expect(200);
    const arrived = await request(app).get(`/api/v1/public/track/${token}`).expect(200);
    expect(arrived.body.eta).toBeNull();
    expectNoCoordinates(arrived.body);
  });

  it("shows no ETA without a ping, with a stale ping, or without job coordinates", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });

    // Case 1: en route, but the tech has never reported a position.
    const first = await assignedJob(app, store, staffToken, tech.user.id, {
      withAddress: true
    });
    const token1 = await trackingToken(store, first.caseRecord.id);
    for (const step of ["PICKUP", "PICKED_UP", "EN_ROUTE"]) {
      await postStep(app, tech.token, first.jobId, step).expect(200);
    }
    const noPing = await request(app).get(`/api/v1/public/track/${token1}`).expect(200);
    expect(noPing.body.eta).toBeNull();

    // A 30-minute-old ping is not where the tech is now: still no ETA.
    await store.appendJobLocationPing({
      jobId: first.jobId,
      caseId: first.caseRecord.id,
      techId: tech.user.id,
      lat: TECH_POS.lat,
      lon: TECH_POS.lon,
      recordedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
    });
    const stale = await request(app).get(`/api/v1/public/track/${token1}`).expect(200);
    expect(stale.body.eta).toBeNull();
    expectNoCoordinates(stale.body);

    // Case 2: fresh pings, but the case carries no service coordinates.
    // (Later window: the same tech still holds case 1's job.)
    const second = await assignedJob(app, store, staffToken, tech.user.id, {
      start: "2026-10-26T17:00:00.000Z",
      end: "2026-10-26T19:00:00.000Z"
    });
    const token2 = await trackingToken(store, second.caseRecord.id);
    for (const step of ["PICKUP", "PICKED_UP", "EN_ROUTE"]) {
      await postStep(app, tech.token, second.jobId, step).expect(200);
    }
    await postPing(app, tech.token, second.jobId).expect(201);
    const noCoords = await request(app).get(`/api/v1/public/track/${token2}`).expect(200);
    expect(noCoords.body.eta).toBeNull();
    expectNoCoordinates(noCoords.body);
  });
});
