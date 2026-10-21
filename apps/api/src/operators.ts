import { createHash, randomBytes } from "node:crypto";
import type { CaseStore } from "./store.js";
import {
  QUALIFICATION_TAGS,
  type AvailabilityWindow,
  type OperatorInvite,
  type OperatorStatus,
  type StaffUser,
  type TechProfile
} from "./types.js";

/**
 * Operator (tech) management + onboarding — Fulfillment Slice A.
 *
 * Onboarding state machine (brief §7.1):
 *   INVITED          an invite row exists for a Gmail address; no account
 *   PROFILE_PENDING  Google sign-in matched the invite; the account and
 *                    profile exist, staff have not verified the tech yet
 *   ACTIVE           staff verified qualifications; sign-in + assignment
 *   DEACTIVATED      sign-in and assignment are both blocked
 *
 * The invite credential is an opaque string shown exactly once (inside
 * the link staff send the tech); only its sha256 hash is stored — the
 * same pattern as approval tokens.
 */

export const OPERATOR_INVITE_PREFIX = "rninv_";
const INVITE_TTL_SECONDS = 7 * 24 * 3600; // 7 days

export type OperatorErrorCode =
  | "OPERATOR_NOT_FOUND"
  | "OPERATOR_EXISTS"
  | "INVITE_NOT_FOUND"
  | "INVITE_EXPIRED"
  | "INVITE_EMAIL_MISMATCH"
  | "INVALID_STATE"
  | "VALIDATION_ERROR";

export class OperatorError extends Error {
  constructor(
    readonly code: OperatorErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "OperatorError";
  }
}

export function hashInviteCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidAvailability(windows: unknown): windows is AvailabilityWindow[] {
  if (!Array.isArray(windows)) return false;
  return windows.every(
    w =>
      w !== null &&
      typeof w === "object" &&
      Number.isInteger((w as AvailabilityWindow).day_of_week) &&
      (w as AvailabilityWindow).day_of_week >= 0 &&
      (w as AvailabilityWindow).day_of_week <= 6 &&
      TIME_PATTERN.test((w as AvailabilityWindow).start) &&
      TIME_PATTERN.test((w as AvailabilityWindow).end) &&
      (w as AvailabilityWindow).start < (w as AvailabilityWindow).end
  );
}

export function sanitizeQualifications(tags: unknown): string[] | null {
  if (!Array.isArray(tags)) return null;
  const known = new Set(QUALIFICATION_TAGS);
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !known.has(tag)) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Tech profile as it may leave the server: the Google refresh credential
 *  is a server-side secret and is never serialized. */
export type PublicTechProfile = Omit<TechProfile, "google_refresh_credential">;

export function publicProfile(profile: TechProfile | null): PublicTechProfile | null {
  if (!profile) return null;
  const { google_refresh_credential: _secret, ...rest } = profile;
  return rest;
}

/** An operator as staff may see them: account + profile, no credentials. */
export interface OperatorView {
  id: string;
  email: string;
  name: string;
  role: string;
  status: OperatorStatus;
  profile: PublicTechProfile | null;
  created_at: string;
}

export function operatorView(user: StaffUser, profile: TechProfile | null): OperatorView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status:
      user.role === "tech"
        ? (profile?.status ?? "PROFILE_PENDING")
        : "ACTIVE",
    profile: publicProfile(profile),
    created_at: user.created_at
  };
}

/** An open invite, projected for the operators list (credential hash hidden). */
export interface InviteView {
  id: string;
  email: string;
  status: "INVITED";
  expires_at: string;
  created_at: string;
}

export function inviteView(invite: OperatorInvite): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    status: "INVITED",
    expires_at: invite.expires_at,
    created_at: invite.created_at
  };
}

/**
 * Invites a tech by Gmail address. Re-inviting the same address retires
 * the previous open invite so only one live link exists per person.
 * Returns the raw credential exactly once.
 */
export async function inviteOperator(
  store: CaseStore,
  input: { email: string; invitedBy: string | null }
): Promise<{ invite: OperatorInvite; credential: string }> {
  const email = input.email.trim().toLowerCase();
  const existingUser = await store.findStaffByEmail(email);
  if (existingUser) {
    throw new OperatorError(
      "OPERATOR_EXISTS",
      "An account already exists for that email address.",
      409
    );
  }
  const prior = await store.findOpenOperatorInviteByEmail(email);
  if (prior) await store.deleteOperatorInvite(prior.id);
  const credential = OPERATOR_INVITE_PREFIX + randomBytes(32).toString("hex");
  const invite = await store.createOperatorInvite({
    email,
    credentialHash: hashInviteCredential(credential),
    invitedBy: input.invitedBy,
    expiresAt: new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString()
  });
  return { invite, credential };
}

/**
 * Resolves an invite credential to a live invite, enforcing expiry.
 * Used by the Google sign-in flow; never consumes on its own.
 */
export async function resolveInvite(
  store: CaseStore,
  credential: string
): Promise<OperatorInvite> {
  if (!credential.startsWith(OPERATOR_INVITE_PREFIX)) {
    throw new OperatorError("INVITE_NOT_FOUND", "This invite link is invalid.", 404);
  }
  const invite = await store.findOperatorInviteByHash(hashInviteCredential(credential));
  if (!invite || invite.consumed_at) {
    throw new OperatorError(
      "INVITE_NOT_FOUND",
      "This invite link is invalid or has already been used.",
      404
    );
  }
  if (Date.parse(invite.expires_at) <= Date.now()) {
    throw new OperatorError(
      "INVITE_EXPIRED",
      "This invite link has expired. Ask R&R to send a fresh one.",
      410
    );
  }
  return invite;
}

/**
 * The onboarding key (brief §7.1): a Google identity whose email matches
 * an open invite becomes a tech account in PROFILE_PENDING. The Google
 * account email must match the invited address exactly (case-insensitive)
 * — an invite can never be claimed by a different Google account.
 */
export async function acceptInviteWithGoogleIdentity(
  store: CaseStore,
  invite: OperatorInvite,
  identity: { sub: string; email: string; name: string },
  refreshCredential: string | null
): Promise<{ user: StaffUser; profile: TechProfile }> {
  if (identity.email.trim().toLowerCase() !== invite.email) {
    throw new OperatorError(
      "INVITE_EMAIL_MISMATCH",
      "You signed in with a different Google account than the one invited. " +
        "Sign in with the invited Gmail address.",
      403
    );
  }
  const existing = await store.findStaffByEmail(invite.email);
  if (existing) {
    throw new OperatorError(
      "OPERATOR_EXISTS",
      "An account already exists for that email address.",
      409
    );
  }
  const user = await store.createStaffUser({
    email: invite.email,
    name: identity.name || invite.email,
    role: "tech",
    passwordHash: null
  });
  const profile = await store.createTechProfile({
    userId: user.id,
    googleSub: identity.sub,
    googleRefreshCredential: refreshCredential
  });
  await store.consumeOperatorInvite(invite.id);
  return { user, profile };
}

/** Loads a tech user + profile or throws OPERATOR_NOT_FOUND. */
export async function loadTech(
  store: CaseStore,
  userId: string
): Promise<{ user: StaffUser; profile: TechProfile }> {
  const record = await store.getStaffById(userId);
  if (!record || record.role !== "tech") {
    throw new OperatorError("OPERATOR_NOT_FOUND", "Tech not found.", 404);
  }
  const profile = await store.getTechProfile(userId);
  if (!profile) {
    throw new OperatorError("OPERATOR_NOT_FOUND", "Tech profile not found.", 404);
  }
  const { password_hash: _hash, ...user } = record;
  return { user, profile };
}

/**
 * Staff verification: PROFILE_PENDING → ACTIVE. Sets the verified
 * qualification set (defaulting to what the tech claimed) and the
 * availability template (defaulting to what is already on the profile).
 * Only verified qualifications make a tech scheduler-eligible.
 */
export async function verifyOperator(
  store: CaseStore,
  userId: string,
  input: { qualifications?: string[]; availability?: AvailabilityWindow[] }
): Promise<OperatorView> {
  const { user, profile } = await loadTech(store, userId);
  if (profile.status !== "PROFILE_PENDING") {
    throw new OperatorError(
      "INVALID_STATE",
      `Only a pending tech can be verified (current status: ${profile.status}).`,
      409
    );
  }
  const updated = await store.updateTechProfile(userId, {
    status: "ACTIVE",
    qualifications: input.qualifications ?? profile.claimed_qualifications,
    availability: input.availability ?? profile.availability
  });
  return operatorView(user, updated);
}

/** ACTIVE → DEACTIVATED. Blocks sign-in (auth gate) and assignment. */
export async function deactivateOperator(
  store: CaseStore,
  userId: string
): Promise<OperatorView> {
  const { user, profile } = await loadTech(store, userId);
  if (profile.status === "DEACTIVATED") {
    throw new OperatorError("INVALID_STATE", "This tech is already deactivated.", 409);
  }
  const updated = await store.updateTechProfile(userId, { status: "DEACTIVATED" });
  return operatorView(user, updated);
}

/** DEACTIVATED → ACTIVE. */
export async function reactivateOperator(
  store: CaseStore,
  userId: string
): Promise<OperatorView> {
  const { user, profile } = await loadTech(store, userId);
  if (profile.status !== "DEACTIVATED") {
    throw new OperatorError(
      "INVALID_STATE",
      `Only a deactivated tech can be reactivated (current status: ${profile.status}).`,
      409
    );
  }
  const updated = await store.updateTechProfile(userId, { status: "ACTIVE" });
  return operatorView(user, updated);
}
