import type {
  AvailabilityWindow,
  CaseAsset,
  CaseEvent,
  CaseJobView,
  CaseRecord,
  Channel,
  GlassType,
  Invoice,
  InvoicePaymentStatus,
  JobAssignment,
  JobLocationPing,
  JobStep,
  Operator,
  OpsMapView,
  OperatorInviteView,
  ScheduleBoardEntry,
  SchedulerProposal,
  TechJob,
  TechProfile
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001/api/v1";

const TOKEN_KEY = "rnr_staff_token";

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable; session only
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
    this.name = "UnauthorizedError";
  }
}

/** An API failure with the machine-readable bits the UI needs —
 *  notably `field`, so a form can pin the error to its input. */
export class ApiError extends Error {
  code?: string;
  field?: string;
  constructor(message: string, extras: { code?: string; field?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = extras.code;
    this.field = extras.field;
  }
}

async function json<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    clearToken();
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body?.error?.message ?? `Request failed: ${response.status}`, {
      code: body?.error?.code,
      field: body?.error?.details?.field
    });
  }
  return response.json();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

export interface StaffCaseEventMessage {
  type: "case_event" | "sync" | "ready";
  case_id?: string;
  event_type?: string;
  occurred_at?: string;
  sequence?: number;
}

export type StaffEventsStatus = "live" | "reconnecting";

/**
 * Where the staff realtime socket lives:
 * - API_BASE absolute (local dev): the API server itself serves
 *   /api/v1/staff/events on that origin.
 * - API_BASE relative (deployed): the web project's own function
 *   serves /api/staff-events on this origin (same origin as the page,
 *   fed by the shared Postgres LISTEN/NOTIFY bus).
 * The staff JWT rides as a query param — browsers cannot set headers
 * on a WebSocket handshake.
 */
export function staffEventsSocketUrl(): string | null {
  const token = getToken();
  if (!token) return null;
  const query = `token=${encodeURIComponent(token)}`;
  if (/^https?:\/\//.test(API_BASE)) {
    const wsOrigin = new URL(API_BASE).origin.replace(/^http/, "ws");
    return `${wsOrigin}/api/v1/staff/events?${query}`;
  }
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${window.location.host}/api/staff-events?${query}`;
}

/**
 * Subscribe to live case events for the staff dashboard. Reconnects
 * with backoff (sockets die at the function max duration on Vercel),
 * refetches via a "sync" event on every (re)connect so nothing is
 * missed, and falls back to a 10s sync poll while the socket is down
 * — still better than the old manual refresh. Returns an unsubscribe.
 */
export function subscribeStaffEvents(handlers: {
  onEvent: (message: StaffCaseEventMessage) => void;
  onStatus: (status: StaffEventsStatus) => void;
}): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryMs = 1000;
  let retryTimer: number | undefined;
  let pollTimer: number | undefined;

  const startPolling = () => {
    if (pollTimer !== undefined) return;
    pollTimer = window.setInterval(
      () => handlers.onEvent({ type: "sync" }),
      10_000
    );
  };
  const stopPolling = () => {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };
  const scheduleRetry = () => {
    if (stopped) return;
    retryTimer = window.setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  };
  const connect = () => {
    if (stopped) return;
    handlers.onStatus("reconnecting");
    const url = staffEventsSocketUrl();
    if (!url) {
      startPolling();
      scheduleRetry();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      startPolling();
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as StaffCaseEventMessage;
        if (parsed?.type === "ready") {
          // The server sends "ready" only AFTER its event subscription
          // is armed — that, not the bare handshake, is the moment the
          // feed is truly live. Catch up on anything missed meanwhile.
          retryMs = 1000;
          stopPolling();
          handlers.onStatus("live");
          handlers.onEvent({ type: "sync" });
        } else if (parsed?.type === "case_event") {
          handlers.onEvent(parsed);
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (!stopped) {
        handlers.onStatus("reconnecting");
        startPolling();
        scheduleRetry();
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // onclose handles the rest.
      }
    };
  };

  connect();
  return () => {
    stopped = true;
    stopPolling();
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
}

export interface HealthStatus {
  ok: boolean;
  storage: string;
  glass_catalog: string;
}

/** Public endpoint; returns null when unreachable. Never throws. */
export async function getHealth(): Promise<HealthStatus | null> {
  try {
    // NOTE: keep this under /api/v1 so it goes through the web app's
    // same-origin API proxy on staging/production. Fetching /health on the
    // web origin would return the SPA shell instead of the API.
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) return null;
    return (await response.json()) as HealthStatus;
  } catch {
    return null;
  }
}

export async function login(email: string, password: string): Promise<StaffUser> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? "Sign in failed.");
  }
  const data = await response.json();
  setToken(data.token);
  return data.staff as StaffUser;
}

export function logout() {
  clearToken();
}

export function getMe(): Promise<{ staff: StaffUser }> {
  return fetch(`${API_BASE}/auth/me`, { headers: authHeaders() }).then(json<{
    staff: StaffUser;
  }>);
}

export interface CreateCaseInput {
  channel: Channel;
  vehicle: {
    year: number;
    make: string;
    model: string;
    vin: string;
  };
  glass_request: {
    glass_type: GlassType;
  };
}

export function listCases() {
  return fetch(`${API_BASE}/cases`, { headers: authHeaders() }).then(
    json<CaseRecord[]>
  );
}

export function getCase(id: string) {
  return fetch(`${API_BASE}/cases/${id}`, { headers: authHeaders() }).then(
    json<CaseRecord>
  );
}

export function getCaseEvents(id: string) {
  return fetch(`${API_BASE}/cases/${id}/events`, { headers: authHeaders() }).then(
    json<CaseEvent[]>
  );
}

export function performAction(
  caseId: string,
  action: string,
  extra: Record<string, unknown> = {}
) {
  return fetch(`${API_BASE}/cases/${caseId}/actions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ action, ...extra })
  }).then(json<CaseRecord>);
}

/** One row of the staff collections board: a case's latest invoice
 *  version plus the case context staff triage by. */
export interface InvoiceBoardItem extends Invoice {
  case_reference: string;
  case_state: string;
  channel: Channel;
  vehicle: { year: number; make: string; model: string } | null;
  glass_type: string | null;
  bill_to: string | null;
  awaiting_payment: boolean;
}

/** The collections board, ordered server-side for collections work. */
export function listInvoices(paymentStatus?: InvoicePaymentStatus) {
  const query = paymentStatus ? `?payment_status=${paymentStatus}` : "";
  return fetch(`${API_BASE}/invoices${query}`, { headers: authHeaders() }).then(
    json<InvoiceBoardItem[]>
  );
}

/** Downloads the case's invoice PDF (client projection) as a file. */
export async function downloadInvoicePdf(caseId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/cases/${caseId}/invoice.pdf`, {
    headers: authHeaders()
  });
  if (response.status === 401) {
    clearToken();
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`Could not download the invoice PDF (${response.status}).`);
  }
  const blob = await response.blob();
  const filename =
    /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
    "invoice.pdf";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface DecodedVehicle {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  bodyClass: string;
}

export function decodeVin(vin: string) {
  return fetch(`${API_BASE}/vin/decode`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ vin })
  }).then(json<{ vin: string; vehicle: DecodedVehicle }>);
}

const OCR_FETCH_TIMEOUT_MS = 90_000;
/** Full-res phone photos carry 6-12x the pixels OCR needs — downscale first. */
const OCR_MAX_DIMENSION = 1600;
/**
 * Photos scoring below this Laplacian variance are too blurry for OCR.
 * Kept conservative: a false reject blocks a readable photo, while a
 * missed blurry one just takes the old slow path. Tune if field data
 * says otherwise.
 */
export const OCR_BLUR_VARIANCE_THRESHOLD = 60;
/** Sharpness is measured on a small thumbnail — cheaper, still effective. */
const SHARPNESS_SAMPLE_WIDTH = 400;

/**
 * Photo too blurry for OCR. Thrown before any upload so a hopeless
 * photo fails in under a second instead of spinning toward the 60s
 * server timeout. Nothing is uploaded or stored.
 */
export class PhotoBlurryError extends Error {
  readonly sharpness: number;
  constructor(sharpness: number) {
    super(
      "That photo looks too blurry to read. Hold steady, tap the VIN to " +
        "focus, and try again — or type the VIN manually."
    );
    this.name = "PhotoBlurryError";
    this.sharpness = sharpness;
  }
}

/** Luminosity grayscale from RGBA pixel data. Pure — unit-testable. */
export function toGrayscale(data: Uint8ClampedArray): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round(
      0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    );
  }
  return gray;
}

/**
 * Variance of the Laplacian over a grayscale image: sharp edges score
 * high, smooth blur scores near zero. Pure — unit-testable.
 */
export function laplacianVariance(
  gray: Uint8ClampedArray,
  width: number,
  height: number
): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap =
        gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Percentile contrast stretch: maps the 2nd–98th percentile range to
 * 0–255. Kills haze/glare washout while ignoring outlier pixels.
 * Pure — unit-testable.
 */
export function contrastStretch(gray: Uint8ClampedArray): Uint8ClampedArray {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let acc = 0;
  let lo = 0;
  for (let t = 0; t < 256; t++) {
    acc += hist[t];
    if (acc >= total * 0.02) {
      lo = t;
      break;
    }
  }
  acc = 0;
  let hi = 255;
  for (let t = 255; t >= 0; t--) {
    acc += hist[t];
    if (acc >= total * 0.02) {
      hi = t;
      break;
    }
  }
  const out = new Uint8ClampedArray(gray.length);
  if (hi <= lo) {
    out.set(gray);
    return out;
  }
  const scale = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round((gray[i] - lo) * scale);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/**
 * Otsu's method: the global threshold that best separates dark text
 * from a light background. Erases light watermarks/security patterns
 * that sit between text-dark and background-light. Pure — unit-testable.
 */
export function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Prepare a photo for OCR entirely on-device: downscale, fail fast on
 * blur, then grayscale → contrast stretch → Otsu binarize (with
 * polarity fix so Tesseract always sees dark text on light).
 * The photo is never stored — the processed pixels are uploaded for
 * one OCR attempt and discarded by the API after recognition.
 * Falls back to the original file when the browser can't process it.
 */
async function preparePhotoForOcr(file: File): Promise<File | Blob> {
  try {
    if (typeof createImageBitmap !== "function") return file;
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image"
    });
    try {
      const scale = Math.min(
        1,
        OCR_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height)
      );
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, w, h);

      // 1. Fail fast on blur — measured on a small thumbnail, before upload.
      const longSide = Math.max(w, h);
      const sw = Math.max(1, Math.round((w * SHARPNESS_SAMPLE_WIDTH) / longSide));
      const sh = Math.max(1, Math.round((h * SHARPNESS_SAMPLE_WIDTH) / longSide));
      const sample = document.createElement("canvas");
      sample.width = sw;
      sample.height = sh;
      const sctx = sample.getContext("2d");
      if (!sctx) return file;
      sctx.drawImage(canvas, 0, 0, sw, sh);
      const sampleData = sctx.getImageData(0, 0, sw, sh);
      const sharpness = laplacianVariance(toGrayscale(sampleData.data), sw, sh);
      if (sharpness < OCR_BLUR_VARIANCE_THRESHOLD) {
        throw new PhotoBlurryError(sharpness);
      }

      // 2. Preprocess for Tesseract: grayscale → contrast → binarize.
      const imageData = ctx.getImageData(0, 0, w, h);
      const stretched = contrastStretch(toGrayscale(imageData.data));
      const threshold = otsuThreshold(stretched);
      const out = ctx.createImageData(w, h);
      let dark = 0;
      for (let i = 0, j = 0; i < stretched.length; i++, j += 4) {
        const v = stretched[i] < threshold ? 0 : 255;
        if (v === 0) dark++;
        out.data[j] = v;
        out.data[j + 1] = v;
        out.data[j + 2] = v;
        out.data[j + 3] = 255;
      }
      // VIN text is sparse: mostly-dark means light-on-dark plate → invert.
      if (dark > stretched.length / 2) {
        for (let j = 0; j < out.data.length; j += 4) {
          const v = 255 - out.data[j];
          out.data[j] = v;
          out.data[j + 1] = v;
          out.data[j + 2] = v;
        }
      }
      ctx.putImageData(out, 0, 0);

      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, "image/jpeg", 0.9)
      );
      if (!blob) return file;
      return new File([blob], file.name.replace(/\.[^.]*$/, "") + ".jpg", {
        type: "image/jpeg"
      });
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if (error instanceof PhotoBlurryError) throw error;
    return file;
  }
}

export function ocrVinPhoto(photo: File) {
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCR_FETCH_TIMEOUT_MS);
  return preparePhotoForOcr(photo)
    .then(upload => {
      const form = new FormData();
      form.append("photo", upload);
      return fetch(`${API_BASE}/vin/ocr`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
        signal: controller.signal
      });
    })
    .then(json<{ vin: string }>)
    .catch(err => {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          "Photo read timed out. Try a clearer photo or type the VIN manually."
        );
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

/** A customer link minted server-side. The raw token is returned exactly
 *  once; staff copy `path` onto the app origin and send it to the customer. */
export interface CustomerLink {
  token: string;
  purpose: string;
  expires_at: string;
  path: string;
}

export function createQuoteLink(caseId: string) {
  return fetch(`${API_BASE}/cases/${caseId}/quote-link`, {
    method: "POST",
    headers: authHeaders()
  }).then(json<CustomerLink>);
}

export function createTrackingLink(caseId: string) {
  return fetch(`${API_BASE}/cases/${caseId}/tracking-link`, {
    method: "POST",
    headers: authHeaders()
  }).then(json<CustomerLink>);
}

export interface PublicQuoteView {
  reference: string;
  channel: string;
  noun: string;
  vehicle: { year: number; make: string; model: string };
  glass_type: string;
  labor_cents: number;
  tax_cents: number;
  total_cents: number;
  quote_version: number;
  expires_at: string;
  status: "AWAITING_SIGNATURE" | "APPROVED" | "DECLINED" | "EXPIRED";
  signed_by: string | null;
  signed_at: string | null;
  /** "typed" signatures render as the name in a signature style; the drawn
   *  image itself is staff-only and never part of this projection. */
  signature_method: "typed" | "drawn" | null;
}

export function getPublicQuote(token: string) {
  return fetch(`${API_BASE}/public/quote/${token}`).then(json<PublicQuoteView>);
}

export function signPublicQuote(
  token: string,
  input: { name: string; signature_data_url?: string }
) {
  return fetch(`${API_BASE}/public/quote/${token}/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  }).then(
    json<{ ok: boolean; status: string; invoice_version: number; tracking_token: string }>
  );
}

export function declinePublicQuote(token: string) {
  return fetch(`${API_BASE}/public/quote/${token}/decline`, {
    method: "POST"
  }).then(json<{ ok: boolean; status: string }>);
}

export interface TrackingMilestone {
  key: string;
  label: string;
  done: boolean;
  at: string | null;
  detail: string | null;
}

export interface PublicTrackingView {
  reference: string;
  channel: string;
  vehicle: { year: number; make: string; model: string } | null;
  glass_type: string | null;
  status: string;
  current_state: string;
  signed_by: string | null;
  signed_at: string | null;
  signature_method: "typed" | "drawn" | null;
  invoice: {
    version: number;
    total_cents: number;
    /** Summary-level payment state; null until the invoice is sent. */
    payment: { status: string; label: string } | null;
  } | null;
  labor_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  milestones: TrackingMilestone[];
  /** Slice C: an estimated arrival window while the tech is en route
   *  ("about 15–25 min") — an estimate computed server-side, never
   *  coordinates. Null whenever there is nothing honest to show. */
  eta: { label: string; minutes_low: number; minutes_high: number } | null;
}

export function getPublicTracking(token: string) {
  return fetch(`${API_BASE}/public/track/${token}`).then(json<PublicTrackingView>);
}

/** Direct URL of the client's own invoice file behind their tracking
 *  link (the server 404s it until the invoice has been sent). */
export function publicInvoicePdfUrl(token: string) {
  return `${API_BASE}/public/track/${token}/invoice.pdf`;
}

export interface PublicIntakeConfirmation {
  ok: boolean;
  reference: string;
  message: string;
  status_token: string;
}

/**
 * Public client intake (QR front door): the customer submits the form
 * (fields + optional photos) as multipart FormData. No auth — the API
 * answers with a client-safe confirmation only (reference + next steps).
 */
export function submitPublicIntake(form: FormData) {
  return fetch(`${API_BASE}/public/intake`, {
    method: "POST",
    body: form
  }).then(json<PublicIntakeConfirmation>);
}

/**
 * A real address as returned by the geocoder proxy — the only kind of
 * address the intake accepts. The customer picks one of these; the
 * structured fields (with the provider place id) are what get stored.
 */
export interface AddressSuggestion {
  place_id: string;
  formatted: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number;
  lon: number;
}

/**
 * Address suggestions for the intake contact card (public, no auth).
 * The API proxies the geocoder server-side; the UI only ever shows
 * what comes back here.
 */
export function suggestAddresses(query: string) {
  return fetch(
    `${API_BASE}/public/address/suggest?q=${encodeURIComponent(query)}`
  ).then(json<{ suggestions: AddressSuggestion[] }>);
}

export interface IntakeStatusStep {
  key: string;
  label: string;
  done: boolean;
}

/**
 * Client-safe live progress for an intake case, behind the view-only
 * status token from the intake confirmation. Phases and step labels
 * only — prices live on the quote page, never here.
 */
export interface PublicIntakeStatus {
  reference: string;
  vehicle: { year: number; make: string; model: string } | null;
  glass_type: string | null;
  phase: string;
  headline: string;
  steps: IntakeStatusStep[];
  quote_ready: boolean;
}

export function getPublicIntakeStatus(statusToken: string) {
  return fetch(`${API_BASE}/public/intake-status/${statusToken}`).then(
    json<PublicIntakeStatus>
  );
}

/** Mints the customer's sign link from their intake status token. */
export function createIntakeQuoteLink(statusToken: string) {
  return fetch(`${API_BASE}/public/intake-status/${statusToken}/quote-link`, {
    method: "POST"
  }).then(json<{ path: string; expires_at: string }>);
}

// ---------------------------------------------------------------------
// Operators + scheduling (Slice A). All staff-authenticated; the API
// enforces the role law (admin/owner manage, staff schedule, techs see
// only /operators/me).
// ---------------------------------------------------------------------

/** Whether Google Sign-In is configured on this deployment. The sign-in
 *  button/invite flows render only when this reports enabled. */
export async function getGoogleConfig(): Promise<{ enabled: boolean }> {
  try {
    const response = await fetch(`${API_BASE}/auth/google/config`);
    if (!response.ok) return { enabled: false };
    return (await response.json()) as { enabled: boolean };
  } catch {
    return { enabled: false };
  }
}

/** Absolute URL that starts the Google flow (optionally accepting an invite). */
export function googleStartUrl(inviteCredential?: string): string {
  const base = `${API_BASE}/auth/google/start`;
  return inviteCredential
    ? `${base}?invite=${encodeURIComponent(inviteCredential)}`
    : base;
}

export interface OperatorsResponse {
  operators: Operator[];
  invites: OperatorInviteView[];
}

export function listOperators() {
  return fetch(`${API_BASE}/operators`, { headers: authHeaders() }).then(
    json<OperatorsResponse>
  );
}

export function inviteOperator(email: string) {
  return fetch(`${API_BASE}/operators/invites`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ email })
  }).then(json<{ invite: OperatorInviteView; invite_path: string; credential: string }>);
}

export function revokeInvite(inviteId: string) {
  return fetch(`${API_BASE}/operators/invites/${inviteId}`, {
    method: "DELETE",
    headers: authHeaders()
  }).then(json<{ ok: boolean }>);
}

export function verifyOperator(
  userId: string,
  input: { qualifications?: string[]; availability?: AvailabilityWindow[] }
) {
  return fetch(`${API_BASE}/operators/${userId}/verify`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input)
  }).then(json<{ operator: Operator }>);
}

export function deactivateOperator(userId: string) {
  return fetch(`${API_BASE}/operators/${userId}/deactivate`, {
    method: "POST",
    headers: authHeaders()
  }).then(json<{ operator: Operator }>);
}

export function reactivateOperator(userId: string) {
  return fetch(`${API_BASE}/operators/${userId}/reactivate`, {
    method: "POST",
    headers: authHeaders()
  }).then(json<{ operator: Operator }>);
}

export function updateOperatorProfile(
  userId: string,
  patch: {
    phone?: string | null;
    home_base?: string | null;
    service_area?: string | null;
    qualifications?: string[];
    availability?: AvailabilityWindow[];
    live_status?: "AVAILABLE" | "OFF";
  }
) {
  return fetch(`${API_BASE}/operators/${userId}/profile`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch)
  }).then(json<{ operator: Operator }>);
}

export interface MyOperator {
  staff: StaffUser;
  status: string;
  profile: TechProfile | null;
}

export function getMyOperator() {
  return fetch(`${API_BASE}/operators/me`, { headers: authHeaders() }).then(
    json<MyOperator>
  );
}

export function updateMyProfile(input: {
  phone: string;
  home_base: string;
  service_area: string;
  claimed_qualifications: string[];
  location_sharing_consent: boolean;
}) {
  return fetch(`${API_BASE}/operators/me/profile`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input)
  }).then(json<MyOperator>);
}

export interface AssignmentResponse {
  job: (JobAssignment & { tech_name: string | null }) | null;
  requirement: SchedulerProposal["requirement"];
  proposals: SchedulerProposal | null;
}

export function getAssignment(caseId: string) {
  return fetch(`${API_BASE}/cases/${caseId}/assignment`, {
    headers: authHeaders()
  }).then(json<AssignmentResponse>);
}

export function proposeAssignment(caseId: string, startIso: string, endIso: string) {
  return fetch(`${API_BASE}/cases/${caseId}/assignment/propose`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ scheduled_start: startIso, scheduled_end: endIso })
  }).then(json<{ job: JobAssignment; proposals: SchedulerProposal }>);
}

export function assignTech(
  caseId: string,
  input: {
    tech_id: string;
    scheduled_start: string;
    scheduled_end: string;
    override_reason?: string;
  },
  reassign = false
) {
  return fetch(`${API_BASE}/cases/${caseId}/assignment${reassign ? "/reassign" : ""}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input)
  }).then(json<{ job: JobAssignment; case: CaseRecord }>);
}

export function getSchedule(date: string) {
  return fetch(`${API_BASE}/schedule?date=${encodeURIComponent(date)}`, {
    headers: authHeaders()
  }).then(json<{ date: string; entries: ScheduleBoardEntry[] }>);
}

// ---------------------------------------------------------------------
// Tech job execution + case assets (Slice B). The tech functions run
// on the tech's own token; the API scopes everything to their assigned
// jobs. Asset bytes move only through API-issued URLs: an upload
// target (presigned PUT for S3, capability path for the local driver)
// or a short-lived download URL — the client never builds storage
// URLs itself.
// ---------------------------------------------------------------------

export function listMyJobs() {
  return fetch(`${API_BASE}/tech/jobs`, { headers: authHeaders() }).then(
    json<{ jobs: TechJob[] }>
  );
}

export function getMyJob(jobId: string) {
  return fetch(`${API_BASE}/tech/jobs/${jobId}`, {
    headers: authHeaders()
  }).then(json<{ job: TechJob }>);
}

export function advanceJobStep(
  jobId: string,
  step: JobStep,
  payload: { client_name?: string; note?: string } = {}
) {
  return fetch(`${API_BASE}/tech/jobs/${jobId}/steps`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ step, ...payload })
  }).then(json<{ job: TechJob }>);
}

export interface AssetUploadGrant {
  asset: CaseAsset;
  upload: { url: string; method: "PUT"; headers: Record<string, string> };
}

export function requestJobPhotoUpload(
  jobId: string,
  input: {
    kind: "BEFORE_PHOTO" | "AFTER_PHOTO";
    filename: string;
    content_type: string;
    size_bytes: number;
  }
) {
  return fetch(`${API_BASE}/tech/jobs/${jobId}/assets/upload-url`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input)
  }).then(json<AssetUploadGrant>);
}

/** PUTs a file's bytes to an API-issued upload target. Targets are
 *  either absolute (S3 presigned) or API paths (local driver). */
export async function uploadAssetBytes(
  upload: AssetUploadGrant["upload"],
  file: File
): Promise<void> {
  const url = upload.url.startsWith("/")
    ? `${new URL(API_BASE).origin}${upload.url}`
    : upload.url;
  const response = await fetch(url, {
    method: upload.method,
    headers: upload.headers,
    body: file
  });
  if (!response.ok) {
    throw new Error(`Photo upload failed (${response.status}). Try again.`);
  }
}

export function confirmAsset(assetId: string) {
  return fetch(`${API_BASE}/assets/${assetId}/confirm`, {
    method: "POST",
    headers: authHeaders()
  }).then(json<{ asset: CaseAsset }>);
}

export function getAssetDownloadUrl(assetId: string) {
  return fetch(`${API_BASE}/assets/${assetId}/download-url`, {
    headers: authHeaders()
  }).then(json<{ asset: CaseAsset; url: string }>);
}

/** Resolves a download URL for display: API paths get the API origin,
 *  absolute URLs (S3) pass through untouched. */
export function resolveAssetUrl(url: string): string {
  return url.startsWith("/") ? `${new URL(API_BASE).origin}${url}` : url;
}

/** Staff: a case's job execution + asset registry (Slice B). */
export function getCaseJob(caseId: string) {
  return fetch(`${API_BASE}/cases/${caseId}/job`, {
    headers: authHeaders()
  }).then(json<CaseJobView>);
}

// ---------------------------------------------------------------------
// Live tracking (Slice C). The tech's device posts its position while
// a job is active (the API accepts it only then, and only with the
// tech's location-sharing consent on file); staff read the daily ops
// map. Clients never call either — their tracker gets an ETA summary.
// ---------------------------------------------------------------------

export function postJobLocation(
  jobId: string,
  input: { lat: number; lon: number; accuracy_m?: number }
) {
  return fetch(`${API_BASE}/tech/jobs/${jobId}/location`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input)
  }).then(json<{ ping: JobLocationPing }>);
}

/** Staff: the daily ops map — job pins + active techs' latest positions. */
export function getOpsMap(date: string) {
  return fetch(`${API_BASE}/ops-map?date=${encodeURIComponent(date)}`, {
    headers: authHeaders()
  }).then(json<OpsMapView>);
}

export function createCase(input: CreateCaseInput) {
  const idempotencyKey = crypto.randomUUID();
  return fetch(`${API_BASE}/cases`, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    }),
    body: JSON.stringify(input)
  }).then(json<CaseRecord>);
}

/**
 * Starts identification for a freshly created case. POST /cases returns the
 * shell immediately (serverless-safe); this second, awaited request runs the
 * whole identification → sourcing → pricing chain inside its own request
 * lifecycle, so the platform cannot freeze it mid-processing. Progress
 * streams independently via getCaseEvents polling — callers must not block
 * UI rendering on this promise, but should catch rejections (the progress
 * screen's timeout is the backstop when the start request itself fails).
 */
export function startIdentification(caseId: string) {
  return performAction(caseId, "start_identification");
}
