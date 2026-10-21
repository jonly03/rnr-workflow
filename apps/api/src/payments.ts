import type { CaseStore } from "./store.js";
import type { Invoice, InvoiceDisputeResolution } from "./types.js";

/**
 * Invoice payment lifecycle (Fulfillment Slice D, brief §3.6):
 *
 *   UNSENT --mark sent--> SENT --mark paid--> PAID
 *   UNSENT --mark paid--> PAID            (paid on delivery / at the counter)
 *   SENT   --dispute--> DISPUTED
 *   UNSENT --dispute--> DISPUTED          (client disputes a hand-delivered copy)
 *   DISPUTED --mark sent--> SENT          (re-sent after resolution)
 *   DISPUTED --resolve: paid--> PAID
 *   DISPUTED --resolve: adjusted--> stays DISPUTED + RESOLVED_ADJUSTED
 *             (staff re-invoice: the new version supersedes this one)
 *   DISPUTED --resolve: written off--> stays DISPUTED + RESOLVED_WRITTEN_OFF
 *             (admin/owner only; the case may still close, flagged — §5.4)
 *
 * NEW CLOSE RULE: a case with an invoice closes only when the invoice is
 * PAID (or written off). Marking an invoice PAID auto-closes its case
 * when the service is already complete; otherwise the case closes later
 * through the normal close_case action, which quoting.ts gates on the
 * same rule (invoiceClosable).
 *
 * Every action appends to the invoice's own thread (invoice_events) AND
 * emits a case event, so the staff activity feed and the realtime queue
 * stay consistent with every other case action. Case-event payloads stay
 * minimal (ids + codes): dispute free text lives only in the staff-only
 * thread, never on an event that could be projected anywhere else.
 */

export type InvoicePaymentErrorCode =
  | "NO_INVOICE"
  | "INVALID_TRANSITION"
  | "DISPUTE_REASON_REQUIRED"
  | "NOTE_REQUIRED"
  | "OUTCOME_INVALID"
  | "FORBIDDEN_ROLE";

export class InvoicePaymentError extends Error {
  constructor(
    readonly code: InvoicePaymentErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "InvoicePaymentError";
  }
}

export interface PaymentActor {
  type: string;
  id: string | null;
  /** Staff role ("admin" is the owner-equivalent role in code today). */
  role?: string | null;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Whole days an invoice has been waiting for payment. Counts from the
 * most recent send while SENT; a disputed invoice is still outstanding,
 * so it ages from its send (or dispute) date too. Null when aging does
 * not apply (UNSENT / PAID).
 */
export function agingDays(invoice: Invoice, now: Date = new Date()): number | null {
  if (invoice.payment_status === "SENT") {
    if (!invoice.sent_at) return null;
    return Math.max(0, Math.floor((now.getTime() - Date.parse(invoice.sent_at)) / DAY_MS));
  }
  if (invoice.payment_status === "DISPUTED") {
    const from = invoice.sent_at ?? invoice.disputed_at;
    if (!from) return null;
    return Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / DAY_MS));
  }
  return null;
}

/** True when this invoice lets its case close: paid, or written off. */
export function invoiceClosable(invoice: Invoice): boolean {
  return (
    invoice.payment_status === "PAID" ||
    invoice.dispute_resolution === "RESOLVED_WRITTEN_OFF"
  );
}

/** Staff-facing invoice serialization: the record plus derived fields. */
export function invoicePaymentView(invoice: Invoice, now: Date = new Date()) {
  return {
    ...invoice,
    aging_days: agingDays(invoice, now),
    closable: invoiceClosable(invoice)
  };
}

export type InvoicePaymentView = ReturnType<typeof invoicePaymentView>;

async function latestInvoiceOrThrow(store: CaseStore, caseId: string): Promise<Invoice> {
  const invoice = await store.getLatestInvoice(caseId);
  if (!invoice) {
    throw new InvoicePaymentError(
      "NO_INVOICE",
      "This case has no invoice yet.",
      409
    );
  }
  return invoice;
}

function invalidTransition(invoice: Invoice, action: string): InvoicePaymentError {
  return new InvoicePaymentError(
    "INVALID_TRANSITION",
    `Cannot ${action} an invoice in payment status ${invoice.payment_status}.`,
    409
  );
}

const clean = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * After a payment lands (or any closable change), close the case if the
 * service is already complete. Mirrors closeCase's CASE_CLOSED payload
 * and adds the automation markers. No-op in every other state: a case
 * paid early closes later via close_case (gated by the same rule).
 */
async function autoCloseIfReady(
  store: CaseStore,
  caseId: string,
  invoice: Invoice,
  actor: PaymentActor
): Promise<void> {
  if (!invoiceClosable(invoice)) return;
  const caseRecord = await store.getCase(caseId);
  if (!caseRecord || caseRecord.current_state !== "SERVICE_COMPLETED") return;
  const quote = await store.getLatestQuote(caseId);
  if (!quote || quote.status !== "APPROVED" || !quote.signature) return;
  await store.appendEvent({
    caseId,
    eventType: "CASE_CLOSED",
    actor: { type: actor.type, id: actor.id },
    nextState: "CLOSED",
    payload: {
      invoice_id: invoice.id,
      invoice_version: invoice.version,
      quote_id: quote.id,
      quote_version: quote.version,
      sell_price_cents: invoice.actuals.sell_price_cents,
      signed_by: quote.signature.name,
      signed_at: quote.signature.signed_at,
      auto: true,
      trigger: "invoice_paid",
      invoice_payment_status: invoice.payment_status,
      ...(invoice.dispute_resolution === "RESOLVED_WRITTEN_OFF"
        ? { invoice_written_off: true }
        : {})
    }
  });
}

export interface MarkSentInput {
  sent_via?: unknown;
  sent_to?: unknown;
}

/** Records that the invoice file was sent to the client. From UNSENT, or
 *  from DISPUTED (re-send after the dispute is resolved). */
export async function markInvoiceSent(
  store: CaseStore,
  caseId: string,
  input: MarkSentInput,
  actor: PaymentActor
): Promise<Invoice> {
  const invoice = await latestInvoiceOrThrow(store, caseId);
  if (invoice.payment_status !== "UNSENT" && invoice.payment_status !== "DISPUTED") {
    throw invalidTransition(invoice, "mark sent");
  }
  const wasDisputed = invoice.payment_status === "DISPUTED";
  const now = new Date().toISOString();
  const updated = await store.updateInvoicePayment(invoice.id, {
    payment_status: "SENT",
    sent_at: now,
    sent_via: clean(input.sent_via),
    sent_to: clean(input.sent_to),
    // A re-send closes out the active dispute on this version; the full
    // dispute history stays in the invoice thread + case events.
    ...(wasDisputed
      ? {
          dispute_reason_code: null,
          dispute_reason: null,
          disputed_at: null,
          dispute_resolution: null,
          dispute_resolved_at: null
        }
      : {})
  });
  await store.appendInvoiceEvent({
    invoiceId: invoice.id,
    caseId,
    kind: "SENT",
    actor: { type: actor.type, id: actor.id },
    payload: {
      sent_via: updated.sent_via,
      sent_to: updated.sent_to,
      resent_after_dispute: wasDisputed
    }
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_SENT",
    actor: { type: actor.type, id: actor.id },
    payload: {
      invoice_id: invoice.id,
      version: invoice.version,
      sent_via: updated.sent_via,
      resent_after_dispute: wasDisputed
    }
  });
  return updated;
}

export interface DisputeInput {
  reason_code?: unknown;
  reason?: unknown;
}

/** Opens a dispute on the latest invoice. A reason is required — an
 *  unexplained dispute cannot be worked. Reachable from SENT and from
 *  UNSENT (a client can dispute a hand-delivered copy). */
export async function openInvoiceDispute(
  store: CaseStore,
  caseId: string,
  input: DisputeInput,
  actor: PaymentActor
): Promise<Invoice> {
  const reason = clean(input.reason);
  if (!reason) {
    throw new InvoicePaymentError(
      "DISPUTE_REASON_REQUIRED",
      "A dispute reason is required.",
      422
    );
  }
  const invoice = await latestInvoiceOrThrow(store, caseId);
  if (invoice.payment_status !== "SENT" && invoice.payment_status !== "UNSENT") {
    throw invalidTransition(invoice, "dispute");
  }
  const now = new Date().toISOString();
  const updated = await store.updateInvoicePayment(invoice.id, {
    payment_status: "DISPUTED",
    dispute_reason_code: clean(input.reason_code),
    dispute_reason: reason,
    disputed_at: now,
    dispute_resolution: null,
    dispute_resolved_at: null
  });
  await store.appendInvoiceEvent({
    invoiceId: invoice.id,
    caseId,
    kind: "DISPUTE_OPENED",
    actor: { type: actor.type, id: actor.id },
    note: reason,
    payload: { reason_code: updated.dispute_reason_code }
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_DISPUTED",
    actor: { type: actor.type, id: actor.id },
    payload: {
      invoice_id: invoice.id,
      version: invoice.version,
      reason_code: updated.dispute_reason_code
    }
  });
  return updated;
}

/** Appends a staff update to an open dispute's thread. */
export async function addInvoiceDisputeUpdate(
  store: CaseStore,
  caseId: string,
  input: { note?: unknown },
  actor: PaymentActor
): Promise<Invoice> {
  const note = clean(input.note);
  if (!note) {
    throw new InvoicePaymentError("NOTE_REQUIRED", "An update note is required.", 422);
  }
  const invoice = await latestInvoiceOrThrow(store, caseId);
  if (invoice.payment_status !== "DISPUTED") {
    throw invalidTransition(invoice, "add a dispute update to");
  }
  await store.appendInvoiceEvent({
    invoiceId: invoice.id,
    caseId,
    kind: "DISPUTE_UPDATE",
    actor: { type: actor.type, id: actor.id },
    note
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_DISPUTE_UPDATED",
    actor: { type: actor.type, id: actor.id },
    payload: { invoice_id: invoice.id, version: invoice.version }
  });
  return invoice;
}

export interface PaidInput {
  method?: unknown;
  ref?: unknown;
  paid_by?: unknown;
}

function paidPatch(input: PaidInput, now: string) {
  return {
    payment_status: "PAID" as const,
    paid_at: now,
    paid_method: clean(input.method),
    paid_ref: clean(input.ref),
    paid_by: clean(input.paid_by)
  };
}

/** Records payment in full. From UNSENT (paid on delivery), SENT, or
 *  DISPUTED (payment settles the dispute). Auto-closes the case when the
 *  service is already complete. */
export async function markInvoicePaid(
  store: CaseStore,
  caseId: string,
  input: PaidInput,
  actor: PaymentActor
): Promise<Invoice> {
  const invoice = await latestInvoiceOrThrow(store, caseId);
  if (invoice.payment_status === "PAID") {
    throw invalidTransition(invoice, "mark paid");
  }
  const now = new Date().toISOString();
  const wasDisputed = invoice.payment_status === "DISPUTED";
  const updated = await store.updateInvoicePayment(invoice.id, {
    ...paidPatch(input, now),
    ...(wasDisputed
      ? {
          dispute_resolution: "RESOLVED_PAID" as InvoiceDisputeResolution,
          dispute_resolved_at: now
        }
      : {})
  });
  await store.appendInvoiceEvent({
    invoiceId: invoice.id,
    caseId,
    kind: "PAID",
    actor: { type: actor.type, id: actor.id },
    payload: {
      method: updated.paid_method,
      ref: updated.paid_ref,
      paid_by: updated.paid_by,
      settled_dispute: wasDisputed
    }
  });
  await store.appendEvent({
    caseId,
    eventType: "INVOICE_PAID",
    actor: { type: actor.type, id: actor.id },
    payload: {
      invoice_id: invoice.id,
      version: invoice.version,
      method: updated.paid_method,
      paid_by: updated.paid_by
    }
  });
  await autoCloseIfReady(store, caseId, updated, actor);
  return updated;
}

export type DisputeOutcome = "PAID" | "ADJUSTED" | "WRITTEN_OFF";

export interface ResolveDisputeInput extends PaidInput {
  outcome?: unknown;
  note?: unknown;
}

/**
 * Resolves an open dispute:
 *  - PAID: payment received; the invoice becomes PAID (auto-close rules
 *    apply, exactly like markInvoicePaid).
 *  - ADJUSTED: the amount was wrong; staff re-invoice afterwards and the
 *    new version supersedes this one. This version keeps its dispute
 *    record with RESOLVED_ADJUSTED.
 *  - WRITTEN_OFF: admin/owner only. The debt is forgiven; the invoice
 *    stays DISPUTED + RESOLVED_WRITTEN_OFF, which still permits closing
 *    the case (flagged) per brief §5.4. Does NOT auto-close.
 */
export async function resolveInvoiceDispute(
  store: CaseStore,
  caseId: string,
  input: ResolveDisputeInput,
  actor: PaymentActor
): Promise<Invoice> {
  const outcome = typeof input.outcome === "string" ? input.outcome : "";
  if (outcome !== "PAID" && outcome !== "ADJUSTED" && outcome !== "WRITTEN_OFF") {
    throw new InvoicePaymentError(
      "OUTCOME_INVALID",
      "outcome must be PAID, ADJUSTED, or WRITTEN_OFF.",
      422
    );
  }
  const invoice = await latestInvoiceOrThrow(store, caseId);
  if (invoice.payment_status !== "DISPUTED") {
    throw invalidTransition(invoice, "resolve a dispute on");
  }
  if (outcome === "WRITTEN_OFF" && actor.role !== "admin") {
    throw new InvoicePaymentError(
      "FORBIDDEN_ROLE",
      "Only an admin (owner) can write off an invoice.",
      403
    );
  }
  const now = new Date().toISOString();
  const note = clean(input.note);

  if (outcome === "PAID") {
    const updated = await store.updateInvoicePayment(invoice.id, {
      ...paidPatch(input, now),
      dispute_resolution: "RESOLVED_PAID",
      dispute_resolved_at: now
    });
    await store.appendInvoiceEvent({
      invoiceId: invoice.id,
      caseId,
      kind: "DISPUTE_RESOLVED",
      actor: { type: actor.type, id: actor.id },
      note,
      payload: { outcome: "RESOLVED_PAID" }
    });
    await store.appendInvoiceEvent({
      invoiceId: invoice.id,
      caseId,
      kind: "PAID",
      actor: { type: actor.type, id: actor.id },
      payload: { method: updated.paid_method, ref: updated.paid_ref, paid_by: updated.paid_by }
    });
    await store.appendEvent({
      caseId,
      eventType: "INVOICE_PAID",
      actor: { type: actor.type, id: actor.id },
      payload: {
        invoice_id: invoice.id,
        version: invoice.version,
        method: updated.paid_method,
        paid_by: updated.paid_by,
        settled_dispute: true
      }
    });
    await autoCloseIfReady(store, caseId, updated, actor);
    return updated;
  }

  const resolution: InvoiceDisputeResolution =
    outcome === "ADJUSTED" ? "RESOLVED_ADJUSTED" : "RESOLVED_WRITTEN_OFF";
  const updated = await store.updateInvoicePayment(invoice.id, {
    dispute_resolution: resolution,
    dispute_resolved_at: now
  });
  await store.appendInvoiceEvent({
    invoiceId: invoice.id,
    caseId,
    kind: "DISPUTE_RESOLVED",
    actor: { type: actor.type, id: actor.id },
    note,
    payload: { outcome: resolution }
  });
  await store.appendEvent({
    caseId,
    eventType:
      outcome === "WRITTEN_OFF" ? "INVOICE_WRITTEN_OFF" : "INVOICE_DISPUTE_RESOLVED",
    actor: { type: actor.type, id: actor.id },
    payload: { invoice_id: invoice.id, version: invoice.version, outcome: resolution }
  });
  return updated;
}

/**
 * The client-safe invoice projection the PDF is generated from. Built
 * field-by-field from the signed quote's snapshot + the invoice record:
 * the glass line carries cost+profit baked in (as on the quote page);
 * supplier name, raw glass cost, and profit never appear. The confirmed
 * R&R paper format shows the vehicle's own VIN and the part number, so
 * those are included — they are the client's own vehicle/part, not
 * economics.
 */
export interface InvoiceClientView {
  reference: string;
  invoice_version: number;
  issued_at: string;
  bill_to: string | null;
  vehicle: { year: number; make: string; model: string; vin: string };
  glass_type: string;
  part_number: string | null;
  /** Glass line amount with margin baked in (what the client pays for glass). */
  glass_cents: number;
  labor_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_status: Invoice["payment_status"];
  paid_at: string | null;
}

export async function buildInvoiceClientView(
  store: CaseStore,
  caseId: string
): Promise<InvoiceClientView | null> {
  const [caseRecord, invoice, quote] = await Promise.all([
    store.getCase(caseId),
    store.getLatestInvoice(caseId),
    store.getLatestQuote(caseId)
  ]);
  if (!caseRecord || !invoice || !quote) return null;
  const snap = quote.snapshot;
  return {
    reference: caseRecord.reference,
    invoice_version: invoice.version,
    issued_at: invoice.created_at,
    bill_to: quote.signature?.name ?? null,
    vehicle: {
      year: snap.vehicle.year,
      make: snap.vehicle.make,
      model: snap.vehicle.model,
      vin: snap.vehicle.vin
    },
    glass_type: snap.glass_type,
    part_number: snap.part_number,
    glass_cents: snap.glass_cost_cents + snap.profit_cents,
    labor_cents: snap.labor_cents,
    tax_cents: invoice.actuals.tax_cents,
    total_cents: invoice.actuals.sell_price_cents,
    payment_status: invoice.payment_status,
    paid_at: invoice.paid_at
  };
}
