import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App, cardOrderKey, DEFAULT_CARD_ORDER, filterQueueCases, loadCardOrder, scanProgressForElapsed, sortQueueCases } from "./App";
import type { CaseRecord } from "./types";

vi.stubGlobal("fetch", vi.fn(async () => ({
  ok: true,
  json: async () => []
})));

describe("R&R Case Core staff shell", () => {
  it("shows the sign-in screen when no session exists", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });
});

describe("case card ordering", () => {
  const email = "tech@rr.test";
  const key = cardOrderKey(email);

  it("defaults to price and parts cards below the vehicle card", () => {
    expect(DEFAULT_CARD_ORDER.slice(0, 3)).toEqual(["vehicle", "pricing", "identification"]);
  });

  it("returns the default order when nothing is stored", () => {
    localStorage.removeItem(key);
    expect(loadCardOrder(email)).toEqual([...DEFAULT_CARD_ORDER]);
  });

  it("returns the staff member's saved order", () => {
    localStorage.setItem(key, JSON.stringify(["activity", "vehicle", "pricing", "identification", "action", "sourcing"]));
    expect(loadCardOrder(email)).toEqual(["activity", "vehicle", "pricing", "identification", "action", "sourcing"]);
    localStorage.removeItem(key);
  });

  it("appends new cards and drops unknown ids", () => {
    localStorage.setItem(key, JSON.stringify(["sourcing", "bogus", "vehicle"]));
    const order = loadCardOrder(email);
    expect(order).not.toContain("bogus");
    expect(order.slice(0, 2)).toEqual(["sourcing", "vehicle"]);
    // remaining default cards appended in default relative order
    expect(order).toEqual(["sourcing", "vehicle", "pricing", "identification", "action", "activity"]);
    localStorage.removeItem(key);
  });

  it("falls back to default on corrupted storage", () => {
    localStorage.setItem(key, "not-json{{{");
    expect(loadCardOrder(email)).toEqual([...DEFAULT_CARD_ORDER]);
    localStorage.removeItem(key);
  });

  it("scopes the order per staff member", () => {
    expect(cardOrderKey("a@rr.test")).not.toBe(cardOrderKey("b@rr.test"));
  });
});

describe("scan progress", () => {
  it("starts at 0 and eases toward 90 without exceeding it", () => {
    expect(scanProgressForElapsed(0)).toBe(0);
    expect(scanProgressForElapsed(8)).toBeGreaterThan(0);
    expect(scanProgressForElapsed(8)).toBeLessThan(90);
    expect(scanProgressForElapsed(1000)).toBe(90);
  });

  it("is monotonic", () => {
    let prev = -1;
    for (let s = 0; s <= 60; s += 2) {
      const pct = scanProgressForElapsed(s);
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
  });
});

describe("case queue filtering and sorting", () => {
  const makeCase = (overrides: Partial<CaseRecord> = {}): CaseRecord =>
    ({
      id: "case-1",
      reference: "RRA-000001",
      channel: "DIRECT",
      current_state: "PRICE_APPROVED",
      customer_id: null,
      vehicle: {
        id: "v-1",
        year: 2018,
        make: "Jeep",
        model: "Wrangler",
        vin: "1C4HJXEG3JW224862"
      },
      glass_request: { id: "gr-1", glass_type: "WINDSHIELD" },
      glass_identification: null,
      supplier_offers: [],
      price_calculation: {
        id: "p-1",
        case_id: "case-1",
        glass_request_id: "gr-1",
        selected_offer_id: null,
        glass_cost_cents: 20000,
        labor_cents: 12500,
        profit_cents: 25000,
        tax_cents: 1250,
        sell_price_cents: 58750,
        pricing_config: {},
        status: "APPROVED",
        created_at: "2026-09-29T00:00:00Z"
      },
      created_at: "2026-09-29T00:00:00Z",
      updated_at: "2026-09-29T00:00:00Z",
      ...overrides
    }) as CaseRecord;

  const a = makeCase({ id: "a", reference: "RRA-000001", created_at: "2026-09-29T03:00:00Z" });
  const b = makeCase({
    id: "b",
    reference: "RRA-000002",
    channel: "AUCTION",
    current_state: "GLASS_IDENTIFIED",
    vehicle: { ...a.vehicle, id: "v-2", year: 2020, make: "Ford", model: "F-150", vin: "1FTEW1E5XLFA12345" },
    glass_request: { id: "gr-2", glass_type: "BACK_GLASS" },
    price_calculation: { ...a.price_calculation!, id: "p-2", case_id: "b", glass_request_id: "gr-2", sell_price_cents: 42000 },
    created_at: "2026-09-29T01:00:00Z"
  });
  const c = makeCase({
    id: "c",
    reference: "RRA-000003",
    channel: "INSURANCE",
    current_state: "PRICE_APPROVED",
    vehicle: { ...a.vehicle, id: "v-3", year: 2015, make: "Honda", model: "Civic", vin: "2HGFB2F90FH123456" },
    price_calculation: null,
    created_at: "2026-09-29T02:00:00Z"
  });
  const all = [a, b, c];
  const none = { search: "", channel: "ALL", glass: "ALL", status: "ALL" } as const;

  it("returns everything when no filters are set", () => {
    expect(filterQueueCases(all, { ...none })).toEqual(all);
  });

  it("filters by channel, glass type, and status", () => {
    expect(filterQueueCases(all, { ...none, channel: "AUCTION" }).map(x => x.id)).toEqual(["b"]);
    expect(filterQueueCases(all, { ...none, glass: "BACK_GLASS" }).map(x => x.id)).toEqual(["b"]);
    expect(filterQueueCases(all, { ...none, status: "GLASS_IDENTIFIED" }).map(x => x.id)).toEqual(["b"]);
    expect(
      filterQueueCases(all, { ...none, channel: "INSURANCE", status: "PRICE_APPROVED" }).map(x => x.id)
    ).toEqual(["c"]);
  });

  it("searches reference, VIN, and vehicle name case-insensitively", () => {
    expect(filterQueueCases(all, { ...none, search: "rra-000002" }).map(x => x.id)).toEqual(["b"]);
    expect(filterQueueCases(all, { ...none, search: "1ftew1e5x" }).map(x => x.id)).toEqual(["b"]);
    expect(filterQueueCases(all, { ...none, search: "civic" }).map(x => x.id)).toEqual(["c"]);
    expect(filterQueueCases(all, { ...none, search: "2018 jeep" }).map(x => x.id)).toEqual(["a"]);
    expect(filterQueueCases(all, { ...none, search: "zzz" })).toEqual([]);
  });

  it("sorts by sell price with unpriced cases last", () => {
    expect(sortQueueCases(all, "price-desc").map(x => x.id)).toEqual(["a", "b", "c"]);
    expect(sortQueueCases(all, "price-asc").map(x => x.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by vehicle name and by newest", () => {
    expect(sortQueueCases(all, "vehicle").map(x => x.id)).toEqual(["b", "c", "a"]);
    expect(sortQueueCases(all, "newest").map(x => x.id)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [b, a, c];
    sortQueueCases(input, "price-desc");
    expect(input.map(x => x.id)).toEqual(["b", "a", "c"]);
  });
});
