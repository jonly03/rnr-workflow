import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, cardOrderKey, DEFAULT_CARD_ORDER, describeEvent, filterQueueCases, groupInvoiceBoard, InvoiceBoard, invoicePaymentLabel, isStaffActionRequired, isValidSignatureName, loadCardOrder, pinQuoteAfterPricing, PublicIntakePage, PublicQuotePage, scanProgressForElapsed, shouldShowOverrideWarning, SignatureRender, sortQueueCases } from "./App";
import type { InvoiceBoardItem } from "./api";
import type { CaseRecord, CaseEvent } from "./types";

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

  it("defaults to pricing, quote, invoice, sourcing, activity below the vehicle card", () => {
    expect(DEFAULT_CARD_ORDER).toEqual(["vehicle", "pricing", "quote", "invoice", "fulfillment", "sourcing", "activity"]);
  });

  it("returns the default order when nothing is stored", () => {
    localStorage.removeItem(key);
    expect(loadCardOrder(email)).toEqual([...DEFAULT_CARD_ORDER]);
  });

  it("locks the quote card immediately after pricing, whatever was saved", () => {
    // Quote saved far from pricing (e.g. dragged to the bottom pre-lock).
    localStorage.setItem(key, JSON.stringify(["vehicle", "pricing", "invoice", "activity", "quote"]));
    const order = loadCardOrder(email);
    expect(order.indexOf("quote")).toBe(order.indexOf("pricing") + 1);
    localStorage.removeItem(key);
    // The pin helper itself: quote follows pricing even when pricing moves.
    expect(pinQuoteAfterPricing(["quote", "vehicle", "pricing", "activity"])).toEqual(
      ["vehicle", "pricing", "quote", "activity"]
    );
    expect(pinQuoteAfterPricing(["pricing", "quote", "vehicle"])).toEqual(
      ["pricing", "quote", "vehicle"]
    );
  });

  it("returns the staff member's saved order", () => {
    localStorage.setItem(key, JSON.stringify(["activity", "vehicle", "sourcing", "pricing"]));
    // New cards staff hasn't positioned yet are appended in default order.
    expect(loadCardOrder(email)).toEqual(["activity", "vehicle", "sourcing", "pricing", "quote", "invoice", "fulfillment"]);
    localStorage.removeItem(key);
  });

  it("appends new cards and drops unknown ids", () => {
    localStorage.setItem(key, JSON.stringify(["sourcing", "bogus", "vehicle"]));
    const order = loadCardOrder(email);
    expect(order).not.toContain("bogus");
    expect(order.slice(0, 2)).toEqual(["sourcing", "vehicle"]);
    // remaining default cards appended in default relative order
    expect(order).toEqual(["sourcing", "vehicle", "pricing", "quote", "invoice", "fulfillment", "activity"]);
    localStorage.removeItem(key);
  });

  it("drops retired cards from saved orders", () => {
    localStorage.setItem(key, JSON.stringify(["action", "identification", "vehicle"]));
    expect(loadCardOrder(email)).toEqual(["vehicle", "pricing", "quote", "invoice", "fulfillment", "sourcing", "activity"]);
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

describe("staff action alert", () => {
  it("is required for blocked states only", () => {
    for (const s of ["VIN_LOOKUP_REQUIRED", "HUMAN_GLASS_REVIEW_REQUIRED", "GLASS_NOT_IDENTIFIED", "NO_ELIGIBLE_INVENTORY", "PROFIT_REVIEW_REQUIRED"]) {
      expect(isStaffActionRequired(s)).toBe(true);
    }
    for (const s of ["PRICE_APPROVED", "GLASS_SELECTED", "PRICING_IN_PROGRESS", "CASE_CREATED"]) {
      expect(isStaffActionRequired(s)).toBe(false);
    }
  });

  it("orders detail cards: vehicle, pricing, quote, invoice, sourcing, activity", () => {
    expect(DEFAULT_CARD_ORDER).toEqual(["vehicle", "pricing", "quote", "invoice", "fulfillment", "sourcing", "activity"]);
  });

  it("migrates saved orders that reference retired cards", () => {
    localStorage.setItem(cardOrderKey("sam@example.com"), JSON.stringify(["action", "vehicle", "pricing"]));
    expect(loadCardOrder("sam@example.com")).toEqual(["vehicle", "pricing", "quote", "invoice", "fulfillment", "sourcing", "activity"]);
  });
});

describe("staff override warning", () => {
  it("shows while staff's pick differs from the system's pick", () => {
    expect(shouldShowOverrideWarning("National Glass Supply", "Allied Auto Glass", 1)).toBe(true);
  });

  it("is silenced when staff reverts to the system choice", () => {
    // National -> Allied -> National: two overrides, but the current pick
    // matches the system's original pick, so no warning.
    expect(shouldShowOverrideWarning("National Glass Supply", "National Glass Supply", 2)).toBe(false);
  });

  it("stays hidden without an override or without a system baseline", () => {
    expect(shouldShowOverrideWarning("National Glass Supply", "Allied Auto Glass", 0)).toBe(false);
    expect(shouldShowOverrideWarning(null, "Allied Auto Glass", 1)).toBe(false);
    expect(shouldShowOverrideWarning("National Glass Supply", null, 1)).toBe(false);
  });
});

describe("describeEvent", () => {
  const evt = (event_type: string, payload: Record<string, unknown> = {}) =>
    ({ id: "e1", case_id: "c1", sequence: 1, event_type, occurred_at: "2026-09-29T00:00:00Z", actor_type: "SYSTEM", payload }) as CaseEvent;

  it("summarizes key workflow steps in plain English", () => {
    expect(describeEvent(evt("CASE_CREATED", { channel: "DIRECT" })))
      .toBe("Case opened in the Direct channel.");
    expect(describeEvent(evt("VIN_RESULT_RETURNED", { candidate_count: 2, charged: true })))
      .toBe("VIN decoded — 2 candidates (charged).");
    expect(describeEvent(evt("GLASS_RESOLVED", { method: "VIN", part_number: "DW01234" })))
      .toBe("Glass identified by VIN decode: DW01234.");
    expect(describeEvent(evt("ELIGIBLE_OFFER_SELECTED", { supplier_name: "PGW", price_cents: 20000, part_number: "DW01234" })))
      .toBe("Selected PGW at $200.00 for part DW01234.");
    expect(describeEvent(evt("STANDARD_PRICE_CALCULATED", { sell_price_cents: 65017 })))
      .toBe("Price calculated — sell price $650.17.");
    expect(describeEvent(evt("SUPPLIER_OFFER_OVERRIDDEN", { old_supplier_name: "PGW", new_supplier_name: "Local Glass Co", new_price_cents: 18000 })))
      .toBe("Staff switched supplier from PGW to Local Glass Co at $180.00.");
    expect(describeEvent(evt("PRICE_APPROVED_BY_RNR", { sell_price_cents: 65017 })))
      .toBe("R&R approved the price at $650.17.");
    expect(describeEvent(evt("QUOTE_GENERATED", { version: 1, sell_price_cents: 68954 })))
      .toBe("Quote v1 sent — total $689.54.");
    expect(describeEvent(evt("QUOTE_SIGNED", { signer_name: "Lou Customer" })))
      .toBe("Quote signed by Lou Customer.");
    expect(describeEvent(evt("QUOTE_DECLINED", {})))
      .toBe("Quote declined by the client.");
    expect(describeEvent(evt("QUOTE_EXPIRED", {})))
      .toBe("Quote expired before the client signed.");
    expect(describeEvent(evt("INVOICE_GENERATED", { version: 1, quote_version: 2, sell_price_cents: 68954 })))
      .toBe("Invoice v1 generated from signed quote v2 — total $689.54.");
    expect(describeEvent(evt("CASE_CLOSED")))
      .toBe("Case closed.");
  });

  it("degrades gracefully when payload fields are missing", () => {
    expect(describeEvent(evt("GLASS_RESOLVED"))).toBe("Glass identification resolved.");
    expect(describeEvent(evt("ELIGIBLE_OFFER_SELECTED"))).toBe("A supplier offer was selected.");
  });

  it("falls back to a humanized event type", () => {
    expect(describeEvent(evt("SOME_FUTURE_EVENT"))).toBe("Some Future Event.");
  });
});

describe("glass catalog mode badge", () => {
  const staff = { name: "Tech", email: "tech@rr.test" };
  function stubHealth(glassCatalog: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        if (target.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ ok: true, storage: "json", glass_catalog: glassCatalog })
          };
        }
        if (target.endsWith("/auth/me")) {
          return { ok: true, json: async () => ({ staff }) };
        }
        return { ok: true, json: async () => [] };
      })
    );
  }

  // The badge lives on the queue screen, so these tests sign in first.
  beforeEach(() => {
    localStorage.setItem("rnr_staff_token", "test-token");
  });
  afterEach(() => {
    localStorage.removeItem("rnr_staff_token");
  });

  it("shows a LIVE badge when the API sources from MyGrant", async () => {
    stubHealth("mygrant-web");
    render(<App />);
    const badge = await screen.findByText("LIVE · MyGrant");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("live");
    expect(badge).toHaveAttribute("title", expect.stringContaining("$1"));
  });

  it("shows a mock badge when the API uses the mock catalog", async () => {
    stubHealth("mock-catalog");
    render(<App />);
    const badge = await screen.findByText("Mock catalog");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("mock");
  });

  it("puts the catalog badge under the R&R Operations eyebrow and above the Case Queue heading, outside the header", async () => {
    stubHealth("mock-catalog");
    render(<App />);
    const badge = await screen.findByText("Mock catalog");
    // Never in the topbar: the header grid stays untouched.
    expect(badge.closest("header")).toBeNull();
    // In the queue page head, ordered: eyebrow, badge, heading.
    const pageHead = badge.closest(".page-head");
    expect(pageHead).not.toBeNull();
    const order = Array.from(pageHead!.querySelectorAll(".eyebrow, .catalog-badge, h1"));
    expect(
      order.map(el => (el.classList.contains("catalog-badge") ? "badge" : el.textContent))
    ).toEqual(["R&R Operations", "badge", "Case Queue"]);
  });
});

describe("activity timeline layout", () => {
  // Regression: a stale `.timeline li { display: grid; grid-template-columns:
  // 1fr auto }` rule (written for a previous markup) still matched the new
  // `li.timeline-item` elements. Collapsed entries looked fine, but expanding
  // one squeezed the toggle button into the 1fr column and crammed the
  // details beside it instead of below — "jacking up" the entry heading.
  // jsdom never applies stylesheets, so pin the stylesheet source directly.
  it("has no bare .timeline element selectors that fight .timeline-item", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const rules = css.split("}").map(r => r.split("{")[0]);
    const bare = rules.filter(sel =>
      /(^|[\s,])\.timeline\s+(ol|li|small)\b/.test(sel) ||
      /(^|[\s,])\.timeline\s+li\s*:/.test(sel)
    );
    expect(bare).toEqual([]);
    // The current structure's own rules must still be there.
    for (const sel of [".timeline-list", ".timeline-item", ".timeline-toggle", ".timeline-details"]) {
      expect(rules.some(r => r.includes(sel))).toBe(true);
    }
  });

  // Regression: expanded payload <pre> blocks (e.g. long single-line error
  // JSON) truncated at the viewport edge instead of wrapping, forcing a
  // pinch-zoom to read them — which in turn broke the top banner's rendering
  // on iOS. Pin the wrapping declarations in the stylesheet source directly.
  it("wraps long payload lines instead of truncating them", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const block = css.split(".timeline-details pre")[1]?.split("}")[0] ?? "";
    expect(block).toMatch(/white-space\s*:\s*pre-wrap/);
    expect(block).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });
});

describe("public intake page (QR front door)", () => {
  // This file has no global RTL auto-cleanup; each card-flow test renders
  // a fresh page, so unmount explicitly to keep label queries unique.
  afterEach(() => cleanup());

  const VALID_VIN = "1HGCM82633A004352"; // ISO 3779 check digit valid

  /** The mock provider's Terrace St fixture, as the suggest endpoint returns it. */
  const ADDRESS_FIXTURE = {
    place_id: "mock:terrace-118",
    formatted: "118 Terrace St, Boston, MA 02120",
    street: "118 Terrace St",
    city: "Boston",
    state: "Massachusetts",
    zip: "02120",
    lat: 42.3349,
    lon: -71.0828
  };

  function stubIntakeFetch(options: { failIntakeWithField?: string } = {}) {
    const state: {
      url: string;
      body: FormData | null;
      calls: number;
      requests: { url: string; method: string }[];
    } = {
      url: "",
      body: null,
      calls: 0,
      requests: []
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: { body?: unknown; method?: string }) => {
        const u = String(url);
        state.requests.push({ url: u, method: init?.method ?? "GET" });
        // Address suggestions (contact card only).
        if (u.includes("/public/address/suggest")) {
          return {
            ok: true,
            json: async () => ({ suggestions: [ADDRESS_FIXTURE] })
          };
        }
        // Live-progress endpoints behind the confirmation's status token.
        if (u.includes("/public/intake-status/") && init?.method === "POST") {
          return {
            ok: true,
            json: async () => ({ path: "/quote/rnappr_testtoken", expires_at: "2026-10-23T00:00:00Z" })
          };
        }
        if (u.includes("/public/intake-status/")) {
          return {
            ok: true,
            json: async () => ({
              reference: "RRA-000042",
              vehicle: { year: 2020, make: "Honda", model: "Accord" },
              glass_type: "WINDSHIELD",
              phase: "quote_ready",
              headline: "Your quote is ready. Review it and sign to book your job in.",
              steps: [
                { key: "received", label: "Request received", done: true },
                { key: "glass", label: "Identifying your glass", done: true },
                { key: "pricing", label: "Pricing your job", done: true },
                { key: "quote", label: "Quote ready to sign", done: true }
              ],
              quote_ready: true
            })
          };
        }
        state.calls += 1;
        state.url = u;
        state.body = (init?.body as FormData) ?? null;
        if (options.failIntakeWithField) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error: {
                code: "VALIDATION_ERROR",
                message:
                  "Tell us where we'll find the car — type your address, or pick it from the suggestions.",
                details: { field: options.failIntakeWithField }
              }
            })
          };
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            reference: "RRA-000042",
            message:
              "Thanks — your request is in. We'll review it and text a quote link to the mobile number you gave us.",
            status_token: "rnappr_statustoken"
          })
        };
      })
    );
    return state;
  }

  /** Type an address query on the contact card and pick the Terrace St suggestion. */
  async function pickServiceAddress() {
    fireEvent.change(screen.getByLabelText(/service address/i), {
      target: { value: "118 Terr" }
    });
    const option = await screen.findByRole("option", {
      name: /118 Terrace St, Boston, MA 02120/
    });
    fireEvent.click(option);
  }

  function continueButton() {
    return screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
  }

  /** Walk card 1 (valid VIN) and card 2 (Windshield) to land on card 3 (contact). */
  function walkToCard3() {
    fireEvent.change(screen.getByLabelText(/^VIN/), {
      target: { value: VALID_VIN }
    });
    fireEvent.click(continueButton());
    fireEvent.click(screen.getByRole("radio", { name: "Windshield" }));
    fireEvent.click(continueButton());
  }

  it("walks the 3 cards in order and submits the same payload shape as the one-page form — no prices anywhere", async () => {
    const posted = stubIntakeFetch();
    render(<PublicIntakePage />);

    // Card 1 only: headline + vehicle, no glass picker, YMM hidden.
    expect(
      screen.getByRole("heading", { name: "How can we service your auto glass?" })
    ).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Windshield" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Year/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/scan vin/i)).toBeInTheDocument();
    expect(continueButton().disabled).toBe(true);

    // Scan VIN stays an optional attachment on card 1.
    const vinPhoto = new File(["vin-bytes"], "vin.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/scan vin/i), {
      target: { files: [vinPhoto] }
    });

    fireEvent.change(screen.getByLabelText(/^VIN/), {
      target: { value: VALID_VIN }
    });
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());

    // Card 2: headline is card-1 only; picking a glass enables Continue.
    // The damage-photo upload lives here now (it moved off the removed
    // "What happened?" card) — and that card's free-text field is gone
    // entirely, not relocated.
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "How can we service your auto glass?" })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/what happened/i)).not.toBeInTheDocument();
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Windshield" }));
    expect(continueButton().disabled).toBe(false);
    const damagePhoto = new File(["crack-bytes"], "crack.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/damage photos/i), {
      target: { files: [damagePhoto] }
    });
    expect(screen.getByTestId("intake-photo-count")).toHaveTextContent("1/6 added");
    fireEvent.click(continueButton());

    // Card 3 is the contact card — there is no card 4 anymore.
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByText(/····4352 · Windshield/)).toBeInTheDocument();
    // The fetch law: cards 1-2 made NO network calls at all. On the
    // contact card, only address-suggest GETs may fire before Send.
    expect(posted.requests).toHaveLength(0);
    const send = screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/your name/i), {
      target: { value: "Jane Customer" }
    });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/mobile phone/i), {
      target: { value: "(617) 555-0142" }
    });
    // Name + phone alone don't open Send: an address (typed or
    // picked) is also required.
    expect(send.disabled).toBe(true);
    await pickServiceAddress();
    expect(send.disabled).toBe(false);
    // Still nothing submitted — and every request so far was a suggest GET.
    expect(posted.calls).toBe(0);
    expect(posted.requests.length).toBeGreaterThan(0);
    expect(
      posted.requests.every(r => r.url.includes("/public/address/suggest") && r.method === "GET")
    ).toBe(true);
    fireEvent.click(send);

    expect(await screen.findByRole("heading", { name: /Request received/ })).toBeInTheDocument();
    expect(screen.getByText("RRA-000042")).toBeInTheDocument();
    expect(screen.getByText(/text a quote link/)).toBeInTheDocument();
    expect(posted.calls).toBe(1);
    expect(posted.url).toContain("/public/intake");
    expect(posted.body!.get("glass_type")).toBe("WINDSHIELD");
    expect(posted.body!.get("vin")).toBe(VALID_VIN);
    expect(posted.body!.get("vin_photo")).toBe(vinPhoto);
    // The damage photo picked up on card 2 rides along; the removed
    // "What happened?" note field is never sent.
    expect(posted.body!.getAll("photos")).toEqual([damagePhoto]);
    expect(posted.body!.get("note")).toBeNull();
    expect(posted.body!.get("customer_name")).toBe("Jane Customer");
    expect(posted.body!.get("customer_phone")).toBe("(617) 555-0142");
    // The picked service address rides as structured JSON with its
    // provider place id — exactly what the API validates and stores.
    expect(JSON.parse(posted.body!.get("service_address") as string)).toEqual(
      ADDRESS_FIXTURE
    );
    // The confirmation page completes itself: live progress polls behind
    // the status token, sees the quote ready, and hands over the sign
    // link — no staff click, no waiting for a text.
    expect(await screen.findByText(/happening with your request/)).toBeInTheDocument();
    const signLink = await screen.findByRole("link", { name: /Review & sign your quote/ });
    expect(signLink).toBeInTheDocument();
    expect(signLink.getAttribute("href")).toContain("/quote/rnappr_testtoken");
    expect(screen.getByText("Quote ready to sign")).toBeInTheDocument();
    // Prices come with the quote, never at intake.
    expect(document.body.textContent ?? "").not.toMatch(/\$\d/);
  });

  it("contact card gates: name ≥ 2 chars, phone must normalize to 10 US digits, address required — typed free text submits (demo relaxation)", async () => {
    const posted = stubIntakeFetch();
    render(<PublicIntakePage />);
    walkToCard3();
    const send = screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement;

    // The disabled button says why: with nothing filled, all three
    // missing pieces are named.
    expect(screen.getByText(/Still needed:/)).toHaveTextContent(
      "your name · a valid 10-digit mobile number · the service address"
    );

    // A picked address + good phone, but a 1-char name: still blocked,
    // and the name field itself says so underneath.
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "J" } });
    expect(screen.getByText("Please enter your full name.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/mobile phone/i), {
      target: { value: "(617) 555-0142" }
    });
    await pickServiceAddress();
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/your name/i), {
      target: { value: "Jane Customer" }
    });
    expect(send.disabled).toBe(false);
    expect(screen.queryByText("Please enter your full name.")).not.toBeInTheDocument();
    // Everything provided: the Still-needed line is gone.
    expect(screen.queryByText(/Still needed:/)).not.toBeInTheDocument();

    // A 7-digit number is not textable: blocked, and the phone field's
    // own error names the problem precisely (digit count included).
    fireEvent.change(screen.getByLabelText(/mobile phone/i), {
      target: { value: "555-0142" }
    });
    expect(screen.getByText(/this one has 7 digits/)).toBeInTheDocument();
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/valid 10-digit US mobile number/)).toBeInTheDocument();
    // ...and the reason line names the phone as the blocker.
    expect(screen.getByText(/Still needed:/)).toHaveTextContent(
      "a valid 10-digit mobile number"
    );
    // +1 and punctuation are fine.
    fireEvent.change(screen.getByLabelText(/mobile phone/i), {
      target: { value: "+1 617 555 0142" }
    });
    expect(send.disabled).toBe(false);

    // Typing over the picked address un-picks it, but free text still
    // submits under the demo relaxation: Send stays open, and the
    // posted address is the typed text alone (no place id).
    fireEvent.change(screen.getByLabelText(/service address/i), {
      target: { value: "118 Terrace St, Boston, MA 02120 (trust me)" }
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(await screen.findByRole("heading", { name: /Request received/ })).toBeInTheDocument();
    expect(posted.calls).toBe(1);
    expect(JSON.parse(posted.body!.get("service_address") as string)).toEqual({
      formatted: "118 Terrace St, Boston, MA 02120 (trust me)"
    });
  });

  it("surfaces a server 400 for the address field under the address input, not as a form error", async () => {
    stubIntakeFetch({ failIntakeWithField: "service_address" });
    render(<PublicIntakePage />);
    walkToCard3();
    fireEvent.change(screen.getByLabelText(/your name/i), {
      target: { value: "Jane Customer" }
    });
    fireEvent.change(screen.getByLabelText(/mobile phone/i), {
      target: { value: "(617) 555-0142" }
    });
    await pickServiceAddress();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Tell us where we'll find the car/);
    // No confirmation — the customer stays on the form to fix it.
    expect(screen.queryByRole("heading", { name: /Request received/ })).not.toBeInTheDocument();
  });

  it("card 1 YMM path enforces the year range (1950..next year)", () => {
    stubIntakeFetch();
    render(<PublicIntakePage />);
    fireEvent.click(screen.getByRole("button", { name: /I don't have the VIN/i }));
    fireEvent.change(screen.getByLabelText(/^Make/), { target: { value: "Honda" } });
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: "Accord" } });
    fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: "1800" } });
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText(/4-digit year between 1950/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: "202" } });
    expect(continueButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: "2020" } });
    expect(continueButton().disabled).toBe(false);
  });

  it("gates card 1 on a valid VIN or the 'I don't have the VIN' expander with complete YMM", () => {
    stubIntakeFetch();
    render(<PublicIntakePage />);
    expect(continueButton().disabled).toBe(true);

    // A typed VIN with a bad check digit does not open the gate.
    fireEvent.change(screen.getByLabelText(/^VIN/), {
      target: { value: "1HGCM82633A004353" }
    });
    expect(continueButton().disabled).toBe(true);

    // The expander is the only way YMM ever appears.
    fireEvent.change(screen.getByLabelText(/^VIN/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /I don't have the VIN/i }));
    expect(screen.getByLabelText(/^Year/)).toBeInTheDocument();
    expect(continueButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Year/), { target: { value: "2023" } });
    fireEvent.change(screen.getByLabelText(/^Make/), { target: { value: "Volkswagen" } });
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: "ID.4" } });
    expect(continueButton().disabled).toBe(false);

    // An entered VIN hides YMM again — they never show together.
    fireEvent.change(screen.getByLabelText(/^VIN/), {
      target: { value: VALID_VIN }
    });
    expect(screen.queryByLabelText(/^Year/)).not.toBeInTheDocument();
    expect(continueButton().disabled).toBe(false);
  });

  it("damage photos on card 2: live count, per-photo remove, 6-photo cap, image-only and 10 MB rules", () => {
    stubIntakeFetch();
    render(<PublicIntakePage />);
    // Land on card 2.
    fireEvent.change(screen.getByLabelText(/^VIN/), {
      target: { value: VALID_VIN }
    });
    fireEvent.click(continueButton());
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    const photoInput = () => screen.getByLabelText(/damage photos/i);
    const img = (name: string, size = 8) =>
      new File([new Uint8Array(size)], name, { type: "image/jpeg" });

    expect(screen.getByTestId("intake-photo-count")).toHaveTextContent("0/6 added");
    fireEvent.change(photoInput(), {
      target: { files: [img("a.jpg"), img("b.jpg"), img("c.jpg")] }
    });
    expect(screen.getByTestId("intake-photo-count")).toHaveTextContent("3/6 added");
    expect(screen.getByText("b.jpg")).toBeInTheDocument();

    // Per-photo remove.
    fireEvent.click(screen.getByRole("button", { name: "Remove photo b.jpg" }));
    expect(screen.getByTestId("intake-photo-count")).toHaveTextContent("2/6 added");
    expect(screen.queryByText("b.jpg")).not.toBeInTheDocument();

    // The cap is hard: offering 5 more when 2 are present adds only 4
    // and says so — the 7th photo never lands.
    fireEvent.change(photoInput(), {
      target: { files: [img("d.jpg"), img("e.jpg"), img("f.jpg"), img("g.jpg"), img("h.jpg")] }
    });
    expect(screen.getByTestId("intake-photo-count")).toHaveTextContent("6/6 added");
    expect(screen.queryByText("h.jpg")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Up to 6 photos/);

    // Non-images and oversized files are refused by name.
    fireEvent.click(screen.getByRole("button", { name: "Remove photo a.jpg" }));
    fireEvent.change(photoInput(), {
      target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] }
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/notes\.txt.*isn't an image/);
    fireEvent.change(photoInput(), {
      target: { files: [img("huge.jpg", 10 * 1024 * 1024 + 1)] }
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/huge\.jpg.*larger than 10 MB/);
    expect(screen.getByTestId("intake-photo-count")).toHaveTextContent("5/6 added");

    // Photos never gate the card: with a glass picked, Continue works.
    fireEvent.click(screen.getByRole("radio", { name: "Windshield" }));
    fireEvent.click(continueButton());
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByText(/····4352 · Windshield/)).toBeInTheDocument();
  });

  it("Back is a quiet affordance that returns to the previous card with state kept", () => {
    stubIntakeFetch();
    render(<PublicIntakePage />);
    fireEvent.change(screen.getByLabelText(/^VIN/), {
      target: { value: VALID_VIN }
    });
    fireEvent.click(continueButton());
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect((screen.getByLabelText(/^VIN/) as HTMLInputElement).value).toBe(VALID_VIN);
  });
});

describe("invoice payment labels and board grouping (Slice D)", () => {
  const baseInvoice = {
    payment_status: "UNSENT" as const,
    dispute_resolution: null,
    aging_days: null
  };

  it("labels each payment state, with aging while awaiting payment", () => {
    expect(invoicePaymentLabel(baseInvoice)).toBe("Unsent");
    expect(
      invoicePaymentLabel({ ...baseInvoice, payment_status: "SENT", aging_days: 6 })
    ).toBe("Sent — awaiting payment (6d)");
    expect(
      invoicePaymentLabel({ ...baseInvoice, payment_status: "SENT", aging_days: null })
    ).toBe("Sent — awaiting payment");
    expect(invoicePaymentLabel({ ...baseInvoice, payment_status: "DISPUTED" })).toBe("Disputed");
    expect(
      invoicePaymentLabel({
        ...baseInvoice,
        payment_status: "DISPUTED",
        dispute_resolution: "RESOLVED_WRITTEN_OFF"
      })
    ).toBe("Disputed — written off");
    expect(
      invoicePaymentLabel({
        ...baseInvoice,
        payment_status: "DISPUTED",
        dispute_resolution: "RESOLVED_ADJUSTED"
      })
    ).toBe("Disputed — adjusted");
    expect(invoicePaymentLabel({ ...baseInvoice, payment_status: "PAID" })).toBe("Paid");
  });

  const makeBoardItem = (overrides: Partial<InvoiceBoardItem> = {}): InvoiceBoardItem => ({
    id: "inv-1",
    case_id: "case-1",
    version: 1,
    actuals: {
      glass_cost_cents: 20000,
      labor_cents: 12500,
      profit_cents: 25000,
      tax_cents: 1250,
      sell_price_cents: 58750,
      price_calculation_id: "pc-1",
      quote_id: "q-1",
      quote_version: 1,
      source: "signed_quote"
    },
    created_at: "2026-10-20T12:00:00.000Z",
    payment_status: "UNSENT",
    sent_at: null,
    sent_via: null,
    sent_to: null,
    paid_at: null,
    paid_method: null,
    paid_ref: null,
    paid_by: null,
    dispute_reason_code: null,
    dispute_reason: null,
    disputed_at: null,
    dispute_resolution: null,
    dispute_resolved_at: null,
    aging_days: null,
    closable: false,
    case_reference: "RRA-000001",
    case_state: "INVOICED",
    channel: "DIRECT",
    vehicle: { year: 2020, make: "Honda", model: "Accord" },
    glass_type: "WINDSHIELD",
    bill_to: "Jane Customer",
    awaiting_payment: false,
    ...overrides
  });

  it("groups rows in collections order and drops empty groups", () => {
    const groups = groupInvoiceBoard([
      makeBoardItem({ id: "p", payment_status: "PAID" }),
      makeBoardItem({ id: "s", payment_status: "SENT" }),
      makeBoardItem({ id: "u", payment_status: "UNSENT" })
    ]);
    expect(groups.map(g => g.status)).toEqual(["UNSENT", "SENT", "PAID"]);
    expect(groups[1].items.map(i => i.id)).toEqual(["s"]);
  });

  describe("board rendering", () => {
    afterEach(() => cleanup());

    function stubBoardFetch(items: InvoiceBoardItem[]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url).includes("/invoices")) {
            return { ok: true, status: 200, json: async () => items };
          }
          return { ok: true, status: 200, json: async () => [] };
        })
      );
    }

    it("renders groups with aging and dispute reasons, and opens cases on click", async () => {
      const onOpenCase = vi.fn();
      stubBoardFetch([
        makeBoardItem({
          id: "sent-1",
          case_id: "case-sent",
          case_reference: "RRA-000101",
          payment_status: "SENT",
          sent_at: "2026-10-14T12:00:00.000Z",
          aging_days: 6,
          case_state: "SERVICE_COMPLETED",
          awaiting_payment: true
        }),
        makeBoardItem({
          id: "disp-1",
          case_id: "case-disp",
          case_reference: "RRA-000102",
          payment_status: "DISPUTED",
          dispute_reason: "Total looks wrong"
        })
      ]);
      render(<InvoiceBoard onOpenCase={onOpenCase} />);

      expect(await screen.findByText(/Awaiting payment \(1\)/)).toBeInTheDocument();
      expect(screen.getByText(/Disputed \(1\)/)).toBeInTheDocument();
      expect(screen.getByText(/Sent — awaiting payment \(6d\)/)).toBeInTheDocument();
      expect(screen.getByText(/service complete, awaiting payment/)).toBeInTheDocument();
      expect(screen.getByText(/Total looks wrong/)).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("board-row-RRA-000101"));
      expect(onOpenCase).toHaveBeenCalledWith("case-sent");

      // The Disputed pill narrows the board to the disputed group only.
      fireEvent.click(screen.getByRole("button", { name: "Disputed" }));
      expect(screen.queryByText(/Awaiting payment \(1\)/)).not.toBeInTheDocument();
      expect(screen.getByText(/Disputed \(1\)/)).toBeInTheDocument();
    });

    it("shows the empty state when nothing is owed", async () => {
      stubBoardFetch([]);
      render(<InvoiceBoard onOpenCase={vi.fn()} />);
      expect(await screen.findByText("No invoices in this state yet.")).toBeInTheDocument();
    });
  });
});

describe("typed quote signature", () => {
  afterEach(() => cleanup());

  it("requires a first AND last name", () => {
    expect(isValidSignatureName("")).toBe(false);
    expect(isValidSignatureName("   ")).toBe(false);
    expect(isValidSignatureName("Jane")).toBe(false);
    expect(isValidSignatureName(" Jane ")).toBe(false);
    expect(isValidSignatureName("Jane Customer")).toBe(true);
    expect(isValidSignatureName("Jane  Customer")).toBe(true);
    expect(isValidSignatureName("Mary Jane Watson")).toBe(true);
  });

  const baseView = {
    reference: "RRA-000042",
    channel: "DIRECT",
    noun: "quote",
    vehicle: { year: 2020, make: "Honda", model: "Accord" },
    glass_type: "WINDSHIELD",
    labor_cents: 12500,
    tax_cents: 1000,
    total_cents: 40000,
    quote_version: 1,
    expires_at: "2099-01-01T00:00:00.000Z",
    signed_by: null,
    signed_at: null,
    signature_method: null
  };

  function stubQuoteFetch(view: Record<string, unknown>) {
    const posts: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: { body?: unknown; method?: string }) => {
        const u = String(url);
        if (u.includes("/sign") && init?.method === "POST") {
          posts.push({ url: u, body: String(init.body ?? "") });
          return {
            ok: true,
            json: async () => ({
              ok: true,
              status: "APPROVED",
              invoice_version: 1,
              tracking_token: "rnappr_tracktoken"
            })
          };
        }
        return { ok: true, json: async () => view };
      })
    );
    return posts;
  }

  it("signs with a typed name only — no pad, live preview, inline error", async () => {
    const posts = stubQuoteFetch({ ...baseView, status: "AWAITING_SIGNATURE" });
    render(<PublicQuotePage token="rnappr_testtoken" />);

    // The form: one Signature field, the instruction from the pattern, and
    // NO drawing canvas anywhere.
    const field = (await screen.findByLabelText(/^Signature$/)) as HTMLInputElement;
    expect(screen.getByText("Enter your first and last name in the signature field.")).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeNull();
    expect(screen.queryByTestId("signature-pad")).not.toBeInTheDocument();

    const signButton = screen.getByRole("button", { name: /Sign & approve quote/ }) as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);

    // One word: inline error after blur, button stays disabled, and the
    // preview still renders what was typed.
    fireEvent.change(field, { target: { value: "Jane" } });
    fireEvent.blur(field);
    expect(await screen.findByText(/first and last name — both are needed to sign/)).toBeInTheDocument();
    expect(signButton.disabled).toBe(true);
    const preview = screen.getByTestId("signature-preview");
    expect(preview.querySelector(".signature-render")?.textContent).toBe("Jane");

    // First + last name: error clears, button enables, signing posts the
    // name with NO signature_data_url.
    fireEvent.change(field, { target: { value: "Jane Customer" } });
    expect(screen.queryByText(/both are needed to sign/)).not.toBeInTheDocument();
    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);

    expect(
      await screen.findByText(/your quote is approved and your invoice has been created/)
    ).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0].body) as Record<string, unknown>;
    expect(body.name).toBe("Jane Customer");
    expect(body).not.toHaveProperty("signature_data_url");
  });

  it("renders an approved typed signature as the name in a signature style", async () => {
    stubQuoteFetch({
      ...baseView,
      status: "APPROVED",
      signed_by: "Jane Customer",
      signed_at: "2026-10-21T14:00:00.000Z",
      signature_method: "typed"
    });
    render(<PublicQuotePage token="rnappr_testtoken" />);

    const rendered = await screen.findByTestId("signature-render");
    expect(rendered.textContent).toBe("Jane Customer");
    expect(rendered).toHaveClass("signature-render");
    expect(screen.getByText(/Electronically signed by Jane Customer/)).toBeInTheDocument();
    expect(screen.queryByTestId("signature-image")).not.toBeInTheDocument();
  });

  it("keeps a legacy drawn signature on the public page as plain text (image is staff-only)", async () => {
    stubQuoteFetch({
      ...baseView,
      status: "APPROVED",
      signed_by: "Jane Customer",
      signed_at: "2026-10-21T14:00:00.000Z",
      signature_method: "drawn"
    });
    render(<PublicQuotePage token="rnappr_testtoken" />);

    expect(await screen.findByText(/Signed by/)).toBeInTheDocument();
    expect(screen.queryByTestId("signature-render")).not.toBeInTheDocument();
    expect(screen.queryByTestId("signature-image")).not.toBeInTheDocument();
  });

  it("SignatureRender: typed records render the styled name + caption", () => {
    render(
      <SignatureRender
        signature={{
          name: "Jane Customer",
          signed_at: "2026-10-21T14:00:00.000Z",
          method: "typed",
          signature_data_url: ""
        }}
      />
    );
    const rendered = screen.getByTestId("signature-render");
    expect(rendered.textContent).toBe("Jane Customer");
    expect(screen.getByText(/Electronically signed by Jane Customer/)).toBeInTheDocument();
    expect(screen.queryByTestId("signature-image")).not.toBeInTheDocument();
  });

  it("SignatureRender: legacy drawn records (no method) render as their image", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    render(
      <SignatureRender
        signature={{
          name: "Jane Customer",
          signed_at: "2026-10-21T14:00:00.000Z",
          signature_data_url: dataUrl
        }}
      />
    );
    const img = screen.getByTestId("signature-image") as HTMLImageElement;
    expect(img.src).toBe(dataUrl);
    expect(screen.queryByTestId("signature-render")).not.toBeInTheDocument();
    expect(screen.getByText(/Electronically signed by Jane Customer/)).toBeInTheDocument();
  });
});
