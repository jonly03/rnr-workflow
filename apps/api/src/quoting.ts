import { createHash } from "node:crypto";
import { invoiceClosable } from "./payments.js";
import type { CaseStore } from "./store.js";
import type { CaseRecord, Quote, QuoteSnapshot, SignatureMethod } from "./types.js";

/**
 * Quote + invoice + closeout (Phase 4 slice, no order/install dependency):
 *
 *   PRICE_APPROVED --generate_quote--> QUOTE_SENT --sign_quote--> QUOTE_APPROVED
 *   QUOTE_SENT --decline_quote--> QUOTE_DECLINED --requote--> QUOTE_SENT (new version)
 *   QUOTE_SENT --(expiry)--> QUOTE_EXPIRED --requote--> QUOTE_SENT (new version)
 *   QUOTE_APPROVED --generate_invoice--> INVOICED --(fulfillment, lifecycle.ts)-->
 *   SERVICE_COMPLETED --close_case--> CLOSED
 *
 * The client signs the QUOTE (signature = approval), not the invoice. The
 * invoice is generated later off the signed quote's snapshot and carries the
 * quote id + version it was built from. There is no invoice signature.
 *
 * Quotes are append-only: a requote supersedes by creating a new version;
 * history is never mutated. A signed quote never expires.
 *
 * All money is integer cents, copied from the price-calculation snapshot —
 * no float math happens here.
 */
export const QUOTING_TRANSITIONS: Record<string, Record<string, string>> = {
  PRICE_APPROVED: {
    GENERATE_QUOTE: "QUOTE_SENT"
  },
  QUOTE_SENT: {
    GENERATE_QUOTE: "QUOTE_SENT",
    SIGN_QUOTE: "QUOTE_APPROVED",
    DECLINE_QUOTE: "QUOTE_DECLINED"
  },
  QUOTE_DECLINED: {
    GENERATE_QUOTE: "QUOTE_SENT"
  },
  QUOTE_EXPIRED: {
    GENERATE_QUOTE: "QUOTE_SENT"
  },
  QUOTE_APPROVED: {
    GENERATE_INVOICE: "INVOICED"
  },
  INVOICED: {
    GENERATE_INVOICE: "INVOICED"
  },
  // Fulfillment (lifecycle.ts) walks INVOICED → PARTS_ORDERED → …
  // → SERVICE_COMPLETED; only a completed service can close.
  SERVICE_COMPLETED: {
    CLOSE_CASE: "CLOSED"
  }
};

/**
 * Quoting configuration. Quote validity is configuration-driven
 * (QUOTE_EXPIRY_HOURS, default 72) — never hard-coded.
 */
export interface QuotingConfig {
  /** Hours a generated quote stays signable before expiring. */
  expiry_hours: number;
}

export function loadQuotingConfig(env: NodeJS.ProcessEnv = process.env): QuotingConfig {
  const raw = env["QUOTE_EXPIRY_HOURS"];
  if (raw === undefined || raw.trim() === "") return { expiry_hours: 72 };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid QUOTE_EXPIRY_HOURS: must be a positive number.");
  }
  return { expiry_hours: parsed };
}

export type QuotingErrorCode =
  | "INVALID_TRANSITION"
  | "NO_APPROVED_PRICE"
  | "INVALID_SIGNATURE"
  | "VALIDATION_ERROR"
  | "QUOTE_EXPIRED"
  | "QUOTE_NOT_SIGNED"
  | "INVOICE_NOT_PAID"
  | "NO_SIGNED_QUOTE";

export class QuotingError extends Error {
  constructor(
    readonly code: QuotingErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "QuotingError";
  }
}

export interface Actor {
  type: string;
  id: string | null;
}

function transition(caseRecord: CaseRecord, event: string): string {
  const next = QUOTING_TRANSITIONS[caseRecord.current_state]?.[event];
  if (!next) {
    throw new QuotingError(
      "INVALID_TRANSITION",
      `Event ${event} is not legal from state ${caseRecord.current_state}.`,
      409
    );
  }
  return next;
}

/**
 * Generates a quote (versioned, immutable snapshot) from the case's approved
 * price snapshot. Allowed from PRICE_APPROVED (first quote), QUOTE_SENT
 * (re-generate: new version), QUOTE_DECLINED and QUOTE_EXPIRED (requote:
 * new version).
 *
 * A still-unsigned SENT quote is marked SUPERSEDED when a new version is
 * generated: history stays append-only, but only the newest version is
 * live. `opts.auto` marks quotes the system generated itself (at price
 * approval / after a reprice) versus an explicit staff action.
 */
export async function generateQuote(
  store: CaseStore,
  config: QuotingConfig,
  caseId: string,
  actor: Actor,
  opts: { auto?: boolean; trigger?: string } = {}
): Promise<Quote> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const nextState = transition(caseRecord, "GENERATE_QUOTE");

  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  if (!glassRequest) throw new Error("Case is missing glass request.");
  const latest = await store.getLatestPriceCalculation(glassRequest.id);
  if (!latest || latest.status !== "APPROVED") {
    throw new QuotingError(
      "NO_APPROVED_PRICE",
      "An approved price calculation is required before quoting.",
      409
    );
  }
  for (const [field, value] of Object.entries({
    glass_cost_cents: latest.glass_cost_cents,
    labor_cents: latest.labor_cents,
    profit_cents: latest.profit_cents,
    tax_cents: latest.tax_cents,
    sell_price_cents: latest.sell_price_cents
  }) as [string, number][]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new QuotingError(
        "NO_APPROVED_PRICE",
        `Approved price has an invalid ${field}; cannot quote.`,
        409
      );
    }
  }

  const vehicle = await store.getVehicle(caseRecord.vehicle_id);
  if (!vehicle) throw new Error("Case is missing vehicle.");
  const offers = await store.listSupplierOffers(glassRequest.id);
  const selected = offers.find(o => o.selected) ?? null;

  const prior = await store.listQuotes(caseId);
  const now = new Date();
  const snapshot: QuoteSnapshot = {
    vehicle: {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      vin: vehicle.vin
    },
    glass_type: glassRequest.glass_type,
    part_number: selected?.part_number ?? null,
    supplier_name: selected?.supplier_name ?? null,
    glass_cost_cents: latest.glass_cost_cents,
    labor_cents: latest.labor_cents,
    profit_cents: latest.profit_cents,
    tax_cents: latest.tax_cents,
    sell_price_cents: latest.sell_price_cents,
    price_calculation_id: latest.id
  };
  const expiresAt = new Date(now.getTime() + config.expiry_hours * 3600_000).toISOString();
  const priorLatest = prior[prior.length - 1] ?? null;
  const superseded =
    priorLatest && priorLatest.status === "SENT" ? priorLatest : null;
  if (superseded) {
    await store.updateQuoteStatus(superseded.id, "SUPERSEDED");
  }
  const quote = await store.saveQuote({
    caseId,
    version: prior.length + 1,
    snapshot,
    expiresAt,
    status: "SENT"
  });
  await store.appendEvent({
    caseId,
    eventType: "QUOTE_GENERATED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: {
      quote_id: quote.id,
      version: quote.version,
      sell_price_cents: snapshot.sell_price_cents,
      expires_at: expiresAt,
      superseded_version: superseded ? superseded.version : null,
      ...(opts.auto ? { auto: true, trigger: opts.trigger ?? "price_approved" } : {})
    }
  });
  return quote;
}

export interface SignQuoteInput {
  /** The signer's first and last name. For a typed signature this name IS
   *  the signature; it also remains the signer name on drawn signatures. */
  name: string;
  /** Legacy: data:image/png;base64,... from the old signature pad. New
   *  clients send none — the typed name is the signature. When a non-empty
   *  data URL is supplied it is validated and stored as before (drawn). */
  signatureDataUrl?: string;
  /** Free-text attribution, e.g. "signed on staff tablet at counter". */
  attribution: string;
}

const SIGNATURE_DATA_URL_PREFIX = "data:image/";
const MAX_SIGNATURE_BYTES = 512 * 1024;

/** SHA-256 of the decoded signature image bytes (not of the data URL string). */
export function hashSignatureBytes(pngBytes: Buffer): string {
  return createHash("sha256").update(pngBytes).digest("hex");
}

/** SHA-256 of the typed signature artifact: the signer's normalized name,
 *  domain-separated so it can never collide with an image-byte hash. */
export function hashTypedSignature(normalizedName: string): string {
  return createHash("sha256").update(`typed-signature:${normalizedName}`, "utf8").digest("hex");
}

/** Trim and collapse internal whitespace runs to single spaces. */
export function normalizeSignerName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function decodeSignatureDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new QuotingError("INVALID_SIGNATURE", "Signature image is malformed.", 422);
  }
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) {
    throw new QuotingError("INVALID_SIGNATURE", "Signature image is malformed.", 422);
  }
  return bytes;
}

interface ValidatedSignature {
  /** The normalized signer name (trimmed, single-spaced). */
  name: string;
  method: SignatureMethod;
  signatureHash: string;
  /** The data URL to persist ("" for typed signatures). */
  signatureDataUrl: string;
}

function validateSignatureInput(input: SignQuoteInput): ValidatedSignature {
  const name = normalizeSignerName(input.name ?? "");
  // The signature field takes the client's first AND last name — one word
  // is not a signature.
  if (name.split(" ").filter(Boolean).length < 2) {
    throw new QuotingError(
      "VALIDATION_ERROR",
      "Enter your first and last name in the signature field.",
      422
    );
  }
  const dataUrl = typeof input.signatureDataUrl === "string" ? input.signatureDataUrl.trim() : "";
  if (!dataUrl) {
    // Typed signature: the name itself is the signed artifact.
    return { name, method: "typed", signatureHash: hashTypedSignature(name), signatureDataUrl: "" };
  }
  if (!dataUrl.startsWith(SIGNATURE_DATA_URL_PREFIX)) {
    throw new QuotingError("INVALID_SIGNATURE", "Signature image is malformed.", 422);
  }
  const signatureBytes = decodeSignatureDataUrl(dataUrl);
  // A blank pad still encodes a valid PNG: require a minimum of ink so an
  // accidental empty submit is rejected rather than recorded as a signature.
  if (signatureBytes.length < 256) {
    throw new QuotingError("INVALID_SIGNATURE", "Signature appears to be blank.", 422);
  }
  return { name, method: "drawn", signatureHash: hashSignatureBytes(signatureBytes), signatureDataUrl: dataUrl };
}

/**
 * Records the client's in-app signature on the latest quote: signature =
 * approval. Idempotent: signing an already-approved quote returns the
 * current record unchanged (no duplicate event).
 *
 * Expiry: a quote past its expires_at cannot be signed. The attempt marks
 * the quote QUOTE_EXPIRED (event recorded) and is rejected with
 * QUOTE_EXPIRED (410). A signed quote never expires.
 */
export async function signQuote(
  store: CaseStore,
  caseId: string,
  input: SignQuoteInput,
  actor: Actor
): Promise<Quote> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");

  // Idempotent: signing an already-approved quote returns the current
  // record unchanged (no duplicate event, no state change). Checked before
  // the transition so a re-sign from QUOTE_APPROVED is legal.
  const existing = await store.getLatestQuote(caseId);
  if (existing && existing.status === "APPROVED" && existing.signature) {
    return existing;
  }

  const nextState = transition(caseRecord, "SIGN_QUOTE");

  const latest = await store.getLatestQuote(caseId);
  if (!latest || latest.status !== "SENT") {
    throw new QuotingError(
      "INVALID_TRANSITION",
      "No signable quote exists for this case.",
      409
    );
  }

  if (new Date(latest.expires_at).getTime() <= Date.now()) {
    await store.updateQuoteStatus(latest.id, "EXPIRED");
    await store.appendEvent({
      caseId,
      eventType: "QUOTE_EXPIRED",
      actor: { type: "SYSTEM", id: null },
      nextState: "QUOTE_EXPIRED",
      payload: { quote_id: latest.id, version: latest.version, expires_at: latest.expires_at }
    });
    throw new QuotingError(
      "QUOTE_EXPIRED",
      "This quote has expired. Ask staff to issue a new quote.",
      410
    );
  }

  const validated = validateSignatureInput(input);
  if (latest.signature) return latest;

  const name = validated.name;
  const signedAt = new Date().toISOString();
  const signed = await store.signQuote({
    quoteId: latest.id,
    name,
    signatureHash: validated.signatureHash,
    signatureDataUrl: validated.signatureDataUrl,
    method: validated.method,
    signedAt,
    attribution: (input.attribution ?? "").trim()
  });
  await store.appendEvent({
    caseId,
    eventType: "QUOTE_SIGNED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: {
      quote_id: signed.id,
      version: signed.version,
      signer_name: name,
      signed_at: signedAt,
      signature_method: validated.method,
      attribution: signed.signature?.attribution ?? ""
    }
  });
  return signed;
}

/**
 * Records the client declining the latest quote. From QUOTE_SENT only;
 * staff can requote afterwards (new version).
 */
export async function declineQuote(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<Quote> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const nextState = transition(caseRecord, "DECLINE_QUOTE");

  const latest = await store.getLatestQuote(caseId);
  if (!latest || latest.status !== "SENT") {
    throw new QuotingError(
      "INVALID_TRANSITION",
      "No sent quote exists for this case.",
      409
    );
  }
  const declined = await store.updateQuoteStatus(latest.id, "DECLINED");
  await store.appendEvent({
    caseId,
    eventType: "QUOTE_DECLINED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: { quote_id: declined.id, version: declined.version }
  });
  return declined;
}

/**
 * Generates an invoice off the case's signed quote. Requires a signed
 * (approved) latest quote; line items come from the quote's snapshot and
 * the invoice records the quote id + version it was built from. There is
 * no invoice signature — the signed quote is the authorization.
 */
export async function generateInvoice(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<import("./types.js").Invoice> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const nextState = transition(caseRecord, "GENERATE_INVOICE");

  const latestQuote = await store.getLatestQuote(caseId);
  if (!latestQuote || latestQuote.status !== "APPROVED" || !latestQuote.signature) {
    throw new QuotingError(
      "QUOTE_NOT_SIGNED",
      "A client-signed quote is required before invoicing.",
      409
    );
  }
  const snap = latestQuote.snapshot;
  const prior = await store.listInvoices(caseId);
  const invoice = await store.saveInvoice({
    caseId,
    version: prior.length + 1,
    actuals: {
      glass_cost_cents: snap.glass_cost_cents,
      labor_cents: snap.labor_cents,
      profit_cents: snap.profit_cents,
      tax_cents: snap.tax_cents,
      sell_price_cents: snap.sell_price_cents,
      price_calculation_id: snap.price_calculation_id,
      quote_id: latestQuote.id,
      quote_version: latestQuote.version,
      source: "signed_quote"
    }
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_GENERATED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: {
      invoice_id: invoice.id,
      version: invoice.version,
      sell_price_cents: invoice.actuals.sell_price_cents,
      quote_id: latestQuote.id,
      quote_version: latestQuote.version
    }
  });
  return invoice;
}

/**
 * Closes the case. Only legal from SERVICE_COMPLETED (fulfillment done)
 * when an invoice exists, the underlying quote is signed, AND — the
 * Slice D close rule (brief §3.6, superseding the 2026-10-19 rule) —
 * the invoice is PAID (or written off by an admin, which closes with a
 * flag). A finished job with an unpaid invoice stays open; the staff
 * invoice board surfaces it as awaiting payment. When payment lands
 * after completion, payments.ts auto-closes instead. CLOSED is terminal.
 */
export async function closeCase(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<CaseRecord> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const nextState = transition(caseRecord, "CLOSE_CASE");

  const latestInvoice = await store.getLatestInvoice(caseId);
  if (!latestInvoice) {
    throw new QuotingError(
      "NO_SIGNED_QUOTE",
      "An invoice is required before the case can be closed.",
      409
    );
  }
  if (!invoiceClosable(latestInvoice)) {
    throw new QuotingError(
      "INVOICE_NOT_PAID",
      "The invoice must be paid before the case can be closed.",
      409
    );
  }
  const latestQuote = await store.getLatestQuote(caseId);
  if (!latestQuote || latestQuote.status !== "APPROVED" || !latestQuote.signature) {
    throw new QuotingError(
      "QUOTE_NOT_SIGNED",
      "The quote must be signed by the client before the case can be closed.",
      409
    );
  }
  await store.appendEvent({
    caseId,
    eventType: "CASE_CLOSED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: {
      invoice_id: latestInvoice.id,
      invoice_version: latestInvoice.version,
      quote_id: latestQuote.id,
      quote_version: latestQuote.version,
      sell_price_cents: latestInvoice.actuals.sell_price_cents,
      signed_by: latestQuote.signature.name,
      signed_at: latestQuote.signature.signed_at,
      invoice_payment_status: latestInvoice.payment_status,
      ...(latestInvoice.dispute_resolution === "RESOLVED_WRITTEN_OFF"
        ? { invoice_written_off: true }
        : {})
    }
  });
  const updated = await store.getCase(caseId);
  if (!updated) throw new Error("Case not found.");
  return updated;
}
