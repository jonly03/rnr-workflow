import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createAddressProvider,
  MockAddressProvider,
  NominatimAddressProvider,
  type AddressProvider,
  type AddressSuggestion
} from "../src/address.js";
import { createApp, type SecurityConfig } from "../src/app.js";
import { JsonCaseStore } from "../src/store.js";

const TEST_AUTH_SECRET = "<redacted>";

async function fixture(
  securityConfig: SecurityConfig = {},
  deps: { addressProvider?: AddressProvider } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-address-"));
  const store = new JsonCaseStore(path.join(dir, "cases.json"));
  const app = createApp(
    store,
    { authSecret: TEST_AUTH_SECRET },
    securityConfig,
    { addressProvider: new MockAddressProvider(), ...deps }
  );
  return { app };
}

const FIXTURE: AddressSuggestion = {
  place_id: "mock:terrace-118",
  formatted: "118 Terrace St, Boston, MA 02120",
  street: "118 Terrace St",
  city: "Boston",
  state: "Massachusetts",
  zip: "02120",
  lat: 42.3349,
  lon: -71.0828
};

describe("GET /api/v1/public/address/suggest", () => {
  it("returns the mock provider's deterministic matches for a partial query", async () => {
    const { app } = await fixture();
    const res = await request(app)
      .get("/api/v1/public/address/suggest")
      .query({ q: "118 terr" })
      .expect(200);
    expect(res.body.suggestions).toEqual([FIXTURE]);

    const cityWide = await request(app)
      .get("/api/v1/public/address/suggest")
      .query({ q: "boston" })
      .expect(200);
    expect(cityWide.body.suggestions.length).toBeGreaterThan(1);
    expect(cityWide.body.suggestions[0]).toEqual(FIXTURE);
  });

  it("returns an empty list for short or missing queries without calling the provider", async () => {
    let calls = 0;
    const counting: AddressProvider = {
      suggest: async () => {
        calls += 1;
        return [FIXTURE];
      }
    };
    const { app } = await fixture({}, { addressProvider: counting });
    const short = await request(app)
      .get("/api/v1/public/address/suggest")
      .query({ q: "ab" })
      .expect(200);
    expect(short.body.suggestions).toEqual([]);
    const missing = await request(app).get("/api/v1/public/address/suggest").expect(200);
    expect(missing.body.suggestions).toEqual([]);
    expect(calls).toBe(0);
  });

  it("caches repeated lookups for the same normalized query", async () => {
    let calls = 0;
    const counting: AddressProvider = {
      suggest: async () => {
        calls += 1;
        return [FIXTURE];
      }
    };
    const { app } = await fixture({}, { addressProvider: counting });
    await request(app).get("/api/v1/public/address/suggest").query({ q: "118 Terrace" }).expect(200);
    await request(app).get("/api/v1/public/address/suggest").query({ q: "118  terrace " }).expect(200);
    expect(calls).toBe(1);
  });

  it("rate-limits per IP", async () => {
    const { app } = await fixture({ addressSuggestRateLimitMax: 2 });
    await request(app).get("/api/v1/public/address/suggest").query({ q: "boston" }).expect(200);
    await request(app).get("/api/v1/public/address/suggest").query({ q: "cambridge" }).expect(200);
    const limited = await request(app)
      .get("/api/v1/public/address/suggest")
      .query({ q: "roxbury" })
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("answers 502 (client-safe) when the provider fails", async () => {
    const failing: AddressProvider = {
      suggest: async () => {
        throw new Error("geocoder down");
      }
    };
    const { app } = await fixture({}, { addressProvider: failing });
    const res = await request(app)
      .get("/api/v1/public/address/suggest")
      .query({ q: "boston" })
      .expect(502);
    expect(res.body.error.code).toBe("ADDRESS_LOOKUP_FAILED");
    expect(JSON.stringify(res.body)).not.toContain("geocoder down");
  });
});

describe("address providers", () => {
  it("mock provider: no match yields an empty list; queries are token-based", async () => {
    const mock = new MockAddressProvider();
    expect(await mock.suggest("zzz nowhere")).toEqual([]);
    expect(await mock.suggest("02120")).toEqual([FIXTURE]);
  });

  it("env factory: ADDRESS_PROVIDER=mock selects the mock, anything else Nominatim", () => {
    expect(createAddressProvider({ ADDRESS_PROVIDER: "mock" })).toBeInstanceOf(
      MockAddressProvider
    );
    expect(createAddressProvider({})).toBeInstanceOf(NominatimAddressProvider);
    expect(createAddressProvider({ ADDRESS_PROVIDER: "nominatim" })).toBeInstanceOf(
      NominatimAddressProvider
    );
  });

  it("nominatim mapping: structured address fields come from addressdetails, with a proper User-Agent", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> | undefined;
    const stubFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
      seenUrl = url;
      seenHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            place_id: 987654,
            display_name: "118, Terrace Street, Boston, Suffolk County, Massachusetts, 02120, United States",
            lat: "42.3349",
            lon: "-71.0828",
            address: {
              house_number: "118",
              road: "Terrace Street",
              city: "Boston",
              state: "Massachusetts",
              postcode: "02120"
            }
          }
        ]
      };
    };
    const provider = new NominatimAddressProvider(stubFetch);
    const out = await provider.suggest("118 Terrace St Boston");
    expect(out).toEqual([
      {
        place_id: "nominatim:987654",
        formatted:
          "118, Terrace Street, Boston, Suffolk County, Massachusetts, 02120, United States",
        street: "118 Terrace Street",
        city: "Boston",
        state: "Massachusetts",
        zip: "02120",
        lat: 42.3349,
        lon: -71.0828
      }
    ]);
    expect(seenUrl).toContain("countrycodes=us");
    expect(seenUrl).toContain("addressdetails=1");
    expect(seenUrl).toContain("limit=5");
    expect(seenHeaders?.["User-Agent"]).toContain("CaseCore");
  });
});
