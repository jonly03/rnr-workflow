import type { CaseEvent, CaseRecord, Channel, GlassType } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001/api/v1";

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

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed: ${response.status}`);
  }
  return response.json();
}

export function listCases() {
  return fetch(`${API_BASE}/cases`).then(json<CaseRecord[]>);
}

export function getCase(id: string) {
  return fetch(`${API_BASE}/cases/${id}`).then(json<CaseRecord>);
}

export function getCaseEvents(id: string) {
  return fetch(`${API_BASE}/cases/${id}/events`).then(json<CaseEvent[]>);
}

export function createCase(input: CreateCaseInput) {
  const idempotencyKey = crypto.randomUUID();
  return fetch(`${API_BASE}/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(input)
  }).then(json<CaseRecord>);
}
