import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_TOKEN_PREFIX,
  consumeApprovalToken,
  hashApprovalToken,
  mintApprovalToken,
  verifyApprovalToken
} from "../src/approval-tokens.js";
import { JsonCaseStore } from "../src/store.js";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-tokens-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const { caseRecord } = await store.createCase({
    channel: "DIRECT",
    vehicle: { year: 2020, make: "Honda", model: "Accord", vin: "1HGCM82633A004352" },
    glass_type: "WINDSHIELD"
  });
  return { store, caseId: caseRecord.id };
}

describe("Approval tokens", () => {
  it("mints a prefixed token that verifies to the original grant", async () => {
    const { store, caseId } = await fixture();
    const minted = await mintApprovalToken(store, {
      caseId,
      channel: "DIRECT",
      purpose: "quote-approval",
      ttlSeconds: 3600
    });

    expect(minted.token.startsWith(APPROVAL_TOKEN_PREFIX)).toBe(true);
    expect(minted.token.length).toBeGreaterThan(APPROVAL_TOKEN_PREFIX.length + 32);

    const grant = await verifyApprovalToken(store, minted.token, "quote-approval");
    expect(grant).toMatchObject({
      jti: minted.jti,
      caseId,
      channel: "DIRECT",
      purpose: "quote-approval"
    });
  });

  it("stores only the hash, never the token", async () => {
    const { store, caseId } = await fixture();
    const minted = await mintApprovalToken(store, {
      caseId,
      channel: "DIRECT",
      purpose: "quote-approval",
      ttlSeconds: 3600
    });

    const record = await store.findApprovalTokenByHash(hashApprovalToken(minted.token));
    expect(record).not.toBeNull();
    expect(record!.token_hash).toBe(hashApprovalToken(minted.token));
    expect(record!.token_hash).not.toContain(minted.token.slice(APPROVAL_TOKEN_PREFIX.length));
    // The raw token value appears nowhere in the persisted JSON file.
    const raw = fs.readFileSync((store as unknown as { filePath: string }).filePath, "utf8");
    expect(raw).not.toContain(minted.token.slice(-16));
  });

  it("rejects unknown tokens and tokens without the expected prefix", async () => {
    const { store } = await fixture();
    expect(
      await verifyApprovalToken(store, APPROVAL_TOKEN_PREFIX + "0".repeat(64), "quote-approval")
    ).toBeNull();
    expect(await verifyApprovalToken(store, "not-a-token", "quote-approval")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const { store, caseId } = await fixture();
    const minted = await mintApprovalToken(store, {
      caseId,
      channel: "DIRECT",
      purpose: "quote-approval",
      ttlSeconds: -1
    });
    expect(await verifyApprovalToken(store, minted.token, "quote-approval")).toBeNull();
  });

  it("is single-use: verify fails after consume", async () => {
    const { store, caseId } = await fixture();
    const minted = await mintApprovalToken(store, {
      caseId,
      channel: "DIRECT",
      purpose: "quote-approval",
      ttlSeconds: 3600
    });

    // Verification alone does not consume, so a failed approval attempt can retry.
    expect(await verifyApprovalToken(store, minted.token, "quote-approval")).not.toBeNull();
    expect(await verifyApprovalToken(store, minted.token, "quote-approval")).not.toBeNull();

    await consumeApprovalToken(store, minted.jti);
    expect(await verifyApprovalToken(store, minted.token, "quote-approval")).toBeNull();
  });

  it("rejects a token presented for the wrong purpose", async () => {
    const { store, caseId } = await fixture();
    const minted = await mintApprovalToken(store, {
      caseId,
      channel: "DIRECT",
      purpose: "quote-approval",
      ttlSeconds: 3600
    });
    expect(
      await verifyApprovalToken(store, minted.token, "other-purpose" as any)
    ).toBeNull();
  });
});
