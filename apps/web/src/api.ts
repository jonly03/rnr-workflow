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

export function ocrVinPhoto(photo: File) {
  const form = new FormData();
  form.append("photo", photo);
  const token = getToken();
  return fetch(`${API_BASE}/vin/ocr`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form
  }).then(json<{ vin: string }>);
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
