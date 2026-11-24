import { mintApprovalToken } from "./approval-tokens.js";
import {
  createEmailSender,
  isEmailAddress,
  type EmailSender
} from "./email.js";
import { webBaseUrl } from "./notifications.js";
import type { CaseStore } from "./store.js";
import type { NotificationRecord } from "./types.js";

/**
 * Customer quote / invoice emails + unsigned-quote reminders
 * (Nelly, 2026-11-23):
 *
 *  - The QUOTE is emailed when it is generated/sent — the email
 *    carries the customer's sign link (a quote-approval token bound
 *    to the quote's own expiry, the same link staff mint manually).
 *  - The INVOICE is emailed when it is generated — and generation is
 *    wired to signing: the public sign endpoint already generates the
 *    invoice from the signed quote, the staff sign_quote action now
 *    does the same, and this module's dispatch runs at both points,
 *    so a signature can never land without the invoice email firing.
 *  - While a quote sits unsigned, the customer is reminded by email
 *    every 24 hours, stopping at signature or expiry. With the
 *    5-day (120h) quote validity that is at most 4 reminders.
 *
 * Law (mirrors the job-completion text in notifications.ts):
 *  - Record first: every email owed is a notifications row (channel
 *    "email") written BEFORE delivery is attempted, unique per
 *    (case, kind), so each trigger is idempotent — kinds are
 *    quote_sent_v{n}, invoice_sent_v{n}, quote_reminder_v{n}_{k}.
 *    The notifications table's destination column predates email; it
 *    stores the address as recorded, whatever the channel.
 *  - Delivery failure NEVER fails the case flow: the error lands on
 *    the row (status "failed") and is logged. With no email provider
 *    configured the row fails with EMAIL_NOT_CONFIGURED — loud in the
 *    record and in health (email_provider="unconfigured"), never a
 *    silent fake-send.
 *  - No customer email on the case → the row is "skipped" with the
 *    reason in its note, so staff can see the email was owed.
 */

export const QUOTE_EMAIL_KIND_PREFIX = "quote_sent_v";
export const INVOICE_EMAIL_KIND_PREFIX = "invoice_sent_v";
export const QUOTE_REMINDER_KIND_PREFIX = "quote_reminder_v";

/** Max reminders per quote version: one per 24h inside a 5-day window. */
export const MAX_QUOTE_REMINDERS = 4;
export const REMINDER_INTERVAL_MS = 24 * 3600_000;

export interface CustomerEmailDeps {
  sender?: EmailSender;
  env?: Record<string, string | undefined>;
  /** Clock override for tests. */
  now?: () => Date;
}

interface CustomerContact {
  name: string | null;
  email: string | null;
}

/**
 * The customer's name + email from the intake event — the same source
 * notifications.ts reads for the completion text (kept separate here
 * to avoid an import cycle through lifecycle/job-execution).
 */
export async function customerContactForCase(
  store: CaseStore,
  caseId: string
): Promise<CustomerContact> {
  const events = await store.getEvents(caseId);
  const intake = [...events]
    .reverse()
    .find(e => e.event_type === "CLIENT_INTAKE_SUBMITTED");
  if (!intake) return { name: null, email: null };
  const payload = intake.payload ?? {};
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    name: str(payload.customer_name),
    email: str(payload.customer_email)
  };
}

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const firstName = (name: string | null): string | null =>
  name ? name.split(/\s+/)[0] : null;

export function composeQuoteEmail(input: {
  firstName: string | null;
  reference: string;
  totalCents: number;
  expiresAt: string;
  signUrl: string | null;
}): { subject: string; body: string } {
  const greeting = input.firstName ? `Hi ${input.firstName}` : "Hi there";
  const lines = [
    `${greeting}, R&R Finest Auto Glass here — your quote is ready.`,
    ``,
    `Quote for case ${input.reference}: ${money(input.totalCents)} total.`,
    `This quote is valid until ${new Date(input.expiresAt).toLocaleString("en-US")}.`
  ];
  if (input.signUrl) {
    lines.push(``, `Review and sign your quote here:`, input.signUrl);
  }
  lines.push(
    ``,
    `Signing approves the quote and books your job — no payment is due when you sign.`,
    `Thank you!`
  );
  return {
    subject: `Your R&R Finest Auto Glass quote (${input.reference}) — ready to sign`,
    body: lines.join("\n")
  };
}

export function composeInvoiceEmail(input: {
  firstName: string | null;
  reference: string;
  totalCents: number;
  trackingUrl: string | null;
}): { subject: string; body: string } {
  const greeting = input.firstName ? `Hi ${input.firstName}` : "Hi there";
  const lines = [
    `${greeting}, thank you for approving your quote — your invoice is ready.`,
    ``,
    `Invoice for case ${input.reference}: ${money(input.totalCents)} total due.`
  ];
  if (input.trackingUrl) {
    lines.push(
      ``,
      `Follow your job and view your invoice here:`,
      input.trackingUrl
    );
  }
  lines.push(``, `Thank you for choosing R&R Finest Auto Glass!`);
  return {
    subject: `Your R&R Finest Auto Glass invoice (${input.reference})`,
    body: lines.join("\n")
  };
}

export function composeQuoteReminderEmail(input: {
  firstName: string | null;
  reference: string;
  totalCents: number;
  expiresAt: string;
  signUrl: string | null;
  reminderNumber: number;
}): { subject: string; body: string } {
  const greeting = input.firstName ? `Hi ${input.firstName}` : "Hi there";
  const lines = [
    `${greeting}, a friendly reminder from R&R Finest Auto Glass — your quote is still waiting for your signature.`,
    ``,
    `Quote for case ${input.reference}: ${money(input.totalCents)} total.`,
    `It expires ${new Date(input.expiresAt).toLocaleString("en-US")} — after that we would need to issue a new quote.`
  ];
  if (input.signUrl) {
    lines.push(``, `Review and sign here:`, input.signUrl);
  }
  lines.push(``, `No payment is due when you sign. Thank you!`);
  return {
    subject: `Reminder: your R&R Finest Auto Glass quote (${input.reference}) is waiting for your signature`,
    body: lines.join("\n")
  };
}

/**
 * Records the email as owed, then attempts delivery. Returns the
 * notification row (existing / sent / failed / skipped), or null when
 * the case does not exist. Never throws for delivery problems — the
 * failure is written onto the row and logged instead.
 */
async function recordAndSend(
  store: CaseStore,
  caseId: string,
  input: {
    kind: string;
    to: string | null;
    subject: string;
    body: string;
    note?: string | null;
  },
  deps: CustomerEmailDeps
): Promise<NotificationRecord | null> {
  const existing = await store.getNotification(caseId, input.kind);
  if (existing) return existing;

  const env = deps.env ?? process.env;
  const sender = deps.sender ?? createEmailSender(env);

  if (!isEmailAddress(input.to)) {
    return store.createNotification({
      caseId,
      channel: "email",
      kind: input.kind,
      toPhone: input.to ?? "",
      body: `${input.subject}\n\n${input.body}`,
      status: "skipped",
      provider: sender.name,
      note: "No customer email on the case — the email was owed but had nowhere to go."
    });
  }

  const row = await store.createNotification({
    caseId,
    channel: "email",
    kind: input.kind,
    toPhone: input.to,
    body: `${input.subject}\n\n${input.body}`,
    status: "queued",
    provider: sender.name,
    note: input.note ?? null
  });
  if (!row) {
    // A concurrent trigger recorded it first; that row is the record.
    return store.getNotification(caseId, input.kind);
  }
  try {
    const result = await sender.send({
      to: input.to,
      subject: input.subject,
      body: input.body
    });
    return store.updateNotification(row.id, {
      status: "sent",
      provider: sender.name,
      providerMessageId: result.providerMessageId,
      sentAt: new Date().toISOString()
    });
  } catch (err) {
    // Keep the machine-readable code (e.g. EMAIL_NOT_CONFIGURED) in
    // the recorded error alongside the human message, so staff tooling
    // can group failures without string-matching prose.
    const code = (err as { code?: unknown })?.code;
    const raw = err instanceof Error ? err.message : String(err);
    const message = typeof code === "string" && code ? `${code}: ${raw}` : raw;
    console.error(
      `customer email failed for case ${caseId} (${input.kind}): ${message}`
    );
    return store.updateNotification(row.id, {
      status: "failed",
      provider: sender.name,
      error: message
    });
  }
}

/** A fresh sign link for the case's live quote, or null when no web base is configured. */
async function signUrlForQuote(
  store: CaseStore,
  caseId: string,
  env: Record<string, string | undefined>
): Promise<{ url: string | null; note: string | null }> {
  const base = webBaseUrl(env);
  if (!base) {
    return {
      url: null,
      note: "WEB_BASE_URL is not set, so the email carried no sign link."
    };
  }
  const c = await store.getCase(caseId);
  const quote = await store.getLatestQuote(caseId);
  if (!c || !quote) return { url: null, note: null };
  const ttlSeconds = Math.floor(
    (Date.parse(quote.expires_at) - Date.now()) / 1000
  );
  if (ttlSeconds <= 0) return { url: null, note: "Quote already expired." };
  const minted = await mintApprovalToken(store, {
    caseId,
    channel: c.channel,
    purpose: "quote-approval",
    ttlSeconds
  });
  return { url: `${base}/quote/${minted.token}`, note: null };
}

/**
 * Emails the case's current quote to the customer, once per quote
 * version. No-op (null) when there is no live unsigned SENT quote —
 * a signed quote's email is moot, and a superseded version's was
 * already handled when it was live.
 */
export async function dispatchQuoteEmail(
  store: CaseStore,
  caseId: string,
  deps: CustomerEmailDeps = {}
): Promise<NotificationRecord | null> {
  const c = await store.getCase(caseId);
  if (!c) return null;
  const quote = await store.getLatestQuote(caseId);
  if (!quote || quote.status !== "SENT" || quote.signature) return null;
  const env = deps.env ?? process.env;
  const contact = await customerContactForCase(store, caseId);
  const { url, note } = await signUrlForQuote(store, caseId, env);
  const composed = composeQuoteEmail({
    firstName: firstName(contact.name),
    reference: c.reference,
    totalCents: quote.snapshot.sell_price_cents,
    expiresAt: quote.expires_at,
    signUrl: url
  });
  return recordAndSend(
    store,
    caseId,
    {
      kind: `${QUOTE_EMAIL_KIND_PREFIX}${quote.version}`,
      to: contact.email,
      subject: composed.subject,
      body: composed.body,
      note
    },
    deps
  );
}

/**
 * Emails the case's invoice to the customer, once per invoice
 * version. Called wherever an invoice is generated (staff action and
 * the public sign flow) — generation is the trigger (Nelly,
 * 2026-11-23). The email carries a fresh 30-day tracking link, where
 * the customer can view and download the invoice PDF.
 */
export async function dispatchInvoiceEmail(
  store: CaseStore,
  caseId: string,
  deps: CustomerEmailDeps = {}
): Promise<NotificationRecord | null> {
  const c = await store.getCase(caseId);
  if (!c) return null;
  const invoice = await store.getLatestInvoice(caseId);
  if (!invoice) return null;
  const env = deps.env ?? process.env;
  const contact = await customerContactForCase(store, caseId);
  const base = webBaseUrl(env);
  let trackingUrl: string | null = null;
  let note: string | null = null;
  if (base) {
    const minted = await mintApprovalToken(store, {
      caseId,
      channel: c.channel,
      purpose: "case-view",
      ttlSeconds: 30 * 24 * 3600
    });
    trackingUrl = `${base}/track/${minted.token}`;
  } else {
    note = "WEB_BASE_URL is not set, so the email carried no tracking link.";
  }
  const composed = composeInvoiceEmail({
    firstName: firstName(contact.name),
    reference: c.reference,
    totalCents: invoice.actuals.sell_price_cents,
    trackingUrl
  });
  return recordAndSend(
    store,
    caseId,
    {
      kind: `${INVOICE_EMAIL_KIND_PREFIX}${invoice.version}`,
      to: contact.email,
      subject: composed.subject,
      body: composed.body,
      note
    },
    deps
  );
}

export interface QuoteReminderSummary {
  /** Cases whose live quote was examined. */
  examined: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Cases where a reminder was due but the max (4) was already reached. */
  capped: number;
}

/**
 * Sends the 24h reminders for every unsigned, unexpired quote.
 * Cadence is anchored on the quote's creation, then on each
 * reminder attempt: reminder k is due 24h after the previous attempt.
 * Each slot is attempted exactly once (a failed attempt is recorded
 * and spent, never retried in a storm), and nothing is sent once the
 * quote is signed, superseded, declined or expired. Intended to be called hourly by the scheduled workflow
 * (POST /api/v1/jobs/quote-reminders) — the 24h rule lives here, the
 * schedule is just a trigger.
 */
export async function processQuoteReminders(
  store: CaseStore,
  deps: CustomerEmailDeps = {}
): Promise<QuoteReminderSummary> {
  const now = (deps.now ? deps.now() : new Date()).getTime();
  const env = deps.env ?? process.env;
  const summary: QuoteReminderSummary = {
    examined: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    capped: 0
  };
  const cases = await store.listCases();
  for (const c of cases) {
    const quote = await store.getLatestQuote(c.id);
    if (!quote || quote.status !== "SENT" || quote.signature) continue;
    if (Date.parse(quote.expires_at) <= now) continue;
    summary.examined += 1;

    // Which reminder slots for this version are already spent. A
    // slot is spent by ANY recorded attempt (sent, failed or
    // skipped): each slot is attempted exactly once, the failure is
    // the audit record, and the cadence anchors on the last attempt —
    // so a broken provider can never turn into an hourly retry storm,
    // and the next slot still arrives 24h later.
    let sentCount = 0;
    let lastSentAt = Date.parse(quote.created_at);
    for (let k = 1; k <= MAX_QUOTE_REMINDERS; k++) {
      const row = await store.getNotification(
        c.id,
        `${QUOTE_REMINDER_KIND_PREFIX}${quote.version}_${k}`
      );
      if (row) {
        sentCount = k;
        lastSentAt = Math.max(lastSentAt, Date.parse(row.created_at));
      }
    }
    if (sentCount >= MAX_QUOTE_REMINDERS) {
      summary.capped += 1;
      continue;
    }
    if (now - lastSentAt < REMINDER_INTERVAL_MS) continue;

    const contact = await customerContactForCase(store, c.id);
    const { url, note } = await signUrlForQuote(store, c.id, env);
    const composed = composeQuoteReminderEmail({
      firstName: firstName(contact.name),
      reference: c.reference,
      totalCents: quote.snapshot.sell_price_cents,
      expiresAt: quote.expires_at,
      signUrl: url,
      reminderNumber: sentCount + 1
    });
    const row = await recordAndSend(
      store,
      c.id,
      {
        kind: `${QUOTE_REMINDER_KIND_PREFIX}${quote.version}_${sentCount + 1}`,
        to: contact.email,
        subject: composed.subject,
        body: composed.body,
        note
      },
      deps
    );
    if (!row) continue;
    if (row.status === "sent") summary.sent += 1;
    else if (row.status === "failed") summary.failed += 1;
    else if (row.status === "skipped") summary.skipped += 1;
  }
  return summary;
}
