/**
 * Address suggestions for the public intake's service-address field.
 *
 * The customer must pick a REAL address (a suggestion from a geocoder),
 * never free text — fulfillment drives to this address, so an invalid
 * one is a failed job. The endpoint in app.ts proxies a provider
 * server-side; the provider is swappable via env:
 *
 *   ADDRESS_PROVIDER=nominatim  OpenStreetMap Nominatim (default)
 *   ADDRESS_PROVIDER=mock       deterministic fixtures (tests / e2e)
 *
 * Both providers return the same normalized shape. lat/lon and the
 * provider place id ride along so the stored address is verifiable
 * later (and so a future provider swap doesn't strand old records).
 */

export interface AddressSuggestion {
  /** Provider-scoped id, e.g. "nominatim:123456" or "mock:terrace-118". */
  place_id: string;
  /** The address exactly as the provider formats it (what the user picked). */
  formatted: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number;
  lon: number;
}

export interface AddressProvider {
  suggest(query: string): Promise<AddressSuggestion[]>;
}

/** Minimal fetch shape so tests can stub the network. */
type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * OpenStreetMap Nominatim. Usage policy requires a valid HTTP
 * User-Agent identifying the application; requests are US-only,
 * capped at 5, and go through the endpoint's cache + rate limiter.
 */
export class NominatimAddressProvider implements AddressProvider {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(fetchImpl?: FetchLike, baseUrl = "https://nominatim.openstreetmap.org") {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = baseUrl;
  }

  async suggest(query: string): Promise<AddressSuggestion[]> {
    const params = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      countrycodes: "us",
      limit: "5",
      q: query
    });
    const res = await this.fetchImpl(`${this.baseUrl}/search?${params.toString()}`, {
      headers: {
        "User-Agent": "CaseCore/1.0 (R&R Finest Auto Glass — intake address suggestions)",
        Accept: "application/json"
      }
    });
    if (!res.ok) {
      throw new Error(`Nominatim suggest failed: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as NominatimRow[];
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => mapNominatimRow(row)).filter((s) => s !== null);
  }
}

interface NominatimRow {
  place_id?: number | string;
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    state?: string;
    postcode?: string;
  };
}

function mapNominatimRow(row: NominatimRow): AddressSuggestion | null {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!row.display_name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const a = row.address ?? {};
  const street =
    [a.house_number, a.road].filter(Boolean).join(" ").trim() || a.road || null;
  return {
    place_id: `nominatim:${row.place_id ?? row.display_name}`,
    formatted: row.display_name,
    street,
    city: a.city ?? a.town ?? a.village ?? a.hamlet ?? null,
    state: a.state ?? null,
    zip: a.postcode ?? null,
    lat,
    lon
  };
}

/**
 * Deterministic fixtures for tests and e2e — never the network. A query
 * matches a fixture when every query token appears in the fixture's
 * searchable text, so partial typing behaves like a real autocomplete:
 * "118 terr" finds 118 Terrace St, "boston" lists the Boston fixtures.
 */
const MOCK_FIXTURES: AddressSuggestion[] = [
  {
    place_id: "mock:terrace-118",
    formatted: "118 Terrace St, Boston, MA 02120",
    street: "118 Terrace St",
    city: "Boston",
    state: "Massachusetts",
    zip: "02120",
    lat: 42.3349,
    lon: -71.0828
  },
  {
    place_id: "mock:bluehill-45",
    formatted: "45 Blue Hill Ave, Roxbury, MA 02119",
    street: "45 Blue Hill Ave",
    city: "Boston",
    state: "Massachusetts",
    zip: "02119",
    lat: 42.3262,
    lon: -71.0836
  },
  {
    place_id: "mock:boylston-800",
    formatted: "800 Boylston St, Boston, MA 02199",
    street: "800 Boylston St",
    city: "Boston",
    state: "Massachusetts",
    zip: "02199",
    lat: 42.3472,
    lon: -71.0825
  },
  {
    place_id: "mock:massave-1200",
    formatted: "1200 Massachusetts Ave, Cambridge, MA 02138",
    street: "1200 Massachusetts Ave",
    city: "Cambridge",
    state: "Massachusetts",
    zip: "02138",
    lat: 42.3795,
    lon: -71.117
  }
];

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export class MockAddressProvider implements AddressProvider {
  async suggest(query: string): Promise<AddressSuggestion[]> {
    const tokens = normalizeForMatch(query).split(" ").filter(Boolean);
    if (tokens.length === 0) return [];
    return MOCK_FIXTURES.filter((fixture) => {
      const haystack = normalizeForMatch(
        `${fixture.formatted} ${fixture.street ?? ""} ${fixture.city ?? ""} ${fixture.zip ?? ""}`
      );
      return tokens.every((t) => haystack.includes(t));
    }).slice(0, 5);
  }
}

/** Provider selection: env ADDRESS_PROVIDER=nominatim|mock (default nominatim). */
export function createAddressProvider(
  env: NodeJS.ProcessEnv = process.env
): AddressProvider {
  return env.ADDRESS_PROVIDER === "mock"
    ? new MockAddressProvider()
    : new NominatimAddressProvider();
}
