import { randomUUID } from "node:crypto";

/**
 * SMS sending seam — the completion-text counterpart of the Slice B
 * asset-storage seam (asset-storage.ts). Domain code talks to the
 * SmsSender interface only; the driver is selected by env:
 *
 *  - `mock`  — the default everywhere. Records nothing itself (the
 *              notifications table is the record) but logs the message
 *              and reports success with a synthetic id, so the whole
 *              completion flow runs end-to-end with no provider.
 *  - `twilio`— plain fetch against Twilio's Messages API (no SDK, no
 *              new dependencies). COMPLETE BUT INERT until
 *              TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN +
 *              TWILIO_FROM_NUMBER are all set: without them the
 *              factory falls back to the mock driver and says so, so a
 *              half-configured deploy can never silently "send" into
 *              the void — health reports the EFFECTIVE driver name.
 */

export interface SmsMessage {
  /** E.164 destination, e.g. +16175550123. */
  to: string;
  body: string;
}

export interface SmsSendResult {
  providerMessageId: string;
}

export interface SmsSender {
  /** "mock" | "twilio" — a name, never a credential. Health reports it. */
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

type FetchLike = (
  url: string,
  init?: Record<string, unknown>
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as ReturnType<FetchLike>;

/**
 * Normalizes a client-provided phone to E.164. Intake validates 10-digit
 * US numbers, so the common path is 10 digits → +1…; an 11-digit number
 * already carrying the country code, or an explicit +…, also passes.
 * Anything else returns null — the caller records the text as skipped
 * rather than guessing at a number.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

class MockSmsSender implements SmsSender {
  readonly name = "mock";
  async send(message: SmsMessage): Promise<SmsSendResult> {
    const providerMessageId = `mock-${randomUUID()}`;
    console.log(
      `[sms:mock] to=${message.to} id=${providerMessageId} body=${JSON.stringify(message.body)}`
    );
    return { providerMessageId };
  }
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function loadTwilioConfig(
  env: Record<string, string | undefined>
): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = env.TWILIO_FROM_NUMBER?.trim();
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

class TwilioSmsSender implements SmsSender {
  readonly name = "twilio";
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: FetchLike = defaultFetch
  ) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const { accountSid, authToken, fromNumber } = this.config;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const basic = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
    const form = new URLSearchParams({
      To: message.to,
      From: fromNumber,
      Body: message.body
    });
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail =
        (data && typeof data.message === "string" && data.message) ||
        `HTTP ${res.status}`;
      const code = data && data.code ? ` (Twilio code ${data.code})` : "";
      throw new Error(`Twilio send failed: ${detail}${code}`);
    }
    const sid = data && typeof data.sid === "string" ? data.sid : null;
    if (!sid) throw new Error("Twilio send failed: response carried no message sid.");
    return { providerMessageId: sid };
  }
}

/**
 * Builds the sender for this process. SMS_PROVIDER selects the driver;
 * "twilio" without full credentials falls back to mock with a loud
 * warning (health then reports "mock" — the mismatch is the signal).
 */
export function createSmsSender(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike
): SmsSender {
  const wanted = (env.SMS_PROVIDER ?? "mock").trim().toLowerCase();
  if (wanted === "twilio") {
    const config = loadTwilioConfig(env);
    if (config) return new TwilioSmsSender(config, fetchImpl);
    console.warn(
      "[sms] SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / " +
        "TWILIO_FROM_NUMBER are not all set — falling back to the mock driver. " +
        "No real texts will be sent."
    );
    return new MockSmsSender();
  }
  if (wanted !== "mock") {
    console.warn(`[sms] Unknown SMS_PROVIDER "${wanted}" — using the mock driver.`);
  }
  return new MockSmsSender();
}
