import type { CaseEvent, CaseRecord, Channel, GlassType } from "./types";

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

async function json<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    clearToken();
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed: ${response.status}`);
  }
  return response.json();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

export interface StaffCaseEventMessage {
  type: "case_event" | "sync";
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
    const url = staffEventsSocketUrl();
    if (!url) {
      handlers.onStatus("reconnecting");
      startPolling();
      scheduleRetry();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      handlers.onStatus("reconnecting");
      startPolling();
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      retryMs = 1000;
      stopPolling();
      handlers.onStatus("live");
      handlers.onEvent({ type: "sync" });
    };
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as StaffCaseEventMessage;
        if (parsed?.type === "case_event") handlers.onEvent(parsed);
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
}

export function getPublicQuote(token: string) {
  return fetch(`${API_BASE}/public/quote/${token}`).then(json<PublicQuoteView>);
}

export function signPublicQuote(
  token: string,
  input: { name: string; signature_data_url: string }
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
  invoice: { version: number; total_cents: number } | null;
  labor_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  milestones: TrackingMilestone[];
}

export function getPublicTracking(token: string) {
  return fetch(`${API_BASE}/public/track/${token}`).then(json<PublicTrackingView>);
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
