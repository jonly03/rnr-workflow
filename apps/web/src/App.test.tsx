import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App, cardOrderKey, DEFAULT_CARD_ORDER, loadCardOrder, scanProgressForElapsed } from "./App";

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
