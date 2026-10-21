import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import {
  MockGoogleIdentityProvider,
  type GoogleOidcConfig
} from "../src/google-auth.js";
import { MockCalendarProvider } from "../src/google-calendar.js";
import { hashInviteCredential } from "../src/operators.js";
import { deriveRequirement, proposeAssignments } from "../src/scheduler.js";
import { JsonCaseStore } from "../src/store.js";
import type { AvailabilityWindow, GlassIdentification } from "../src/types.js";

const TEST_SECRET = "test-secret-for-slice-a";

const GOOGLE_CONFIG: GoogleOidcConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3001/api/v1/auth/google/callback",
  webOrigin: "http://localhost:5173"
};

const IDENTITIES = {
  "code-tech-a": {
    sub: "google-sub-a",
    email: "tech.a@gmail.com",
    emailVerified: true,
    name: "Tech A"
  },
  "code-stranger": {
    sub: "google-sub-stranger",
    email: "stranger@gmail.com",
    emailVerified: true,
    name: "Stranger"
  },
  "code-staff": {
    sub: "google-sub-staff",
    email: "staff@example.com",
    emailVerified: true,
    name: "Test Staff"
  }
};

const MONDAY_WINDOW: AvailabilityWindow[] = [
  { day_of_week: 1, start: "08:00", end: "17:00" }
];
// Monday 2026-10-26, 10:00–12:00 America/New_York (EDT, UTC-4).
const JOB_START = "2026-10-26T14:00:00.000Z";
const JOB_END = "2026-10-26T16:00:00.000Z";

async function fixture(options: { google?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-slice-a-"));
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
  const calendar = new MockCalendarProvider();
  const googleProvider = options.google
    ? new MockGoogleIdentityProvider(GOOGLE_CONFIG, IDENTITIES)
    : null;
  const app = createApp(
    store,
    { authSecret: TEST_SECRET },
    {},
    {
      googleConfig: options.google ? GOOGLE_CONFIG : null,
      googleProvider,
      calendarProvider: calendar
    }
  );
  return { app, store, calendar, admin, staff };
}

async function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password })
    .expect(200);
  return res.body.token as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Drives the mock Google flow: start → callback. Returns the callback response. */
async function googleCallback(
  app: ReturnType<typeof createApp>,
  opts: { invite?: string; code: string }
) {
  const start = await request(app)
    .get(
      "/api/v1/auth/google/start" +
        (opts.invite ? `?invite=${encodeURIComponent(opts.invite)}` : "")
    )
    .expect(302);
  const cookie = (start.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const state = new URL(start.headers.location).searchParams.get("state")!;
  return request(app)
    .get(
      `/api/v1/auth/google/callback?code=${encodeURIComponent(opts.code)}&state=${encodeURIComponent(state)}`
    )
    .set("Cookie", cookie)
    .expect(302);
}

function sessionFrom(location: string): string | null {
  const match = /#session=([^&]+)/.exec(location);
  return match ? decodeURIComponent(match[1]) : null;
}

function authErrorFrom(location: string): string | null {
  const match = /#auth_error=([^&]+)/.exec(location);
  return match ? decodeURIComponent(match[1]) : null;
}

async function makeTech(
  store: JsonCaseStore,
  opts: {
    email: string;
    name: string;
    qualifications?: string[];
    availability?: AvailabilityWindow[];
    status?: "PROFILE_PENDING" | "ACTIVE" | "DEACTIVATED";
    liveStatus?: "AVAILABLE" | "OFF";
  }
) {
  const user = await store.createStaffUser({
    email: opts.email,
    name: opts.name,
    role: "tech",
    passwordHash: null
  });
  await store.createTechProfile({ userId: user.id });
  const profile = await store.updateTechProfile(user.id, {
    status: opts.status ?? "ACTIVE",
    qualifications: opts.qualifications ?? [],
    claimed_qualifications: opts.qualifications ?? [],
    availability: opts.availability ?? MONDAY_WINDOW,
    live_status: opts.liveStatus ?? "AVAILABLE"
  });
  return { user, profile };
}

async function caseAtPartsOrdered(store: JsonCaseStore, glassType: "WINDSHIELD" | "DOOR_GLASS" = "WINDSHIELD") {
  const { caseRecord } = await store.createCase({
    channel: "DIRECT",
    vehicle: { year: 2020, make: "Honda", model: "Accord", vin: "1HGCV1F30LA000001" },
    glass_type: glassType
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

describe("Google Sign-In configuration gate", () => {
  it("is inert when unconfigured: config off, start 404, health flag false", async () => {
    const { app } = await fixture();
    const config = await request(app).get("/api/v1/auth/google/config").expect(200);
    expect(config.body.enabled).toBe(false);
    await request(app).get("/api/v1/auth/google/start").expect(404);
    const health = await request(app).get("/health").expect(200);
    expect(health.body.google_signin).toBe(false);
  });

  it("reports enabled when configured (mock provider, no live Google)", async () => {
    const { app } = await fixture({ google: true });
    const config = await request(app).get("/api/v1/auth/google/config").expect(200);
    expect(config.body.enabled).toBe(true);
    const health = await request(app).get("/health").expect(200);
    expect(health.body.google_signin).toBe(true);
  });

  it("signs in an existing staff account by matching Google email", async () => {
    const { app } = await fixture({ google: true });
    const cb = await googleCallback(app, { code: "code-staff" });
    const session = sessionFrom(cb.headers.location);
    expect(session).toBeTruthy();
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set(bearer(session!))
      .expect(200);
    expect(me.body.staff.email).toBe("staff@example.com");
  });

  it("refuses a Google account with no Case Core account and no invite", async () => {
    const { app, store } = await fixture({ google: true });
    const cb = await googleCallback(app, { code: "code-stranger" });
    expect(sessionFrom(cb.headers.location)).toBeNull();
    expect(authErrorFrom(cb.headers.location)).toMatch(/no Case Core account/i);
    expect(await store.findStaffByEmail("stranger@gmail.com")).toBeNull();
  });

  it("rejects a callback with a forged state", async () => {
    const { app } = await fixture({ google: true });
    const cb = await request(app)
      .get("/api/v1/auth/google/callback?code=code-staff&state=forged.state")
      .expect(302);
    expect(sessionFrom(cb.headers.location)).toBeNull();
    expect(authErrorFrom(cb.headers.location)).toMatch(/expired/i);
  });
});

describe("Operator onboarding (invite → Google → profile → verify)", () => {
  it("runs the full state machine: INVITED → PROFILE_PENDING → ACTIVE ⇄ DEACTIVATED", async () => {
    const { app, store } = await fixture({ google: true });
    const adminToken = await login(app, "admin@example.com", "admin-password");
    const staffToken = await login(app, "staff@example.com", "staff-password");

    // Staff (non-manager) cannot invite.
    await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(staffToken))
      .send({ email: "tech.a@gmail.com" })
      .expect(403);

    // INVITED.
    const inviteRes = await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(adminToken))
      .send({ email: "Tech.A@Gmail.com" })
      .expect(201);
    const credential = inviteRes.body.credential as string;
    expect(credential.startsWith("rninv_")).toBe(true);
    expect(inviteRes.body.invite_path).toBe(`/invite/${credential}`);
    // The raw credential is never stored: only its hash exists in the store.
    expect(JSON.stringify(store.snapshot())).not.toContain(credential);
    expect(JSON.stringify(store.snapshot())).toContain(hashInviteCredential(credential));

    let list = await request(app).get("/api/v1/operators").set(bearer(adminToken)).expect(200);
    expect(list.body.invites).toHaveLength(1);
    expect(list.body.invites[0]).toMatchObject({ email: "tech.a@gmail.com", status: "INVITED" });
    expect(list.body.operators).toHaveLength(0);

    // Email-match rule: a different Google account cannot claim the invite.
    const wrong = await googleCallback(app, { invite: credential, code: "code-stranger" });
    expect(sessionFrom(wrong.headers.location)).toBeNull();
    expect(authErrorFrom(wrong.headers.location)).toMatch(/different Google account/i);
    expect(await store.findStaffByEmail("tech.a@gmail.com")).toBeNull();
    expect(await store.findStaffByEmail("stranger@gmail.com")).toBeNull();
    list = await request(app).get("/api/v1/operators").set(bearer(adminToken)).expect(200);
    expect(list.body.invites).toHaveLength(1); // invite still open

    // Matching Google account → PROFILE_PENDING, invite consumed.
    const cb = await googleCallback(app, { invite: credential, code: "code-tech-a" });
    const techToken = sessionFrom(cb.headers.location);
    expect(techToken).toBeTruthy();
    const record = await store.findStaffByEmail("tech.a@gmail.com");
    expect(record?.role).toBe("tech");
    expect(record?.password_hash).toBeNull();
    const profile = await store.getTechProfile(record!.id);
    expect(profile?.status).toBe("PROFILE_PENDING");
    expect(profile?.google_sub).toBe("google-sub-a");

    list = await request(app).get("/api/v1/operators").set(bearer(adminToken)).expect(200);
    expect(list.body.invites).toHaveLength(0);
    expect(list.body.operators).toHaveLength(1);
    expect(list.body.operators[0]).toMatchObject({
      email: "tech.a@gmail.com",
      status: "PROFILE_PENDING"
    });
    // No credential material anywhere in the operators payload.
    expect(JSON.stringify(list.body)).not.toContain("google_refresh");
    expect(JSON.stringify(list.body)).not.toContain("mock-refresh");

    // The consumed invite cannot be replayed.
    const replay = await googleCallback(app, { invite: credential, code: "code-tech-a" });
    expect(sessionFrom(replay.headers.location)).toBeNull();

    // Profile completion (tech's own route) keeps PROFILE_PENDING.
    const me = await request(app).get("/api/v1/operators/me").set(bearer(techToken!)).expect(200);
    expect(me.body.status).toBe("PROFILE_PENDING");
    const completed = await request(app)
      .put("/api/v1/operators/me/profile")
      .set(bearer(techToken!))
      .send({
        phone: "617-555-0100",
        home_base: "Boston, MA",
        service_area: "Greater Boston",
        claimed_qualifications: ["WINDSHIELD", "ADAS_CALIBRATION", "MOBILE"],
        location_sharing_consent: true
      })
      .expect(200);
    expect(completed.body.status).toBe("PROFILE_PENDING");
    expect(completed.body.profile.phone).toBe("617-555-0100");

    // Staff cannot verify; admin verifies → ACTIVE with the claimed set.
    await request(app)
      .post(`/api/v1/operators/${record!.id}/verify`)
      .set(bearer(staffToken))
      .send({})
      .expect(403);
    const verified = await request(app)
      .post(`/api/v1/operators/${record!.id}/verify`)
      .set(bearer(adminToken))
      .send({ availability: MONDAY_WINDOW })
      .expect(200);
    expect(verified.body.operator.status).toBe("ACTIVE");
    expect(verified.body.operator.profile.qualifications).toEqual([
      "WINDSHIELD",
      "ADAS_CALIBRATION",
      "MOBILE"
    ]);

    // Verifying twice is a state error.
    await request(app)
      .post(`/api/v1/operators/${record!.id}/verify`)
      .set(bearer(adminToken))
      .send({})
      .expect(409);

    // Deactivation kills the tech's existing session immediately.
    const deactivated = await request(app)
      .post(`/api/v1/operators/${record!.id}/deactivate`)
      .set(bearer(adminToken))
      .expect(200);
    expect(deactivated.body.operator.status).toBe("DEACTIVATED");
    const blocked = await request(app)
      .get("/api/v1/operators/me")
      .set(bearer(techToken!))
      .expect(401);
    expect(blocked.body.error.code).toBe("ACCOUNT_INACTIVE");

    // Reactivation restores access.
    await request(app)
      .post(`/api/v1/operators/${record!.id}/reactivate`)
      .set(bearer(adminToken))
      .expect(200);
    await request(app).get("/api/v1/operators/me").set(bearer(techToken!)).expect(200);
  });

  it("rejects invites for existing accounts and duplicate live invites collapse to one", async () => {
    const { app } = await fixture({ google: true });
    const adminToken = await login(app, "admin@example.com", "admin-password");
    await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(adminToken))
      .send({ email: "staff@example.com" })
      .expect(409);
    await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(adminToken))
      .send({ email: "new.tech@gmail.com" })
      .expect(201);
    await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(adminToken))
      .send({ email: "new.tech@gmail.com" })
      .expect(201);
    const list = await request(app).get("/api/v1/operators").set(bearer(adminToken)).expect(200);
    expect(list.body.invites.filter((i: { email: string }) => i.email === "new.tech@gmail.com")).toHaveLength(1);
  });

  it("rejects an expired invite at the Google callback", async () => {
    const { app, store } = await fixture({ google: true });
    const credential = "rninv_" + "a".repeat(64);
    await store.createOperatorInvite({
      email: "tech.a@gmail.com",
      credentialHash: hashInviteCredential(credential),
      invitedBy: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    const cb = await googleCallback(app, { invite: credential, code: "code-tech-a" });
    expect(sessionFrom(cb.headers.location)).toBeNull();
    expect(authErrorFrom(cb.headers.location)).toMatch(/expired/i);
    expect(await store.findStaffByEmail("tech.a@gmail.com")).toBeNull();
  });

  it("revokes an open invite", async () => {
    const { app } = await fixture({ google: true });
    const adminToken = await login(app, "admin@example.com", "admin-password");
    const inviteRes = await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(adminToken))
      .send({ email: "gone@gmail.com" })
      .expect(201);
    await request(app)
      .delete(`/api/v1/operators/invites/${inviteRes.body.invite.id}`)
      .set(bearer(adminToken))
      .expect(200);
    const list = await request(app).get("/api/v1/operators").set(bearer(adminToken)).expect(200);
    expect(list.body.invites).toHaveLength(0);
  });
});

const ADAS_IDENTIFICATION: Partial<GlassIdentification> = {
  method: "YMM",
  status: "RESOLVED",
  provider: "mock",
  candidates: [],
  selected_candidate: {
    part_number: "DW02415",
    description: "Windshield with ADAS camera",
    features: ["adas-calibration", "rain-sensor"],
    position: "WINDSHIELD",
    list_price_cents: 30000
  },
  interchange_part_numbers: []
};

describe("Scheduler v1", () => {
  it("derives ADAS requirements from the identified glass features", () => {
    const withAdas = deriveRequirement("WINDSHIELD", ADAS_IDENTIFICATION as GlassIdentification);
    expect(withAdas.required_tags).toEqual(["WINDSHIELD", "ADAS_CALIBRATION"]);
    const plain = deriveRequirement("DOOR_GLASS", null);
    expect(plain.required_tags).toEqual(["DOOR_GLASS"]);
    expect(plain.requires_adas).toBe(false);
  });

  it("filters by qualification, availability, live status, and overlap — then ranks", async () => {
    const { store } = await fixture();
    const requirement = deriveRequirement("WINDSHIELD", ADAS_IDENTIFICATION as GlassIdentification);
    const base = { qualifications: ["WINDSHIELD", "ADAS_CALIBRATION", "MOBILE"] };

    const free = await makeTech(store, { email: "free@gmail.com", name: "Free Fred", ...base });
    const evening = await makeTech(store, { email: "eve@gmail.com", name: "Evening Eve", ...base });
    const morning = await makeTech(store, { email: "am@gmail.com", name: "Morning Mo", ...base });
    await makeTech(store, {
      email: "nodas@gmail.com",
      name: "No Adas",
      qualifications: ["WINDSHIELD", "MOBILE"]
    });
    await makeTech(store, {
      email: "door@gmail.com",
      name: "Door Dan",
      qualifications: ["DOOR_GLASS", "MOBILE"]
    });
    await makeTech(store, { email: "off@gmail.com", name: "Off Ollie", ...base, liveStatus: "OFF" });
    await makeTech(store, {
      email: "late@gmail.com",
      name: "Late Larry",
      ...base,
      availability: [{ day_of_week: 1, start: "18:00", end: "20:00" }]
    });
    const busy = await makeTech(store, { email: "busy@gmail.com", name: "Busy Bea", ...base });
    await makeTech(store, {
      email: "pending@gmail.com",
      name: "Pending Pam",
      ...base,
      status: "PROFILE_PENDING"
    });

    // Seed assigned jobs: morning tech finishes 13:00Z; evening tech works
    // 22:00Z; busy tech overlaps the target window.
    const seedJob = async (techId: string, start: string, end: string) => {
      const c = await caseAtPartsOrdered(store);
      const job = await store.createJob({ caseId: c.id });
      await store.updateJob(job.id, {
        status: "ASSIGNED",
        assigned_tech_id: techId,
        scheduled_start: start,
        scheduled_end: end
      });
    };
    await seedJob(morning.user.id, "2026-10-26T12:00:00.000Z", "2026-10-26T13:00:00.000Z");
    await seedJob(evening.user.id, "2026-10-26T22:00:00.000Z", "2026-10-26T23:00:00.000Z");
    await seedJob(busy.user.id, "2026-10-26T15:00:00.000Z", "2026-10-26T17:00:00.000Z");

    const target = await caseAtPartsOrdered(store);
    const result = await proposeAssignments(store, {
      requirement,
      startIso: JOB_START,
      endIso: JOB_END,
      excludeCaseId: target.id,
      timeZone: "America/New_York"
    });

    // Ranking: free-all-day + 0 jobs → free-all-day + 1 job → freed at 13:00Z.
    expect(result.eligible.map(c => c.tech_id)).toEqual([
      free.user.id,
      evening.user.id,
      morning.user.id
    ]);
    expect(result.eligible[0]).toMatchObject({ free_at: null, jobs_that_day: 0 });
    expect(result.eligible[1]).toMatchObject({ free_at: null, jobs_that_day: 1 });
    expect(result.eligible[2]).toMatchObject({ free_at: "2026-10-26T13:00:00.000Z", jobs_that_day: 1 });

    const excludedByEmail = new Map(result.excluded.map(e => [e.email, e.reasons.join(" ")]));
    expect(excludedByEmail.get("nodas@gmail.com")).toMatch(/ADAS_CALIBRATION/);
    expect(excludedByEmail.get("door@gmail.com")).toMatch(/WINDSHIELD/);
    expect(excludedByEmail.get("off@gmail.com")).toMatch(/off/i);
    expect(excludedByEmail.get("late@gmail.com")).toMatch(/availability/i);
    expect(excludedByEmail.get("busy@gmail.com")).toMatch(/overlapping/i);
    expect(excludedByEmail.get("pending@gmail.com")).toMatch(/not an active tech/i);
  });

  it("matches a door-glass job to the door-glass tech without ADAS", async () => {
    const { store } = await fixture();
    const door = await makeTech(store, {
      email: "door@gmail.com",
      name: "Door Dan",
      qualifications: ["DOOR_GLASS", "MOBILE"]
    });
    await makeTech(store, {
      email: "ws@gmail.com",
      name: "Shield Sue",
      qualifications: ["WINDSHIELD", "ADAS_CALIBRATION", "MOBILE"]
    });
    const target = await caseAtPartsOrdered(store, "DOOR_GLASS");
    const result = await proposeAssignments(store, {
      requirement: deriveRequirement("DOOR_GLASS", null),
      startIso: JOB_START,
      endIso: JOB_END,
      excludeCaseId: target.id,
      timeZone: "America/New_York"
    });
    expect(result.eligible.map(c => c.tech_id)).toEqual([door.user.id]);
  });
});

describe("Assignment", () => {
  async function assignmentFixture() {
    const f = await fixture({ google: true });
    const staffToken = await login(f.app, "staff@example.com", "staff-password");
    const qualified = await makeTech(f.store, {
      email: "qualified@gmail.com",
      name: "Quinn Qualified",
      qualifications: ["WINDSHIELD", "ADAS_CALIBRATION", "MOBILE"]
    });
    const second = await makeTech(f.store, {
      email: "second@gmail.com",
      name: "Second Sam",
      qualifications: ["WINDSHIELD", "ADAS_CALIBRATION", "MOBILE"]
    });
    const unqualified = await makeTech(f.store, {
      email: "unq@gmail.com",
      name: "Una Unqualified",
      qualifications: ["DOOR_GLASS"]
    });
    const c = await caseAtPartsOrdered(f.store);
    await f.store.saveGlassIdentification({
      caseId: c.id,
      glassRequestId: c.glass_request_id,
      method: "YMM",
      status: "RESOLVED",
      provider: "mock",
      candidates: [],
      selectedCandidate: {
        part_number: "DW02415",
        description: "Windshield with ADAS camera",
        features: ["adas-calibration", "rain-sensor"],
        position: "WINDSHIELD",
        list_price_cents: 30000
      },
      interchangePartNumbers: []
    });
    return { ...f, staffToken, qualified, second, unqualified, caseRecord: c };
  }

  it("proposes, assigns, reassigns — with events and calendar writes", async () => {
    const { app, store, calendar, staffToken, qualified, second, caseRecord: c } =
      await assignmentFixture();

    const propose = await request(app)
      .post(`/api/v1/cases/${c.id}/assignment/propose`)
      .set(bearer(staffToken))
      .send({ scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(200);
    expect(propose.body.job.status).toBe("UNASSIGNED");
    expect(propose.body.proposals.requirement.required_tags).toEqual([
      "WINDSHIELD",
      "ADAS_CALIBRATION"
    ]);
    expect(propose.body.proposals.eligible.map((x: { tech_id: string }) => x.tech_id)).toContain(
      qualified.user.id
    );

    const assigned = await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: qualified.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(200);
    expect(assigned.body.job).toMatchObject({
      status: "ASSIGNED",
      assigned_tech_id: qualified.user.id,
      assignment_mode: "DIRECT",
      tech_name: "Quinn Qualified"
    });
    // Assignment advances the case to INSTALLATION_SCHEDULED.
    expect(assigned.body.case.current_state).toBe("INSTALLATION_SCHEDULED");
    expect(assigned.body.case.job.assigned_tech_id).toBe(qualified.user.id);

    const events = await store.getEvents(c.id);
    const assignEvent = events.find(e => e.event_type === "TECH_ASSIGNED");
    expect(assignEvent?.payload).toMatchObject({
      tech_id: qualified.user.id,
      technician_name: "Quinn",
      scheduled_at: JOB_START,
      assignment_mode: "DIRECT"
    });
    // Calendar surface was written for the tech.
    expect(calendar.created).toHaveLength(1);
    expect(calendar.created[0].summary).toContain(c.reference);
    const jobAfterAssign = await store.getJobByCase(c.id);
    expect(jobAfterAssign?.calendar_event_id).toBe("mock-event-1");

    // Double-assign is refused; reassign is the path.
    await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: second.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(409);

    const reassigned = await request(app)
      .post(`/api/v1/cases/${c.id}/assignment/reassign`)
      .set(bearer(staffToken))
      .send({ tech_id: second.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(200);
    expect(reassigned.body.job.assigned_tech_id).toBe(second.user.id);
    const events2 = await store.getEvents(c.id);
    const reassignEvent = events2.find(e => e.event_type === "TECH_REASSIGNED");
    expect(reassignEvent?.payload).toMatchObject({
      tech_id: second.user.id,
      previous_tech_id: qualified.user.id,
      technician_name: "Second"
    });
    expect(calendar.deleted).toEqual([{ techId: qualified.user.id, eventId: "mock-event-1" }]);
    expect(calendar.created).toHaveLength(2);
    expect((await store.getJobByCase(c.id))?.calendar_event_id).toBe("mock-event-2");

    // Dispatch now projects the assigned tech's first name to the customer.
    await request(app)
      .post(`/api/v1/cases/${c.id}/actions`)
      .set(bearer(staffToken))
      .send({ action: "dispatch_technician" })
      .expect(200);
    const events3 = await store.getEvents(c.id);
    const dispatched = events3.find(e => e.event_type === "TECH_DISPATCHED");
    expect(dispatched?.payload.technician_name).toBe("Second");
  });

  it("requires a reason to override the scheduler, and logs it on the event", async () => {
    const { app, store, staffToken, unqualified, caseRecord: c } = await assignmentFixture();
    const refused = await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: unqualified.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(422);
    expect(refused.body.error.code).toBe("OVERRIDE_REASON_REQUIRED");

    await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({
        tech_id: unqualified.user.id,
        scheduled_start: JOB_START,
        scheduled_end: JOB_END,
        override_reason: "Only tech near the customer today"
      })
      .expect(200);
    const events = await store.getEvents(c.id);
    const assignEvent = events.find(e => e.event_type === "TECH_ASSIGNED");
    expect(assignEvent?.payload.override_reason).toBe("Only tech near the customer today");
  });

  it("refuses deactivated techs and wrong-state cases; calendar failure never blocks", async () => {
    const { app, store, calendar, staffToken, qualified, caseRecord: c } = await assignmentFixture();
    await store.updateTechProfile(qualified.user.id, { status: "DEACTIVATED" });
    const blocked = await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: qualified.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(409);
    expect(blocked.body.error.code).toBe("TECH_NOT_ACTIVE");
    await store.updateTechProfile(qualified.user.id, { status: "ACTIVE" });

    // A fresh case (REQUEST_RECEIVED) is not assignable yet.
    const { caseRecord: fresh } = await store.createCase({
      channel: "DIRECT",
      vehicle: { year: 2021, make: "Ford", model: "F-150", vin: "1FTEW1E50MFA00002" },
      glass_type: "WINDSHIELD"
    });
    await request(app)
      .post(`/api/v1/cases/${fresh.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: qualified.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(409);

    // Calendar outage: assignment still lands, no event id recorded.
    calendar.failCreates = true;
    const ok = await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: qualified.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(200);
    expect(ok.body.job.status).toBe("ASSIGNED");
    expect(ok.body.job.calendar_event_id).toBeNull();
  });

  it("serves the schedule board for a day: scheduled jobs + unscheduled worklist", async () => {
    const { app, staffToken, qualified, caseRecord: c } = await assignmentFixture();
    await request(app)
      .post(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(staffToken))
      .send({ tech_id: qualified.user.id, scheduled_start: JOB_START, scheduled_end: JOB_END })
      .expect(200);
    const board = await request(app)
      .get("/api/v1/schedule?date=2026-10-26")
      .set(bearer(staffToken))
      .expect(200);
    expect(board.body.date).toBe("2026-10-26");
    const entry = board.body.entries.find((e: { case_id: string }) => e.case_id === c.id);
    expect(entry).toMatchObject({
      reference: c.reference,
      tech_name: "Quinn Qualified",
      scheduled_start: JOB_START
    });
    const otherDay = await request(app)
      .get("/api/v1/schedule?date=2026-10-27")
      .set(bearer(staffToken))
      .expect(200);
    expect(otherDay.body.entries.find((e: { case_id: string }) => e.case_id === c.id)).toBeUndefined();
  });
});

describe("Tech access law", () => {
  it("a tech token can never reach the queue, operators, schedule, or case economics", async () => {
    const { app, store, staff } = await fixture({ google: true });
    const techA = await makeTech(store, {
      email: "a@gmail.com",
      name: "Tech A",
      qualifications: ["WINDSHIELD"]
    });
    const techB = await makeTech(store, {
      email: "b@gmail.com",
      name: "Tech B",
      qualifications: ["WINDSHIELD"]
    });
    const c = await caseAtPartsOrdered(store);
    const techToken = signToken(
      { id: techA.user.id, email: techA.user.email, name: techA.user.name, role: "tech", created_at: techA.user.created_at },
      TEST_SECRET
    );

    await request(app).get("/api/v1/cases").set(bearer(techToken)).expect(403);
    await request(app).get(`/api/v1/cases/${c.id}`).set(bearer(techToken)).expect(403);
    await request(app).get(`/api/v1/cases/${c.id}/events`).set(bearer(techToken)).expect(403);
    await request(app)
      .post(`/api/v1/cases/${c.id}/actions`)
      .set(bearer(techToken))
      .send({ action: "order_parts" })
      .expect(403);
    await request(app)
      .get(`/api/v1/cases/${c.id}/assignment`)
      .set(bearer(techToken))
      .expect(403);
    await request(app).get("/api/v1/operators").set(bearer(techToken)).expect(403);
    await request(app).get("/api/v1/schedule").set(bearer(techToken)).expect(403);
    await request(app)
      .post("/api/v1/operators/invites")
      .set(bearer(techToken))
      .send({ email: "x@gmail.com" })
      .expect(403);

    // The tech's own surface shows only their own profile — no other
    // tech, no economics fields anywhere.
    const me = await request(app).get("/api/v1/operators/me").set(bearer(techToken)).expect(200);
    expect(me.body.staff.email).toBe("a@gmail.com");
    expect(JSON.stringify(me.body)).not.toContain("b@gmail.com");
    expect(JSON.stringify(me.body)).not.toContain("price");
    expect(JSON.stringify(me.body)).not.toContain("profit");
    expect(JSON.stringify(me.body)).not.toContain("google_refresh");

    // A deactivated tech's pre-minted token dies at the auth gate.
    await store.updateTechProfile(techA.user.id, { status: "DEACTIVATED" });
    await request(app).get("/api/v1/operators/me").set(bearer(techToken)).expect(401);
    await store.updateTechProfile(techA.user.id, { status: "ACTIVE" });

    // Staff password login for a Google-only tech account is impossible,
    // and staff tokens still work everywhere above.
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "a@gmail.com", password: "whatever" })
      .expect(401);
    const staffToken = await login(app, "staff@example.com", "staff-password");
    await request(app).get("/api/v1/cases").set(bearer(staffToken)).expect(200);
    expect(staff.email).toBe("staff@example.com");
    expect(techB.user.email).toBe("b@gmail.com");
  });
});
