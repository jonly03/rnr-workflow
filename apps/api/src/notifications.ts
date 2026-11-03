import { mintApprovalToken } from "./approval-tokens.js";
import { createSmsSender, normalizePhoneE164, type SmsSender } from "./sms.js";
import type { CaseStore } from "./store.js";
import type { NotificationRecord } from "./types.js";

/**
 * Client notifications — today exactly one kind: the job-completion
 * text (Nelly, 2026-11-03). When service completes, the client gets a
 * text to the phone they provided at intake, carrying their tracking
 * link and the ask for a Google review (the tracker page itself shows
 * the same review link once the job is complete — see the review_url
 * field of the public tracking projection in app.ts).
 *
 * Law:
 *  - Exactly once per case: the notifications table is unique on
 *    (case_id, kind) and this function returns the existing row
 *    untouched when one is already recorded.
 *  - Delivery failure NEVER fails completion: the send is attempted
 *    after the row is recorded, and any error is written onto the row
 *    (status "failed") instead of being thrown.
 *  - No phone on the case → the row is recorded as "skipped" with the
 *    reason in its note, so staff can see the text was owed and why it
 *    did not go out.
 *
 * Tracker link: approval tokens are stored HASHED (approval-tokens.ts)
 * — an earlier tracking link can never be re-read or re-sent. So when
 * the text actually goes out, a fresh 30-day case-view token is minted
 * for it (the same thing staff "re-issue tracking link" does), and the
 * notification's note records that this happened and whether an
 * earlier link was already active. Nothing is minted for a text that
 * cannot be sent.
 */

export const JOB_COMPLETED_KIND = "job_completed";

/** R&R's Google review link (the GBP review shortlink). */
export const DEFAULT_GOOGLE_REVIEW_URL = "https://g.page/r/CZOjkKSvodOTEBM/review";

export function googleReviewUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const fromEnv = env.GOOGLE_REVIEW_URL?.trim();
  return fromEnv ? fromEnv : DEFAULT_GOOGLE_REVIEW_URL;
}

/**
 * Public origin of the web app (e.g. https://rnr-case-web.vercel.app),
 * used to build absolute links for texts. Null when unconfigured — the
 * completion text then carries the review link only, and its note says
 * why.
 */
export function webBaseUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const fromEnv = env.WEB_BASE_URL?.trim().replace(/\/+$/, "");
  return fromEnv ? fromEnv : null;
}

export interface ClientContact {
  name: string | null;
  phone: string | null;
}

/**
 * The client's name + phone, read defensively from the intake event —
 * the same source job-execution's jobClientInfo reads. Duplicated here
 * deliberately: job-execution imports lifecycle, lifecycle imports this
 * module, so importing job-execution back would close a cycle.
 * Staff-created cases have no intake event → both fields null.
 */
export async function clientContactForCase(
  store: CaseStore,
  caseId: string
): Promise<ClientContact> {
  const events = await store.getEvents(caseId);
  const intake = [...events]
    .reverse()
    .find(e => e.event_type === "CLIENT_INTAKE_SUBMITTED");
  if (!intake) return { name: null, phone: null };
  const payload = intake.payload ?? {};
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    name: str(payload.customer_name),
    phone: str(payload.customer_phone)
  };
}

export function composeJobCompletedBody(input: {
  firstName: string | null;
  trackerUrl: string | null;
  reviewUrl: string;
}): string {
  const greeting = input.firstName ? `Hi ${input.firstName}` : "Hi there";
  const parts = [
    `${greeting}, R&R Finest Auto Glass here — your glass service is complete! 🎉`
  ];
  if (input.trackerUrl) parts.push(`Track your job: ${input.trackerUrl}`);
  parts.push(`Happy with our work? Leave us a Google review: ${input.reviewUrl}`);
  parts.push("Thank you!");
  return parts.join(" ");
}

export interface NotifyJobCompletedDeps {
  sender?: SmsSender;
  env?: Record<string, string | undefined>;
}

/**
 * Records + sends the job-completion text for a case. Returns the
 * notification row (existing, sent, failed, or skipped) or null when
 * the case does not exist. Never throws for delivery problems.
 */
export async function notifyJobCompleted(
  store: CaseStore,
  caseId: string,
  deps: NotifyJobCompletedDeps = {}
): Promise<NotificationRecord | null> {
  const env = deps.env ?? process.env;
  const sender = deps.sender ?? createSmsSender(env);

  const existing = await store.getNotification(caseId, JOB_COMPLETED_KIND);
  if (existing) return existing;

  const caseRecord = await store.getCase(caseId);
  if (!caseRecord) return null;

  const contact = await clientContactForCase(store, caseId);
  const reviewUrl = googleReviewUrl(env);
  const firstName = contact.name
    ? (contact.name.split(/\s+/)[0] ?? null)
    : null;
  const toPhone = normalizePhoneE164(contact.phone);

  if (!toPhone) {
    // Nothing can be sent — record the debt + the reason. No tracker
    // token is minted for a text that will never go out.
    const body = composeJobCompletedBody({ firstName, trackerUrl: null, reviewUrl });
    return store.createNotification({
      caseId,
      channel: "sms",
      kind: JOB_COMPLETED_KIND,
      toPhone: contact.phone ?? "",
      body,
      status: "skipped",
      provider: sender.name,
      note: contact.phone
        ? "Client phone could not be normalized to a textable number — text not sent."
        : "No client phone on the case (no intake contact) — text not sent."
    });
  }

  // A fresh case-view token for this text: earlier tokens are stored
  // hashed and cannot be re-sent (see the module header). 30 days, the
  // same lifetime as the link handed out at signing.
  const priorLink = await store.findApprovalTokenForCase(caseId, "case-view");
  const minted = await mintApprovalToken(store, {
    caseId,
    channel: caseRecord.channel,
    purpose: "case-view",
    ttlSeconds: 30 * 24 * 3600
  });
  const base = webBaseUrl(env);
  const trackerUrl = base ? `${base}/track/${minted.token}` : null;
  const note = trackerUrl
    ? priorLink
      ? "Tracker link minted at completion (approval tokens are stored hashed, so the earlier link could not be re-sent); an earlier tracking link was already active."
      : "Tracker link minted at completion; no earlier tracking link was active."
    : "Tracker link omitted from the text: WEB_BASE_URL is not configured.";

  const body = composeJobCompletedBody({ firstName, trackerUrl, reviewUrl });
  const queued = await store.createNotification({
    caseId,
    channel: "sms",
    kind: JOB_COMPLETED_KIND,
    toPhone,
    body,
    status: "queued",
    provider: sender.name,
    note
  });
  if (!queued) {
    // Lost a race with a duplicate completion — the row that won is
    // the record; do not send a second text.
    return store.getNotification(caseId, JOB_COMPLETED_KIND);
  }

  try {
    const result = await sender.send({ to: toPhone, body });
    return await store.updateNotification(queued.id, {
      status: "sent",
      provider: sender.name,
      providerMessageId: result.providerMessageId,
      sentAt: new Date().toISOString()
    });
  } catch (error) {
    return await store.updateNotification(queued.id, {
      status: "failed",
      provider: sender.name,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
