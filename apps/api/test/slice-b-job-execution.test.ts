import { createHmac } from "node:crypto";
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

const TEST_SECRET = ["slice-b", "test", "secret"].join("-");

const MONDAY_WINDOW: AvailabilityWindow[] = [
  { day_of_week: 1, start: "08:00", end: "17:00" }
];
// Monday 2026-10-26, 10:00–12:00 America/New_York (EDT, UTC-4).
const JOB_START = "2026-10-26T14:00:00.000Z";
const JOB_END = "2026-10-26T16:00:00.000Z";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-slice-b-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const admin = await store.createStaffUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    passwordHash: await hashPassword("admin-password")
  });
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
  return { app, store, storage, admin, staff };
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
  opts: { email: string; name: string; qualifications?: string[] }
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
    qualifications: opts.qualifications ?? ["WINDSHIELD"],
    claimed_qualifications: opts.qualifications ?? ["WINDSHIELD"],
    availability: MONDAY_WINDOW,
    live_status: "AVAILABLE"
  });
  const token = signToken(user, TEST_SECRET, 3600);
  return { user, token };
}

async function caseAtPartsOrdered(store: JsonCaseStore) {
  const { caseRecord } = await store.createCase({
    channel: "DIRECT",
    vehicle: { year: 2020, make: "Honda", model: "Accord", vin: "1HGCV1F30LA000001" },
    glass_type: "WINDSHIELD"
  });
  await store.appendEvent({
    caseId: caseRecord.id,
    eventType: "PARTS_ORDERED",
    actor: { type: "RNR_STAFF", id: null },
    nextState: "PARTS_ORDERED",
    payload: {}
  });
  return caseRecord;
}

/** Creates a case, assigns it to the tech, returns { caseRecord, jobId }. */
async function assignedJob(
  app: ReturnType<typeof createApp>,
  store: JsonCaseStore,
  staffToken: string,
  techId: string
) {
  const caseRecord = await caseAtPartsOrdered(store);
  const res = await request(app)
    .post(`/api/v1/cases/${caseRecord.id}/assignment`)
    .set(bearer(staffToken))
    .send({ tech_id: techId, scheduled_start: JOB_START, scheduled_end: JOB_END })
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

/** Full upload round-trip against the mock storage driver. */
async function uploadPhoto(
  app: ReturnType<typeof createApp>,
  token: string,
  jobId: string,
  kind: "BEFORE_PHOTO" | "AFTER_PHOTO",
  bytes: Buffer = Buffer.from([1, 2, 3, 4])
) {
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
  const confirmed = await request(app)
    .post(`/api/v1/assets/${asset.id}/confirm`)
    .set(bearer(token))
    .expect(200);
  expect(confirmed.body.asset.status).toBe("READY");
  return confirmed.body.asset;
}

const PLAIN_STEPS = [
  "PICKUP",
  "PICKED_UP",
  "EN_ROUTE",
  "ARRIVED",
  "CHECKED_IN"
] as const;

describe("Tech job checklist (Slice B)", () => {
  it("lists only the caller's jobs and 404s another tech's job", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const techA = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const techB = await makeTech(store, { email: "b@gmail.com", name: "Tech B" });
    const { jobId } = await assignedJob(app, store, staffToken, techA.user.id);
    await assignedJob(app, store, staffToken, techB.user.id);

    const mine = await request(app)
      .get("/api/v1/tech/jobs")
      .set(bearer(techA.token))
      .expect(200);
    expect(mine.body.jobs).toHaveLength(1);
    expect(mine.body.jobs[0].job.id).toBe(jobId);
    expect(mine.body.jobs[0].case.reference).toBeTruthy();
    expect(mine.body.jobs[0].current_step).toBe("PICKUP");

    // Another tech's job does not exist as far as tech A can tell.
    const other = await request(app)
      .get(`/api/v1/tech/jobs/${mine.body.jobs[0].job.id}`)
      .set(bearer(techB.token))
      .expect(404);
    expect(other.body.error.code).toBe("JOB_NOT_FOUND");

    // Staff identities never enter the tech surface.
    await request(app).get("/api/v1/tech/jobs").set(bearer(staffToken)).expect(403);
  });

  it("enforces step order and drives the case state from the tech's taps", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { caseRecord, jobId } = await assignedJob(app, store, staffToken, tech.user.id);

    // Skipping ahead is refused, naming the expected step.
    const skip = await postStep(app, tech.token, jobId, "ARRIVED").expect(409);
    expect(skip.body.error.code).toBe("STEP_OUT_OF_ORDER");
    expect(skip.body.error.message).toMatch(/pick up/i);

    // Another tech cannot advance the job at all.
    const other = await makeTech(store, { email: "b@gmail.com", name: "Tech B" });
    await postStep(app, other.token, jobId, "PICKUP").expect(404);

    // First tap: job starts; the case rides dispatch → start_service.
    const started = await postStep(app, tech.token, jobId, "PICKUP").expect(200);
    expect(started.body.job.job.status).toBe("IN_PROGRESS");
    expect(started.body.job.current_step).toBe("PICKED_UP");
    const afterStart = await store.getCase(caseRecord.id);
    expect(afterStart?.current_state).toBe("INSTALLATION_IN_PROGRESS");
    const eventTypes = (await store.getEvents(caseRecord.id)).map(e => e.event_type);
    expect(eventTypes).toContain("TECH_DISPATCHED");
    expect(eventTypes).toContain("SERVICE_STARTED");

    // Repeating a completed step is out of order too.
    await postStep(app, tech.token, jobId, "PICKUP").expect(409);
  });

  it("gates photo steps on confirmed uploads and finishes into SERVICE_COMPLETED", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { caseRecord, jobId } = await assignedJob(app, store, staffToken, tech.user.id);

    for (const step of PLAIN_STEPS) {
      await postStep(app, tech.token, jobId, step).expect(200);
    }

    // The before-photos step refuses until a photo is confirmed.
    const gated = await postStep(app, tech.token, jobId, "BEFORE_PHOTOS").expect(422);
    expect(gated.body.error.code).toBe("PHOTOS_REQUIRED");
    await uploadPhoto(app, tech.token, jobId, "BEFORE_PHOTO");
    await postStep(app, tech.token, jobId, "BEFORE_PHOTOS").expect(200);

    for (const step of ["PREP_STARTED", "PREP_DONE", "INSTALL_STARTED", "INSTALL_DONE"]) {
      await postStep(app, tech.token, jobId, step).expect(200);
    }

    const gatedAfter = await postStep(app, tech.token, jobId, "AFTER_PHOTOS").expect(422);
    expect(gatedAfter.body.error.code).toBe("PHOTOS_REQUIRED");
    await uploadPhoto(app, tech.token, jobId, "AFTER_PHOTO");
    await postStep(app, tech.token, jobId, "AFTER_PHOTOS").expect(200);

    // Client check-in needs the confirming client's name.
    const noName = await postStep(app, tech.token, jobId, "CLIENT_CHECKIN").expect(422);
    expect(noName.body.error.code).toBe("VALIDATION_ERROR");
    await postStep(app, tech.token, jobId, "CLIENT_CHECKIN", {
      client_name: "Jamie Client"
    }).expect(200);

    const finished = await postStep(app, tech.token, jobId, "FINISHED").expect(200);
    expect(finished.body.job.job.status).toBe("COMPLETED");
    expect(finished.body.job.current_step).toBeNull();
    const done = await store.getCase(caseRecord.id);
    expect(done?.current_state).toBe("SERVICE_COMPLETED");
    const eventTypes = (await store.getEvents(caseRecord.id)).map(e => e.event_type);
    expect(eventTypes).toContain("SERVICE_COMPLETED");

    // A finished job takes no more steps.
    await postStep(app, tech.token, jobId, "FINISHED").expect(409);
  });

  it("staff watch progress read-only via the case job view", async () => {
    const { app, store } = await fixture();
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const tech = await makeTech(store, { email: "a@gmail.com", name: "Tech A" });
    const { caseRecord, jobId } = await assignedJob(app, store, staffToken, tech.user.id);
    await postStep(app, tech.token, jobId, "PICKUP").expect(200);
    await uploadPhoto(app, tech.token, jobId, "BEFORE_PHOTO");

    const view = await request(app)
      .get(`/api/v1/cases/${caseRecord.id}/job`)
      .set(bearer(staffToken))
      .expect(200);
    expect(view.body.job.status).toBe("IN_PROGRESS");
    expect(view.body.current_step).toBe("PICKED_UP");
    expect(view.body.steps.map((s: { step: string }) => s.step)).toEqual(["PICKUP"]);
    expect(view.body.assets).toHaveLength(1);
    expect(view.body.assets[0].kind).toBe("BEFORE_PHOTO");
    // The storage key is server-side only.
    expect(JSON.stringify(view.body)).not.toContain("storage_key");
    expect(JSON.stringify(view.body)).not.toContain("cases/");

    // Techs are refused the staff case surface entirely (Slice A law).
    await request(app)
      .get(`/api/v1/cases/${caseRecord.id}/job`)
      .set(bearer(tech.token))
      .expect(403);
  });
});

describe("Asset visibility law (Slice B, §7.3)", () => {
  async function stage() {
    const f = await fixture();
    const staffToken = await login(f.app, "staff@example.com", "staff-password");
    const techA = await makeTech(f.store, { email: "a@gmail.com", name: "Tech A" });
    const techB = await makeTech(f.store, { email: "b@gmail.com", name: "Tech B" });
    const { caseRecord, jobId } = await assignedJob(
      f.app,
      f.store,
      staffToken,
      techA.user.id
    );
    const beforePhoto = await uploadPhoto(f.app, techA.token, jobId, "BEFORE_PHOTO");
    // An INTERNAL asset and an invoice (economics) asset on the same case.
    const internal = await f.store.createCaseAsset({
      id: "11111111-1111-4111-8111-111111111111",
      caseId: caseRecord.id,
      jobId: null,
      kind: "OTHER",
      visibility: "INTERNAL",
      storageDriver: "mock",
      storageKey: `cases/${caseRecord.id}/internal-note.pdf`,
      filename: "internal-note.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      status: "READY",
      uploadedBy: { type: "RNR_STAFF", id: null }
    });
    await f.storage.putBytes(internal.storage_key, Buffer.from([9, 9, 9]));
    const invoice = await f.store.createCaseAsset({
      id: "22222222-2222-4222-8222-222222222222",
      caseId: caseRecord.id,
      jobId: null,
      kind: "INVOICE_PDF",
      visibility: "CLIENT_VISIBLE",
      storageDriver: "mock",
      storageKey: `cases/${caseRecord.id}/invoice.pdf`,
      filename: "invoice.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      status: "READY",
      uploadedBy: { type: "RNR_STAFF", id: null }
    });
    await f.storage.putBytes(invoice.storage_key, Buffer.from([8, 8, 8]));
    return { ...f, staffToken, techA, techB, caseRecord, jobId, beforePhoto, internal, invoice };
  }

  it("staff can list + download everything; URLs come only after the check", async () => {
    const s = await stage();
    const list = await request(s.app)
      .get(`/api/v1/cases/${s.caseRecord.id}/assets`)
      .set(bearer(s.staffToken))
      .expect(200);
    expect(list.body.assets.map((a: { kind: string }) => a.kind).sort()).toEqual([
      "BEFORE_PHOTO",
      "INVOICE_PDF",
      "OTHER"
    ]);
    const dl = await request(s.app)
      .get(`/api/v1/assets/${s.beforePhoto.id}/download-url`)
      .set(bearer(s.staffToken))
      .expect(200);
    const bytes = await request(s.app).get(dl.body.url).expect(200);
    expect(Buffer.from(bytes.body)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("the assigned tech sees job photos but never INTERNAL or economics assets", async () => {
    const s = await stage();
    // Own job photo: downloadable.
    const own = await request(s.app)
      .get(`/api/v1/assets/${s.beforePhoto.id}/download-url`)
      .set(bearer(s.techA.token))
      .expect(200);
    expect(own.body.url).toContain(s.beforePhoto.id);
    // INTERNAL: indistinguishable from nonexistent.
    await request(s.app)
      .get(`/api/v1/assets/${s.internal.id}/download-url`)
      .set(bearer(s.techA.token))
      .expect(404);
    // Invoice = economics: never for techs.
    await request(s.app)
      .get(`/api/v1/assets/${s.invoice.id}/download-url`)
      .set(bearer(s.techA.token))
      .expect(404);
    // The job detail asset list is filtered the same way.
    const detail = await request(s.app)
      .get(`/api/v1/tech/jobs/${s.jobId}`)
      .set(bearer(s.techA.token))
      .expect(200);
    expect(detail.body.job.assets.map((a: { kind: string }) => a.kind)).toEqual([
      "BEFORE_PHOTO"
    ]);
  });

  it("another tech gets nothing: no download, no confirm, no listing", async () => {
    const s = await stage();
    await request(s.app)
      .get(`/api/v1/assets/${s.beforePhoto.id}/download-url`)
      .set(bearer(s.techB.token))
      .expect(404);
    await request(s.app)
      .post(`/api/v1/assets/${s.beforePhoto.id}/confirm`)
      .set(bearer(s.techB.token))
      .expect(404);
  });

  it("rejects bad capability signatures and non-allowlisted uploads", async () => {
    const s = await stage();
    // Forged signature on the byte route.
    await request(s.app)
      .get(`/api/v1/assets/${s.beforePhoto.id}/content?exp=9999999999&sig=deadbeef`)
      .expect(403);
    // Expired signature (signed with the real secret, in the past).
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const sig = createHmac("sha256", TEST_SECRET)
      .update(`GET:${s.beforePhoto.id}:${pastExp}`)
      .digest("hex");
    await request(s.app)
      .get(`/api/v1/assets/${s.beforePhoto.id}/content?exp=${pastExp}&sig=${sig}`)
      .expect(403);
    // Upload allowlist: executables and oversize files are refused.
    await request(s.app)
      .post(`/api/v1/tech/jobs/${s.jobId}/assets/upload-url`)
      .set(bearer(s.techA.token))
      .send({
        kind: "BEFORE_PHOTO",
        filename: "evil.exe",
        content_type: "application/x-msdownload",
        size_bytes: 10
      })
      .expect(422);
    await request(s.app)
      .post(`/api/v1/tech/jobs/${s.jobId}/assets/upload-url`)
      .set(bearer(s.techA.token))
      .send({
        kind: "BEFORE_PHOTO",
        filename: "huge.jpg",
        content_type: "image/jpeg",
        size_bytes: 11 * 1024 * 1024
      })
      .expect(422);
  });

  it("confirm refuses before bytes land, and the client surface carries no assets", async () => {
    const s = await stage();
    // Register an upload but never PUT bytes: confirm must refuse.
    const res = await request(s.app)
      .post(`/api/v1/tech/jobs/${s.jobId}/assets/upload-url`)
      .set(bearer(s.techA.token))
      .send({
        kind: "AFTER_PHOTO",
        filename: "after.jpg",
        content_type: "image/jpeg",
        size_bytes: 4
      })
      .expect(201);
    await request(s.app)
      .post(`/api/v1/assets/${res.body.asset.id}/confirm`)
      .set(bearer(s.techA.token))
      .expect(409);

    // The public tracking projection never mentions assets or photos.
    const grant = await mintApprovalToken(s.store, {
      caseId: s.caseRecord.id,
      channel: "DIRECT",
      purpose: "case-view",
      ttlSeconds: 3600
    });
    const track = await request(s.app)
      .get(`/api/v1/public/track/${grant.token}`)
      .expect(200);
    const text = JSON.stringify(track.body);
    expect(text).not.toContain("BEFORE_PHOTO");
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain(s.beforePhoto.id);
  });

  it("registers intake photo metadata as registry assets with no bytes", async () => {
    const { app, store } = await fixture();
    await request(app)
      .post("/api/v1/public/intake")
      .field("customer_name", "Jamie Client")
      .field("customer_phone", "617-555-0100")
      .field("glass_type", "WINDSHIELD")
      .field("year", "2020")
      .field("make", "Honda")
      .field("model", "Accord")
      .attach("photos", Buffer.from([5, 5]), {
        filename: "crack.jpg",
        contentType: "image/jpeg"
      })
      .expect(201);
    const cases = await store.listCases();
    expect(cases).toHaveLength(1);
    const assets = await store.listCaseAssets(cases[0].id);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      kind: "INTAKE_PHOTO",
      visibility: "CLIENT_VISIBLE",
      storage_driver: "metadata",
      filename: "crack.jpg",
      status: "READY"
    });
    // No bytes exist for it: a staff download URL is a clean 409.
    const staffToken = await login(app, "staff@example.com", "staff-password");
    const dl = await request(app)
      .get(`/api/v1/assets/${assets[0].id}/download-url`)
      .set(bearer(staffToken))
      .expect(409);
    expect(dl.body.error.code).toBe("ASSET_NO_BYTES");
  });
});
