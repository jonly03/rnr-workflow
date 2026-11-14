import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Brain Gateway audit log — one entry per tool call, success or failure.
 *
 * Every POST /brain dispatch appends an entry: when, which channel
 * (web / whatsapp / siri / phone), which tool, whether it succeeded,
 * what it charged, and how long it took. Arguments are NEVER logged
 * (they can hold customer names, phones, and addresses); only the
 * resulting case reference is kept, so the log stays PII-free.
 *
 * Entries live in an in-memory ring (last 500, for /brain/health) and
 * are appended as JSON lines to the audit file (BRAIN_AUDIT_LOG, or
 * data/gateway-audit.jsonl). Appending is best-effort: a logging
 * failure is console-logged, never fails the tool call.
 */

export type BrainChannel = "web" | "whatsapp" | "siri" | "phone" | "direct";

export interface AuditEntry {
  id: string;
  at: string;
  channel: BrainChannel;
  tool: string;
  /** First 12 hex chars of sha256(api key) — identifies the caller, never the key. */
  key_fingerprint: string | null;
  ok: boolean;
  error_code: string | null;
  /** USD actually charged for this call (from the pricing config; 0 on failure). */
  price_usd_charged: number;
  duration_ms: number;
  reference: string | null;
}

const RING_MAX = 500;
const ring: AuditEntry[] = [];

export function keyFingerprint(apiKey: string | null): string | null {
  if (!apiKey) return null;
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

export function defaultAuditLogPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../data/gateway-audit.jsonl");
}

export function appendAudit(
  entry: Omit<AuditEntry, "id" | "at"> & { at?: string },
  logPath: string = process.env.BRAIN_AUDIT_LOG ?? defaultAuditLogPath()
): AuditEntry {
  const full: AuditEntry = {
    id: randomUUID(),
    at: entry.at ?? new Date().toISOString(),
    ...entry
  };
  ring.push(full);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    fs.appendFileSync(logPath, JSON.stringify(full) + "\n", "utf-8");
  } catch (error) {
    console.error("brain gateway audit append failed:", error);
  }
  return full;
}

export function auditStats(): {
  total: number;
  ok: number;
  failed: number;
  charged_total_usd: number;
  by_tool: Record<string, number>;
} {
  const by_tool: Record<string, number> = {};
  let ok = 0;
  let charged = 0;
  for (const entry of ring) {
    by_tool[entry.tool] = (by_tool[entry.tool] ?? 0) + 1;
    if (entry.ok) ok++;
    charged += entry.price_usd_charged;
  }
  return {
    total: ring.length,
    ok,
    failed: ring.length - ok,
    charged_total_usd: Math.round(charged * 100) / 100,
    by_tool
  };
}

/** Test hook: clears the in-memory ring (the file is untouched). */
export function clearAuditRing(): void {
  ring.length = 0;
}
