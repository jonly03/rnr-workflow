import { createHash } from "node:crypto";
import type { CaseStore } from "./store.js";
import type { CaseRecord, Invoice, InvoiceActuals } from "./types.js";

/**
 * Invoicing + in-app sign-off (Phase 4 slice, no quote/order/install
 * dependency): PRICE_APPROVED --generate_invoice--> INVOICED
 * --sign_invoice--> INVOICED(signed) --close_case--> CLOSED.
 *
 * All money is integer cents, copied from the price-calculation snapshot —
 * no float math happens here. Invoices are append-only: re-invoicing
 * creates a new version; history is never mutated.
 */
export const INVOICING_TRANSITIONS: Record<string, Record<string, string>> = {
  PRICE_APPROVED: {
    GENERATE_INVOICE: "INVOICED"
  },
  INVOICED: {
    GENERATE_INVOICE: "INVOICED",
    SIGN_INVOICE: "INVOICED",
    CLOSE_CASE: "CLOSED"
  }
};

export type InvoicingErrorCode =
  | "INVALID_TRANSITION"
  | "NO_APPROVED_PRICE"
  | "INVALID_SIGNATURE"
  | "INVOICE_NOT_SIGNED";

export class InvoicingError extends Error {
  constructor(
    readonly code: InvoicingErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "InvoicingError";
  }
}

export interface Actor {
  type: string;
  id: string | null;
}

function transition(caseRecord: CaseRecord, event: string): string {
  const next = INVOICING_TRANSITIONS[caseRecord.current_state]?.[event];
  if (!next) {
    throw new InvoicingError(
      "INVALID_TRANSITION",
      `Event ${event} is not legal from state ${caseRecord.current_state}.`,
      409
    );
  }
  return next;
}

/** Where the invoice's numbers come from. Today the price snapshot is the
 *  only source (install isn't built yet); when the install slice lands,
 *  generateInvoice reads the completed job's actuals instead. */
const ACTUALS_SOURCE_PRICE_SNAPSHOT = "price_snapshot";

/**
 * Generates an invoice from the case's approved price snapshot.
 * Allowed from PRICE_APPROVED (first invoice) and INVOICED (re-invoice:
 * creates a new version, e.g. corrected actuals).
 */
export async function generateInvoice(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<Invoice> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const nextState = transition(caseRecord, "GENERATE_INVOICE");

  const glassRequest = await store.getGlassRequest(caseRecord.glass_request_id);
  if (!glassRequest) throw new Error("Case is missing glass request.");
  const latest = await store.getLatestPriceCalculation(glassRequest.id);
  if (!latest || latest.status !== "APPROVED") {
    throw new InvoicingError(
      "NO_APPROVED_PRICE",
      "An approved price calculation is required before invoicing.",
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
      throw new InvoicingError(
        "NO_APPROVED_PRICE",
        `Approved price has an invalid ${field}; cannot invoice.`,
        409
      );
    }
  }

  const prior = await store.listInvoices(caseId);
  const actuals: InvoiceActuals = {
    glass_cost_cents: latest.glass_cost_cents,
    labor_cents: latest.labor_cents,
    profit_cents: latest.profit_cents,
    tax_cents: latest.tax_cents,
    sell_price_cents: latest.sell_price_cents,
    price_calculation_id: latest.id,
    source: ACTUALS_SOURCE_PRICE_SNAPSHOT
  };
  const invoice = await store.saveInvoice({
    caseId,
    version: prior.length + 1,
    actuals,
    status: "SENT"
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_GENERATED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: {
      invoice_id: invoice.id,
      version: invoice.version,
      sell_price_cents: actuals.sell_price_cents,
      source: actuals.source
    }
  });
  return invoice;
}

export interface SignInvoiceInput {
  /** Printed name of the person signing. */
  name: string;
  /** data:image/png;base64,... from the signature pad. */
  signatureDataUrl: string;
  /** Free-text attribution, e.g. "signed on staff tablet at counter". */
  attribution: string;
}

const SIGNATURE_DATA_URL_PREFIX = "data:image/";
const MAX_SIGNATURE_BYTES = 512 * 1024;

/** SHA-256 of the decoded signature image bytes (not of the data URL string). */
export function hashSignatureBytes(pngBytes: Buffer): string {
  return createHash("sha256").update(pngBytes).digest("hex");
}

function decodeSignatureDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new InvoicingError("INVALID_SIGNATURE", "Signature image is malformed.", 422);
  }
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) {
    throw new InvoicingError("INVALID_SIGNATURE", "Signature image is malformed.", 422);
  }
  return bytes;
}

/**
 * Records the client's in-app signature on the latest invoice.
 * Idempotent: re-signing an already-signed invoice returns the current
 * record unchanged (no duplicate event).
 */
export async function signInvoice(
  store: CaseStore,
  caseId: string,
  input: SignInvoiceInput,
  actor: Actor
): Promise<Invoice> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  transition(caseRecord, "SIGN_INVOICE");

  const name = input.name?.trim() ?? "";
  if (!name) {
    throw new InvoicingError("INVALID_SIGNATURE", "Signer name is required.", 422);
  }
  const dataUrl = input.signatureDataUrl ?? "";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(SIGNATURE_DATA_URL_PREFIX)) {
    throw new InvoicingError("INVALID_SIGNATURE", "A drawn signature image is required.", 422);
  }
  const signatureBytes = decodeSignatureDataUrl(dataUrl);
  // A blank pad still encodes a valid PNG: require a minimum of ink so an
  // accidental empty submit is rejected rather than recorded as a signature.
  if (signatureBytes.length < 256) {
    throw new InvoicingError("INVALID_SIGNATURE", "Signature appears to be blank.", 422);
  }

  const latest = await store.getLatestInvoice(caseId);
  if (!latest) {
    throw new InvoicingError(
      "INVALID_TRANSITION",
      "No invoice exists for this case.",
      409
    );
  }
  if (latest.status === "SIGNED") return latest;

  const signedAt = new Date().toISOString();
  const signed = await store.signInvoice({
    invoiceId: latest.id,
    name,
    signatureHash: hashSignatureBytes(signatureBytes),
    signatureDataUrl: dataUrl,
    signedAt,
    attribution: (input.attribution ?? "").trim()
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_SIGNED",
    actor: { type: actor.type, id: actor.id },
    nextState: caseRecord.current_state,
    payload: {
      invoice_id: signed.id,
      version: signed.version,
      signer_name: name,
      signed_at: signedAt,
      attribution: signed.signature?.attribution ?? ""
    }
  });
  return signed;
}

/**
 * Closes the case. Only legal from INVOICED with a signed latest invoice;
 * otherwise rejected with INVOICE_NOT_SIGNED. CLOSED is terminal.
 */
export async function closeCase(
  store: CaseStore,
  caseId: string,
  actor: Actor
): Promise<CaseRecord> {
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) throw new Error("Case not found.");
  const nextState = transition(caseRecord, "CLOSE_CASE");

  const latest = await store.getLatestInvoice(caseId);
  if (!latest || latest.status !== "SIGNED" || !latest.signature) {
    throw new InvoicingError(
      "INVOICE_NOT_SIGNED",
      "The invoice must be signed by the client before the case can be closed.",
      409
    );
  }
  await store.appendEvent({
    caseId,
    eventType: "CASE_CLOSED",
    actor: { type: actor.type, id: actor.id },
    nextState,
    payload: {
      invoice_id: latest.id,
      version: latest.version,
      sell_price_cents: latest.actuals.sell_price_cents,
      signed_by: latest.signature.name,
      signed_at: latest.signature.signed_at
    }
  });
  const updated = await store.getCase(caseId);
  if (!updated) throw new Error("Case not found.");
  return updated;
}
