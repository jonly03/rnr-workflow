import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicTrackingPage } from "./App";
import type { PublicTrackingView } from "./api";

type FetchHandler = (url: string, init?: RequestInit) => unknown;

function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = handler(String(input), init);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const REVIEW_URL = "https://g.page/r/CZOjkKSvodOTEBM/review";

function trackingView(overrides: Partial<PublicTrackingView> = {}): PublicTrackingView {
  return {
    reference: "RRA-000101",
    channel: "DIRECT",
    vehicle: { year: 2020, make: "Honda", model: "Accord" },
    glass_type: "WINDSHIELD",
    status: "Service in progress",
    current_state: "INSTALLATION_IN_PROGRESS",
    signed_by: "Jane Customer",
    signed_at: "2026-11-03T13:00:00.000Z",
    signature_method: "typed",
    invoice: { version: 1, total_cents: 43750, payment: null },
    labor_cents: 12500,
    tax_cents: 1250,
    total_cents: 43750,
    milestones: [
      { key: "quote_signed", label: "Quote approved", done: true, at: "2026-11-03T13:00:00.000Z", detail: null },
      { key: "service_completed", label: "Service completed", done: false, at: null, detail: null }
    ],
    eta: null,
    review_url: null,
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Public tracking page — completion + Google review (2026-11-03)", () => {
  it("renders the completion state and review CTA once the job is complete", async () => {
    mockFetch(url => {
      if (url.includes("/public/track/")) {
        return trackingView({
          status: "Service completed",
          current_state: "SERVICE_COMPLETED",
          review_url: REVIEW_URL,
          milestones: [
            { key: "quote_signed", label: "Quote approved", done: true, at: "2026-11-03T13:00:00.000Z", detail: null },
            { key: "service_completed", label: "Service completed", done: true, at: "2026-11-03T15:30:00.000Z", detail: null }
          ]
        });
      }
      return {};
    });
    render(<PublicTrackingPage token="rnappr_test" />);
    const block = await screen.findByTestId("tracking-complete");
    expect(block).toHaveTextContent(/Your service is complete/);
    const cta = screen.getByRole("link", { name: /leave us a google review/i });
    expect(cta).toHaveAttribute("href", REVIEW_URL);
  });

  it("shows no review CTA before completion", async () => {
    mockFetch(url => {
      if (url.includes("/public/track/")) return trackingView();
      return {};
    });
    render(<PublicTrackingPage token="rnappr_test" />);
    expect(await screen.findByText("RRA-000101")).toBeInTheDocument();
    expect(screen.queryByTestId("tracking-complete")).toBeNull();
    expect(screen.queryByRole("link", { name: /google review/i })).toBeNull();
  });
});
