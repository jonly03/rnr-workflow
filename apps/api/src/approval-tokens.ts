import { createHash, randomBytes } from "node:crypto";
import type {
  ApprovalTokenPurpose,
  ApprovalTokenRecord,
  Channel
} from "./types.js";
import type { CaseStore } from "./store.js";

export const APPROVAL_TOKEN_PREFIX = "rnappr_";
const TOKEN_BYTES = 32;

export interface MintApprovalTokenInput {
  caseId: string;
  channel: Channel;
  purpose: ApprovalTokenPurpose;
  /** Seconds until the token expires. */
  ttlSeconds: number;
}

export interface MintedApprovalToken {
  /** The token itself. Shown once at mint time; only its hash is stored. */
  token: string;
  jti: string;
  expiresAt: string;
}

export interface ApprovalGrant {
  jti: string;
  caseId: string;
  channel: Channel;
  purpose: ApprovalTokenPurpose;
  expiresAt: string;
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Mints an opaque, single-use, expiring token that grants an external party
 * scoped access to one case for one purpose (e.g. approving a quote).
 *
 * The token is opaque (not a JWT): the single-use requirement needs a
 * database row anyway, so there is no benefit to a stateless format and no
 * signature to get wrong. Only the sha256 hash is persisted.
 */
export async function mintApprovalToken(
  store: CaseStore,
  input: MintApprovalTokenInput
): Promise<MintedApprovalToken> {
  const token = APPROVAL_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  const { jti } = await store.createApprovalToken({
    caseId: input.caseId,
    channel: input.channel,
    purpose: input.purpose,
    tokenHash: hashApprovalToken(token),
    expiresAt
  });
  return { token, jti, expiresAt };
}

/**
 * Validates a presented token. Returns the grant, or null when the token is
 * unknown, expired, already consumed, or for an unexpected purpose.
 * Verification never consumes: the caller consumes after the approved action
 * succeeds, keeping approval idempotent on retry.
 */
export async function verifyApprovalToken(
  store: CaseStore,
  token: string,
  expectedPurpose?: ApprovalTokenPurpose
): Promise<ApprovalGrant | null> {
  if (!token.startsWith(APPROVAL_TOKEN_PREFIX)) return null;
  const record: ApprovalTokenRecord | null = await store.findApprovalTokenByHash(
    hashApprovalToken(token)
  );
  if (!record) return null;
  if (record.consumed_at) return null;
  if (Date.parse(record.expires_at) <= Date.now()) return null;
  if (expectedPurpose && record.purpose !== expectedPurpose) return null;
  return {
    jti: record.jti,
    caseId: record.case_id,
    channel: record.channel,
    purpose: record.purpose,
    expiresAt: record.expires_at
  };
}

/** Marks a token as used. Single-use: a second approval attempt must re-mint. */
export async function consumeApprovalToken(
  store: CaseStore,
  jti: string
): Promise<void> {
  await store.consumeApprovalToken(jti);
}
