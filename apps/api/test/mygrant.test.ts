import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserServiceTransport,
  createGlassCatalogProvider,
  createSourcingProvider,
  extractHiddenFields,
  HttpMyGrantTransport,
  loadMyGrantConfig,
  loadMyGrantFixtures,
  MYGRANT_VIN_LOOKUP_COST_USD,
  MyGrantError,
  MyGrantSourcingProvider,
  MyGrantWebProvider,
  parsePartSearchResults,
  parseVinLookupsRemaining,
  parseVinResults,
  parseYmmVehicleList,
  parseVehicleParts,
  RecordingMyGrantTransport,
  ReplayMyGrantTransport,
  serializeMyGrantFixtures,
  siteGlassTypeValue,
  type MyGrantConfig,
  type MyGrantTransport
} from "../src/mygrant.js";
import { MockGlassCatalogProvider } from "../src/glass-catalog.js";

const CONFIG: MyGrantConfig = {
  baseUrl: "https://mygrant.test",
  username: "shop",
  password: "secret",
  timeoutMs: 5000
};

// ---------------------------------------------------------------------------
// Real fixtures: sanitized live captures 2026-09-29 (see
// test/fixtures/mygrant/README.md). The VIN results page is reconstructed
// from field notes of the single authorized $1 lookup.
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/mygrant/${name}`, import.meta.url), "utf-8");
}

function loginPageHtml(): string {
  return `<html><body><form>
    <input type="hidden" name="__VIEWSTATE" value="vs123" />
    <input type="text" name="clogin:TxtUsername" />
    <input type="password" name="clogin:TxtPassword" />
    <input type="submit" name="clogin:ButtonLogin" value="Login" />
  </form></body></html>`;
}

function authedChrome(inner: string): string {
  return `<html><body><a href="logout.aspx">Logout</a> ${inner}</body></html>`;
}

/** VIN form fixture with the credits counter set to `remaining`. */
function vinFormHtml(remaining: number): string {
  return fixture("vin-search-form.html").replace(
    '<span id="cvs_lookupCredits">8</span>',
    `<span id="cvs_lookupCredits">${remaining}</span>`
  );
}

/** Scripted transport stub with a call log. Routes on the request URL. */
class StubTransport implements MyGrantTransport {
  calls: Array<{ op: string; url: string; fields?: Record<string, string> }> = [];
  constructor(
    private onGet: (url: string) => string | Promise<string>,
    private onPost: (url: string, fields: Record<string, string>) => string | Promise<string>
  ) {}
  async get(url: string): Promise<string> {
    this.calls.push({ op: "get", url });
    return this.onGet(url);
  }
  async postForm(url: string, fields: Record<string, string>): Promise<string> {
    this.calls.push({ op: "postForm", url, fields });
    return this.onPost(url, fields);
  }
  async close(): Promise<void> {}
}

/**
 * Full stub of the live site: login POST, VIN form GET (credits counter),
 * VIN submission GET (query has vin=...), YMM GET, part-search GET.
 */
function liveSiteTransport(overrides: { credits?: number } = {}): StubTransport {
  const credits = overrides.credits ?? 8;
  return new StubTransport(
    url => {
      if (url.includes("/pages/login.aspx")) return loginPageHtml();
      if (url.includes("/pages/searchvin.aspx")) {
        return url.includes("vin=") ? fixture("vin-results-wrangler-reconstructed.html") : vinFormHtml(credits);
      }
      if (url.includes("/pages/searchm.aspx")) return fixture("ymm-results-2020-honda-a.html");
      if (url.includes("/pages/search.aspx")) return fixture("part-search-dw02416-gty.html");
      throw new Error(`unexpected GET ${url}`);
    },
    url => {
      if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
      throw new Error(`unexpected POST ${url}`);
    }
  );
}

function submittedVinUrls(transport: StubTransport): string[] {
  return transport.calls.filter(c => c.op === "get" && c.url.includes("vin=")).map(c => c.url);
}

// ---------------------------------------------------------------------------
// Provider selection (env switch).
// ---------------------------------------------------------------------------

describe("createGlassCatalogProvider", () => {
  it("defaults to the mock provider", () => {
    const provider = createGlassCatalogProvider({} as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockGlassCatalogProvider);
    expect(provider.name).toBe("mock-catalog");
  });

  it("selects the live MyGrant provider when configured", () => {
    const provider = createGlassCatalogProvider({
      GLASS_CATALOG_PROVIDER: "mygrant",
      MYGRANT_USERNAME: "shop",
      MYGRANT_PASSWORD: "secret"
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MyGrantWebProvider);
    expect(provider.name).toBe("mygrant-web");
  });

  it("fails loudly when live is selected without credentials", () => {
    expect(() =>
      createGlassCatalogProvider({ GLASS_CATALOG_PROVIDER: "mygrant" } as NodeJS.ProcessEnv)
    ).toThrowError(MyGrantError);
    try {
      createGlassCatalogProvider({ GLASS_CATALOG_PROVIDER: "mygrant" } as NodeJS.ProcessEnv);
    } catch (error) {
      expect((error as MyGrantError).code).toBe("MYGRANT_NOT_CONFIGURED");
    }
  });

  it("fails loudly on an unknown provider name", () => {
    expect(() =>
      createGlassCatalogProvider({ GLASS_CATALOG_PROVIDER: "acme" } as NodeJS.ProcessEnv)
    ).toThrowError(/Unknown GLASS_CATALOG_PROVIDER/);
  });

  it("documents the $1 VIN lookup cost", () => {
    expect(MYGRANT_VIN_LOOKUP_COST_USD).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fail-loud live behavior.
// ---------------------------------------------------------------------------

describe("MyGrantWebProvider fail-loud contract", () => {
  it("rejects login failures loudly (no silent anonymous session)", async () => {
    const transport = new StubTransport(
      () => loginPageHtml(),
      () => loginPageHtml() // still showing the login form: rejected
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(provider.lookupVin("1HGCM82633A004352", "WINDSHIELD")).rejects.toMatchObject({
      name: "MyGrantError",
      code: "MYGRANT_AUTH_FAILED"
    });
  });

  it("propagates transport failures as MyGrantError, never mock data", async () => {
    const boom = () => {
      throw new MyGrantError("MYGRANT_UNAVAILABLE", "boom", 502);
    };
    const transport = new StubTransport(boom, boom);
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const err = await provider
      .lookupVin("1HGCM82633A004352", "WINDSHIELD")
      .catch(e => e);
    expect(err).toBeInstanceOf(MyGrantError);
    expect(err.code).toBe("MYGRANT_UNAVAILABLE");
  });

  it("refuses the $1 lookup when credits are exhausted — without submitting", async () => {
    const transport = liveSiteTransport({ credits: 0 });
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(
      provider.lookupVin("1HGCM82633A004352", "WINDSHIELD")
    ).rejects.toMatchObject({ code: "MYGRANT_NO_CREDITS" });
    // The VIN was never submitted.
    expect(submittedVinUrls(transport)).toHaveLength(0);
  });

  it("refuses to spend when the credits counter cannot be read", async () => {
    const transport = new StubTransport(
      url => (url.includes("login.aspx") ? loginPageHtml() : "<html><body>no counter here</body></html>"),
      () => authedChrome("<p>home</p>")
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(
      provider.lookupVin("1HGCM82633A004352", "WINDSHIELD")
    ).rejects.toMatchObject({ code: "MYGRANT_PARSE_ERROR" });
    expect(submittedVinUrls(transport)).toHaveLength(0);
  });

  it("submits the VIN via GET with the real form params and parses the result", async () => {
    const transport = liveSiteTransport({ credits: 5 });
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const result = await provider.lookupVin("1C4HJXEG3JW224862", "WINDSHIELD");

    // Real form transport: GET searchvin.aspx?vin=...&cvs:GlassTypeSelect=...&svindo=Search
    const submitted = submittedVinUrls(transport);
    expect(submitted).toHaveLength(1);
    const query = new URL(submitted[0]).searchParams;
    expect(query.get("vin")).toBe("1C4HJXEG3JW224862");
    expect(query.get("cvs:GlassTypeSelect")).toBe("Windshield");
    expect(query.get("svindo")).toBe("Search");

    // Real parsed content (2018 Jeep Wrangler capture).
    expect(result.vin).toBe("1C4HJXEG3JW224862");
    expect(result.decoded).toMatchObject({ year: 2018, make: "Jeep", model: "Wrangler" });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].part_number).toBe("DW02415 GTY");
    expect(result.candidates[0].position).toBe("WINDSHIELD");
    expect(result.candidates[0].features).toEqual(["Solar Glass", "Acoustic Glass", "Willys Logo"]);
    expect(result.interchangePartNumbers).toEqual(["DW02416 GTY"]);
    expect(result.oemPartNumbers).toEqual(["68291705AA", "68433234AA", "68433234AB", "68433234AC"]);
  });

  it("maps Back Glass to the site's Back option value", async () => {
    const transport = liveSiteTransport({ credits: 3 });
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await provider.lookupVin("1C4HJXEG3JW224862", "BACK_GLASS");
    const submitted = submittedVinUrls(transport);
    expect(submitted).toHaveLength(1);
    expect(new URL(submitted[0]).searchParams.get("cvs:GlassTypeSelect")).toBe("Back");
  });

  it("refuses unsupported glass types without submitting (site only offers Windshield/Back)", async () => {
    const transport = liveSiteTransport({ credits: 8 });
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(provider.lookupVin("1C4HJXEG3JW224862", "DOOR_GLASS")).rejects.toMatchObject({
      code: "MYGRANT_UNSUPPORTED_GLASS_TYPE"
    });
    expect(submittedVinUrls(transport)).toHaveLength(0);
  });

  it("retries YMM with title-cased make when ALL CAPS matches nothing (NHTSA vs MyGrant casing)", async () => {
    const emptyYmm = '<div id="cms_DivModels"><ol></ol></div>';
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          const mk = new URL(url).searchParams.get("mk");
          // The live site is case-sensitive: only title case matches.
          return mk === "Jeep" ? fixture("ymm-results-2020-honda-a.html") : emptyYmm;
        }
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const vehicles = await provider.searchYmmVehicles({ year: 2018, make: "JEEP", model: "W", glassType: "WINDSHIELD" });
    expect(vehicles.length).toBeGreaterThan(0);
    const mkValues = transport.calls
      .filter(c => c.op === "get" && c.url.includes("/pages/searchm.aspx?"))
      .map(c => new URL(c.url).searchParams.get("mk"));
    expect(mkValues).toEqual(["JEEP", "Jeep"]);
  });

  it("resolves YMM to the real vehicle list via GET", async () => {
    const transport = liveSiteTransport();
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const vehicles = await provider.searchYmmVehicles({ year: 2020, make: "Honda", model: "A", glassType: "WINDSHIELD" });
    expect(vehicles).toHaveLength(4);
    expect(vehicles[0].name).toBe("Honda Accord 2020 4 Door Sedan");
    expect(vehicles[0].detailPath).toContain("v=Honda+Accord+2020+4+Door+Sedan");
    const ymmCall = transport.calls.find(c => c.op === "get" && c.url.includes("/pages/searchm.aspx?"));
    expect(ymmCall).toBeDefined();
    const query = new URL(ymmCall!.url).searchParams;
    expect(query.get("yr")).toBe("2020");
    expect(query.get("mk")).toBe("Honda");
    expect(query.get("md")).toBe("A");
    expect(query.get("smdo")).toBe("Search");
  });

  it("sends only the first model character for YMM search (site model match is case-sensitive)", async () => {
    const emptyYmm = '<div id="cms_DivModels"><ol></ol></div>';
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          // Regression: 2026-09-30 the full VIN-decoded model "Wrangler"
          // matched 0 vehicles on the live site while "W" matched 6.
          const md = new URL(url).searchParams.get("md");
          return md === "W" ? fixture("ymm-results-2020-honda-a.html") : emptyYmm;
        }
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    // VIN decode supplies the full model name; the site needs the prefix.
    const vehicles = await provider.searchYmmVehicles({ year: 2018, make: "Jeep", model: "Wrangler", glassType: "WINDSHIELD" });
    expect(vehicles.length).toBeGreaterThan(0);
    const mdValues = transport.calls
      .filter(c => c.op === "get" && c.url.includes("/pages/searchm.aspx?"))
      .map(c => new URL(c.url).searchParams.get("md"));
    expect(mdValues).toEqual(["W"]);
  });

  it("fails YMM loudly with a response fingerprint when every attempt returns nothing", async () => {
    const emptyYmm = '<html><head><title>MyGrant Search</title></head><body><div id="cms_DivModels"><ol></ol></div></body></html>';
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) return emptyYmm;
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const err = await provider
      .searchYmmVehicles({ year: 2018, make: "JEEP", model: "Wrangler", glassType: "WINDSHIELD" })
      .catch(e => e);
    expect(err).toBeInstanceOf(MyGrantError);
    expect(err.code).toBe("MYGRANT_NO_VEHICLES");
    // The fingerprint names the site's response shape so the next debug
    // round doesn't start from "0 vehicles" alone.
    expect(err.message).toContain("matched 0 vehicles for 2018 JEEP Wrangler");
    expect(err.message).toContain("Response: title=");
    expect(err.message).toContain("markers=[cms_DivModels]");
  });

  it("routes page loads through the browser service when MYGRANT_BROWSER_URL is set", async () => {
    const browserHtml = authedChrome(fixture("ymm-results-2020-honda-a.html"));
    const fetchCalls: Array<{ url: string; body: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), body: String(init?.body ?? ""), auth: init?.headers?.Authorization ?? null });
      return new Response(JSON.stringify({ html: browserHtml }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;
    const prevUrl = process.env.MYGRANT_BROWSER_URL;
    const prevSecret = process.env.MYGRANT_BROWSER_SECRET;
    process.env.MYGRANT_BROWSER_URL = "https://browser.test";
    process.env.MYGRANT_BROWSER_SECRET = "s3cret";
    try {
      // No injected transport: the provider must build a BrowserServiceTransport.
      const provider = new MyGrantWebProvider(CONFIG);
      const vehicles = await provider.searchYmmVehicles({ year: 2020, make: "Honda", model: "A", glassType: "WINDSHIELD" });
      expect(vehicles.length).toBeGreaterThan(0);
      expect(fetchCalls.length).toBeGreaterThan(0);
      // Every page load went to the browser service's /v1/fetch with the secret.
      for (const call of fetchCalls) {
        expect(call.url).toBe("https://browser.test/v1/fetch");
        expect(call.auth).toBe("Bearer s3cret");
      }
      // The YMM search URL was delegated, with the single-char model prefix.
      const ymmCall = fetchCalls.find(c => c.body.includes("searchm.aspx?"));
      expect(ymmCall).toBeDefined();
      expect(new URL(JSON.parse(ymmCall!.body).url).searchParams.get("md")).toBe("A");
    } finally {
      globalThis.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.MYGRANT_BROWSER_URL;
      else process.env.MYGRANT_BROWSER_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.MYGRANT_BROWSER_SECRET;
      else process.env.MYGRANT_BROWSER_SECRET = prevSecret;
    }
  });

  it("BrowserServiceTransport surfaces service failures as MYGRANT_UNAVAILABLE", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    try {
      const transport = new BrowserServiceTransport("https://browser.test", "s3cret", 1000);
      await expect(transport.get("https://www.mygrantglass.com/pages/searchm.aspx")).rejects.toMatchObject({
        code: "MYGRANT_UNAVAILABLE"
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails YMM-to-candidates loudly: the vehicle→parts drill-down is not captured", async () => {
    const transport = liveSiteTransport();
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(
      provider.searchYmm({ year: 2020, make: "Honda", model: "A", glassType: "WINDSHIELD" })
    ).rejects.toMatchObject({ code: "MYGRANT_PARSE_ERROR" });
  });

  it("matches foreign-vehicle part prefixes: FW counts as a windshield part", async () => {
    // Regression 2026-09-30: a 2008 Honda Accord's parts are FW/FD/FB
    // (foreign NAGS prefixes). The old DW-only filter rejected all 6 parts
    // with: none matching glass type WINDSHIELD (prefix "DW").
    const vehicleList =
      `<div id="cms_DivModels"><ol><li>` +
      `<a href="?yr=2008&mk=Honda&md=A&v=Honda+Accord+2008+2+Door+Coupe">` +
      `Honda Accord 2008 2 Door Coupe</a></li></ol></div>`;
    const partsPage =
      `<div id="cms_DivParts"><table class="partlist">` +
      `<tr><td><a href="/pages/search.aspx?q=FW02260">FW02260</a></td><td>Windshield</td></tr>` +
      `<tr><td><a href="/pages/search.aspx?q=FD02261">FD02261</a></td><td>Door Glass</td></tr>` +
      `<tr><td><a href="/pages/search.aspx?q=FB02262">FB02262</a></td><td>Back Glass</td></tr>` +
      `</table></div>`;
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          return url.includes("v=") ? partsPage : vehicleList;
        }
        if (url.includes("/pages/search.aspx")) return fixture("part-search-dw02416-gty.html");
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const candidates = await provider.searchYmm({
      year: 2008, make: "Honda", model: "Accord", glassType: "WINDSHIELD"
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].position).toBe("WINDSHIELD");
    // Only the FW windshield part was priced — FD/FB parts were filtered out.
    const partQueries = transport.calls
      .filter(c => c.op === "get" && c.url.includes("/pages/search.aspx?"))
      .map(c => new URL(c.url).searchParams.get("q"));
    expect(partQueries).toEqual(["FW02260"]);
  });

  it("matches foreign-vehicle part prefixes: FD counts as a door-glass part", async () => {
    // Same foreign-prefix fix, DOOR_GLASS variant (regression for the
    // DOOR_GLASS case Nelly hit on the same 2008 Accord).
    const vehicleList =
      `<div id="cms_DivModels"><ol><li>` +
      `<a href="?yr=2008&mk=Honda&md=A&v=Honda+Accord+2008+2+Door+Coupe">` +
      `Honda Accord 2008 2 Door Coupe</a></li></ol></div>`;
    const partsPage =
      `<div id="cms_DivParts"><table class="partlist">` +
      `<tr><td><a href="/pages/search.aspx?q=FW02260">FW02260</a></td><td>Windshield</td></tr>` +
      `<tr><td><a href="/pages/search.aspx?q=FD02261">FD02261</a></td><td>Door Glass</td></tr>` +
      `</table></div>`;
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          return url.includes("v=") ? partsPage : vehicleList;
        }
        if (url.includes("/pages/search.aspx")) return fixture("part-search-dw02416-gty.html");
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const candidates = await provider.searchYmm({
      year: 2008, make: "Honda", model: "Accord", glassType: "DOOR_GLASS"
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].position).toBe("DOOR_GLASS");
    const partQueries = transport.calls
      .filter(c => c.op === "get" && c.url.includes("/pages/search.aspx?"))
      .map(c => new URL(c.url).searchParams.get("q"));
    expect(partQueries).toEqual(["FD02261"]);
  });

  it("searches part numbers via GET and parses stock/price", async () => {
    const transport = liveSiteTransport();
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const results = await provider.searchPartNumber("DW02416 GTY");
    expect(results.warehouse).toContain("Randolph, MA");
    expect(results.results).toHaveLength(1);
    expect(results.results[0]).toMatchObject({
      part_number: "DW02416 GTY FYG",
      stock: "in_stock",
      price_cents: 9225
    });
    const partCall = transport.calls.find(c => c.op === "get" && c.url.includes("/pages/search.aspx?"));
    expect(partCall).toBeDefined();
    const query = new URL(partCall!.url).searchParams;
    expect(query.get("q")).toBe("DW02416 GTY");
    expect(query.get("sc")).toBe("B036");
    expect(query.get("do")).toBe("Search");
  });

  it("rejects unknown warehouse codes without searching", async () => {
    const transport = liveSiteTransport();
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(provider.searchPartNumber("DW02416 GTY", "XX99")).rejects.toMatchObject({
      code: "MYGRANT_PARSE_ERROR"
    });
    expect(transport.calls.some(c => c.url.includes("/pages/search.aspx?"))).toBe(false);
  });

  it("retries a part search whose first page read missed the results table", async () => {
    // Regression 2026-09-30: a 2025 Subaru Crosstrek windshield YMM search
    // failed twice with "no recognizable part results table
    // (#table_searchparts)" — the browser service can return a mid-navigation
    // read (post-load redirect) for a single part page. One re-fetch must
    // recover instead of failing the whole identification.
    const vehicleList =
      `<div id="cms_DivModels"><ol><li>` +
      `<a href="?yr=2025&mk=Subaru&md=C&v=Subaru+Crosstrek+2025+4+Door+Utility">` +
      `Subaru Crosstrek 2025 4 Door Utility</a></li></ol></div>`;
    const partsPage =
      `<div id="cms_DivParts"><table class="partlist">` +
      `<tr><td><a href="/pages/search.aspx?q=FW02600">FW02600</a></td><td>Windshield</td></tr>` +
      `</table></div>`;
    const midNavigationRead = `<html><head><title>MyGrant Glass - Search</title></head>` +
      `<body><div id="cpsr_DivParts"><p>Loading, please wait...</p></div></body></html>`;
    let partSearchGets = 0;
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          return url.includes("v=") ? partsPage : vehicleList;
        }
        if (url.includes("/pages/search.aspx")) {
          partSearchGets++;
          // First read is the pre-redirect page; the re-fetch lands correctly.
          return partSearchGets === 1 ? midNavigationRead : fixture("part-search-dw02416-gty.html");
        }
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const candidates = await provider.searchYmm({
      year: 2025, make: "Subaru", model: "Crosstrek", glassType: "WINDSHIELD"
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(partSearchGets).toBe(2);
  });

  it("skips an unparseable part page and prices the next part", async () => {
    const vehicleList =
      `<div id="cms_DivModels"><ol><li>` +
      `<a href="?yr=2025&mk=Subaru&md=C&v=Subaru+Crosstrek+2025+4+Door+Utility">` +
      `Subaru Crosstrek 2025 4 Door Utility</a></li></ol></div>`;
    const partsPage =
      `<div id="cms_DivParts"><table class="partlist">` +
      `<tr><td><a href="/pages/search.aspx?q=FW02600">FW02600</a></td><td>Windshield acoustic</td></tr>` +
      `<tr><td><a href="/pages/search.aspx?q=FW02601">FW02601</a></td><td>Windshield</td></tr>` +
      `</table></div>`;
    const noTable = `<html><head><title>MyGrant Glass</title></head>` +
      `<body><div id="cpsr_DivParts"><p>No records found.</p></div></body></html>`;
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          return url.includes("v=") ? partsPage : vehicleList;
        }
        if (url.includes("/pages/search.aspx")) {
          const q = new URL(url).searchParams.get("q");
          // FW02600 genuinely has no results table; FW02601 parses fine.
          return q === "FW02601" ? fixture("part-search-dw02416-gty.html") : noTable;
        }
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const candidates = await provider.searchYmm({
      year: 2025, make: "Subaru", model: "Crosstrek", glassType: "WINDSHIELD"
    });
    expect(candidates.length).toBeGreaterThan(0);
    // The surviving candidates carry the description of the part that parsed.
    expect(candidates[0].description).toBe("Windshield");
  });

  it("still fails loudly when no part page parses, with a page fingerprint", async () => {
    const vehicleList =
      `<div id="cms_DivModels"><ol><li>` +
      `<a href="?yr=2025&mk=Subaru&md=C&v=Subaru+Crosstrek+2025+4+Door+Utility">` +
      `Subaru Crosstrek 2025 4 Door Utility</a></li></ol></div>`;
    const partsPage =
      `<div id="cms_DivParts"><table class="partlist">` +
      `<tr><td><a href="/pages/search.aspx?q=FW02600">FW02600</a></td><td>Windshield</td></tr>` +
      `</table></div>`;
    const noTable = `<html><head><title>MyGrant Glass - Part Search</title></head>` +
      `<body><div id="cpsr_DivParts"><p>Something changed.</p></div></body></html>`;
    const transport = new StubTransport(
      url => {
        if (url.includes("/pages/login.aspx")) return loginPageHtml();
        if (url.includes("/pages/searchm.aspx")) {
          return url.includes("v=") ? partsPage : vehicleList;
        }
        if (url.includes("/pages/search.aspx")) return noTable;
        throw new Error(`unexpected GET ${url}`);
      },
      url => {
        if (url.includes("/pages/login.aspx")) return authedChrome("<p>home</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const err = await provider
      .searchYmm({ year: 2025, make: "Subaru", model: "Crosstrek", glassType: "WINDSHIELD" })
      .catch(e => e);
    expect(err).toMatchObject({ code: "MYGRANT_PARSE_ERROR" });
    expect(String(err.message)).toContain("FW02600");
    expect(String(err.message)).toContain("markers=");
  });
});

// ---------------------------------------------------------------------------
// Parsers against the real fixtures.
// ---------------------------------------------------------------------------

describe("MyGrant page parsers", () => {
  it("reads the VIN lookups remaining counter from #cvs_lookupCredits", () => {
    expect(parseVinLookupsRemaining(fixture("vin-search-form.html"))).toBe(8);
    expect(parseVinLookupsRemaining(vinFormHtml(0))).toBe(0);
    expect(parseVinLookupsRemaining("<html><body>no counter</body></html>")).toBeNull();
  });

  it("parses the reconstructed VIN results page (selectors confirmed live)", () => {
    const result = parseVinResults(
      fixture("vin-results-wrangler-reconstructed.html"),
      "1C4HJXEG3JW224862",
      "WINDSHIELD"
    );
    expect(result.decoded).toEqual({ year: 2018, make: "Jeep", model: "Wrangler", trim: "4 Door Utility" });
    expect(result.candidates).toHaveLength(1);
    const primary = result.candidates[0];
    expect(primary.part_number).toBe("DW02415 GTY");
    expect(primary.position).toBe("WINDSHIELD");
    expect(primary.features).toEqual(["Solar Glass", "Acoustic Glass", "Willys Logo"]);
    // The VIN page carries no prices; pricing comes from part search.
    expect(primary.list_price_cents).toBe(0);
    // The interchange is NOT mistaken for the primary.
    expect(result.interchangePartNumbers).toEqual(["DW02416 GTY"]);
    expect(result.oemPartNumbers).toEqual(["68291705AA", "68433234AA", "68433234AB", "68433234AC"]);
  });

  it("throws MYGRANT_PARSE_ERROR when the VIN results container is missing", () => {
    expect(() => parseVinResults("<html><body>garbage</body></html>", "1C4HJXEG3JW224862", "WINDSHIELD"))
      .toThrowError(expect.objectContaining({ code: "MYGRANT_PARSE_ERROR" }));
  });

  it("parses the YMM vehicle list", () => {
    const vehicles = parseYmmVehicleList(fixture("ymm-results-2020-honda-a.html"));
    expect(vehicles.map(v => v.name)).toEqual([
      "Honda Accord 2020 4 Door Sedan",
      "Honda Accord ACCORD HYBRID 2020 4 Door Sedan",
      "Honda Clarity 2020 4 Door Sedan",
      "Honda Passport 2020 4 Door Utility"
    ]);
    expect(vehicles[3].detailPath).toBe("?yr=2020&mk=Honda&md=A&v=Honda+Passport+2020+4+Door+Utility");
  });

  it("treats an empty YMM list as no matches, not a parse failure", () => {
    const empty = fixture("ymm-results-2020-honda-a.html").replace(/<ol>[\s\S]*?<\/ol>/, "<ol></ol>");
    expect(parseYmmVehicleList(empty)).toEqual([]);
  });

  it("parses the vehicle drill-down parts page", () => {
    const parts = parseVehicleParts(fixture("ymm-vehicle-parts-wrangler-2018.html"));
    expect(parts.map(p => p.partNumber)).toEqual([
      "DW02414", "DW02415", "DW02416", "DW02417", "DB12927"
    ]);
    expect(parts[0].interchangePartNumbers).toEqual(["DW02417"]);
    expect(parts[1].interchangePartNumbers).toEqual(["DW02416"]);
    expect(parts[4].interchangePartNumbers).toEqual([]);
    expect(parts[0].description).toContain("Jeep Gladiator");
  });

  it("throws MYGRANT_PARSE_ERROR when the parts container is missing", () => {
    expect(() => parseVehicleParts("<html><body>garbage</body></html>"))
      .toThrowError(expect.objectContaining({ code: "MYGRANT_PARSE_ERROR" }));
  });

  it("parses the interchange part search (cheaper option)", () => {
    const parsed = parsePartSearchResults(fixture("part-search-dw02416-gty.html"));
    expect(parsed.warehouse).toContain("Randolph, MA");
    expect(parsed.results).toEqual([
      { part_number: "DW02416 GTY FYG", stock: "in_stock", price_cents: 9225 }
    ]);
  });

  it("parses the primary part search (pricier MOPAR option)", () => {
    const parsed = parsePartSearchResults(fixture("part-search-dw02415-gty.html"));
    expect(parsed.results).toEqual([
      { part_number: "DW02415 GTY MOP", stock: "in_stock", price_cents: 27450 }
    ]);
  });

  it("extracts hidden WebForms fields", () => {
    expect(
      extractHiddenFields(
        '<form><input type="hidden" name="__VIEWSTATE" value="vs1" />' +
          '<input type="hidden" name="__EVENTVALIDATION" value="ev2" /></form>'
      )
    ).toEqual({ __VIEWSTATE: "vs1", __EVENTVALIDATION: "ev2" });
  });

  it("maps glass types to the site's dropdown values", () => {
    expect(siteGlassTypeValue("WINDSHIELD")).toBe("Windshield");
    expect(siteGlassTypeValue("BACK_GLASS")).toBe("Back");
    expect(() => siteGlassTypeValue("DOOR_GLASS")).toThrowError(
      expect.objectContaining({ code: "MYGRANT_UNSUPPORTED_GLASS_TYPE" })
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture record/replay.
// ---------------------------------------------------------------------------

describe("fixture record/replay", () => {
  it("records and replays a lookup round-trip deterministically", async () => {
    const stub = liveSiteTransport({ credits: 5 });
    const recording = new RecordingMyGrantTransport(stub);
    const provider = new MyGrantWebProvider(CONFIG, recording);
    const live = await provider.lookupVin("1C4HJXEG3JW224862", "WINDSHIELD");
    expect(recording.fixtures.length).toBeGreaterThan(0);

    const json = serializeMyGrantFixtures(recording.fixtures);
    const replay = new ReplayMyGrantTransport(loadMyGrantFixtures(json));
    const replayed = await new MyGrantWebProvider(CONFIG, replay).lookupVin(
      "1C4HJXEG3JW224862",
      "WINDSHIELD"
    );
    expect(replayed).toEqual(live);
    expect(replay.consumed).toBe(recording.fixtures.length);
  });

  it("replay throws loudly on an unstubbed call", async () => {
    const replay = new ReplayMyGrantTransport([]);
    await expect(replay.get("https://mygrant.test/pages/searchvin.aspx")).rejects.toMatchObject({
      code: "MYGRANT_UNAVAILABLE"
    });
  });

  it("loadMyGrantConfig requires credentials", () => {
    expect(() => loadMyGrantConfig({} as NodeJS.ProcessEnv)).toThrowError(
      expect.objectContaining({ code: "MYGRANT_NOT_CONFIGURED" })
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP transport: WebForms postback mechanics (login still POSTs).
// ---------------------------------------------------------------------------

describe("HttpMyGrantTransport", () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  }

  function textResponse(body: string, status = 200, setCookie?: string): Response {
    const headers = new Headers();
    if (setCookie) headers.set("set-cookie", setCookie);
    return new Response(body, { status, headers });
  }

  it("merges __VIEWSTATE into the POST body", async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (init.method === "GET") {
        return textResponse(
          '<form><input type="hidden" name="__VIEWSTATE" value="abc+def==" /></form>'
        );
      }
      const body = String(init.body);
      expect(body).toContain("__VIEWSTATE=abc%2Bdef%3D%3D");
      expect(body).toContain("clogin%3ATxtUsername=shop");
      return textResponse("<p>ok</p>");
    });
    const transport = new HttpMyGrantTransport(5000, fetchImpl as unknown as typeof fetch);
    await transport.postForm("https://mygrant.test/pages/login.aspx", {
      "clogin:TxtUsername": "shop"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends stored cookies on subsequent requests", async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      seen.push(new Headers(init.headers).get("cookie") ?? "");
      const res = textResponse("<p>ok</p>");
      res.headers.set("set-cookie", "ASP.NET_SessionId=xyz; path=/");
      return res;
    });
    const transport = new HttpMyGrantTransport(5000, fetchImpl as unknown as typeof fetch);
    await transport.get("https://mygrant.test/a");
    await transport.get("https://mygrant.test/b");
    expect(seen[1]).toContain("ASP.NET_SessionId=xyz");
  });

  it("preserves Set-Cookie across the post-login redirect", async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch((url, init) => {
      seen.push(new Headers(init.headers).get("cookie") ?? "");
      if (url.endsWith("/pages/login.aspx") && init.method === "POST") {
        // ASP.NET Forms Auth: the auth cookie arrives on the 302, not the
        // final page. fetch's auto-redirect would swallow it.
        const headers = new Headers();
        headers.set("set-cookie", ".ASPXAUTH=auth-token; path=/");
        headers.set("location", "/pages/searchm.aspx");
        return new Response("", { status: 302, headers });
      }
      const authed = seen[seen.length - 1].includes(".ASPXAUTH=auth-token");
      return textResponse(
        authed
          ? "<a href='/logout'>logout</a><p>welcome</p>"
          : "<form><input name='clogin:TxtUsername'/></form>"
      );
    });
    const transport = new HttpMyGrantTransport(5000, fetchImpl as unknown as typeof fetch);
    const html = await transport.postForm("https://mygrant.test/pages/login.aspx", {
      "clogin:TxtUsername": "shop",
      "clogin:TxtPassword": "secret"
    });
    expect(html).toContain("logout");
    // The redirect hop follows with GET and no form body.
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2][1].method).toBe("GET");
    expect(calls[2][1].body).toBeUndefined();
    expect(calls[2][0]).toBe("https://mygrant.test/pages/searchm.aspx");
  });

  it("fails loudly on a redirect loop", async () => {
    const headers = new Headers();
    headers.set("location", "/pages/login.aspx");
    const fetchImpl = stubFetch(() => new Response("", { status: 302, headers }));
    const transport = new HttpMyGrantTransport(5000, fetchImpl as unknown as typeof fetch);
    await expect(transport.get("https://mygrant.test/pages/login.aspx")).rejects.toMatchObject({
      code: "MYGRANT_UNAVAILABLE"
    });
  });

  it("maps HTTP errors and timeouts to MYGRANT_UNAVAILABLE", async () => {
    const bad = new HttpMyGrantTransport(
      5000,
      stubFetch(() => textResponse("nope", 500)) as unknown as typeof fetch
    );
    await expect(bad.get("https://mygrant.test/a")).rejects.toMatchObject({
      code: "MYGRANT_UNAVAILABLE"
    });

    const slow = new HttpMyGrantTransport(
      50,
      stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            // Real fetch rejects when the abort signal fires; mirror that.
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      ) as unknown as typeof fetch
    );
    await expect(slow.get("https://mygrant.test/a")).rejects.toMatchObject({
      code: "MYGRANT_UNAVAILABLE"
    });
  });
});

// ---------------------------------------------------------------------------
// MyGrant sourcing provider: free part searches mapped onto the sourcing
// contract, with call-to-verify excluded from auto-selection.
// ---------------------------------------------------------------------------

describe("MyGrantSourcingProvider", () => {
  function partSearchStub() {
    return new StubTransport(
      (url: string) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        if (q.includes("DW02416")) return fixture("part-search-dw02416-gty.html");
        if (q.includes("CALLVERIFY")) return callVerifyHtml();
        return fixture("part-search-dw02415-gty.html");
      },
      (url: string) => {
        if (url.includes("login.aspx")) return authedChrome("<p>Welcome</p>");
        throw new Error(`unexpected POST ${url}`);
      }
    );
  }

  /** Minimal part-results page with a single "Call" (call_to_verify) row. */
  function callVerifyHtml(): string {
    return `<div id="cpsr_DivParts">
      <h3><span id="cpsr_LabelResultsHeader">Search Results - Randolph, MA - [REDACTED]</span></h3>
      <table id="table_searchparts">
        <tr class="rowstd"><td><span class="stock_low">Call</span></td>
        <td class="partnumber"><input type="hidden" name="srkey0" value="B036_DW99999 GTY TST"><a href="#">DW99999 GTY TST</a></td>
        <td class="price">&nbsp;$150.00</td></tr>
      </table>
    </div>`;
  }

  function provider() {
    return new MyGrantSourcingProvider(
      new MyGrantWebProvider(CONFIG, partSearchStub())
    );
  }

  it("maps an in-stock part row to an auto-quoteable offer", async () => {
    const offers = await provider().searchOffers("DW02415 GTY");
    expect(offers).toEqual([
      {
        supplier_name: "MyGrant (Randolph, MA)",
        supplier_type: "NATIONAL",
        part_number: "DW02415 GTY MOP",
        price_cents: 27450,
        available: true,
        quantity: 2,
        lead_time_days: null,
        is_interchange: false
      }
    ]);
  });

  it("picks up the cheaper interchange part from the verified live example", async () => {
    const offers = await provider().searchOffers("DW02416 GTY");
    expect(offers).toEqual([
      {
        supplier_name: "MyGrant (Randolph, MA)",
        supplier_type: "NATIONAL",
        part_number: "DW02416 GTY FYG",
        price_cents: 9225,
        available: true,
        quantity: 2,
        lead_time_days: null,
        is_interchange: false
      }
    ]);
  });

  it("excludes call-to-verify stock from auto-selection without hiding it", async () => {
    const offers = await provider().searchOffers("CALLVERIFY");
    expect(offers).toHaveLength(1);
    // Not confirmed in-stock: unavailable so the eligibility rules exclude
    // it from the system pick, but the offer is still persisted for staff.
    expect(offers[0]).toMatchObject({
      part_number: "DW99999 GTY TST",
      price_cents: 15000,
      available: false,
      quantity: 0
    });
  });

  it("fails loudly when the part search page is unreachable", async () => {
    const broken = new MyGrantSourcingProvider(
      new MyGrantWebProvider(
        CONFIG,
        new StubTransport(
          () => {
            throw new MyGrantError("MYGRANT_UNAVAILABLE", "down", 502);
          },
          (url: string) => authedChrome("")
        )
      )
    );
    await expect(broken.searchOffers("DW02415 GTY")).rejects.toMatchObject({
      code: "MYGRANT_UNAVAILABLE"
    });
  });
});

describe("createSourcingProvider", () => {
  it("defaults to the mock provider", () => {
    expect(createSourcingProvider({} as NodeJS.ProcessEnv).name).toBe("mock-sourcing");
  });

  it("builds the MyGrant provider when selected with config", () => {
    const p = createSourcingProvider({
      SOURCING_PROVIDER: "mygrant",
      MYGRANT_USERNAME: "shop",
      MYGRANT_PASSWORD: "secret"
    } as NodeJS.ProcessEnv);
    expect(p.name).toBe("mygrant-sourcing");
  });

  it("fails loudly when mygrant is selected without credentials", () => {
    expect(() =>
      createSourcingProvider({ SOURCING_PROVIDER: "mygrant" } as NodeJS.ProcessEnv)
    ).toThrowError(expect.objectContaining({ code: "MYGRANT_NOT_CONFIGURED" }));
  });

  it("rejects an unknown provider name", () => {
    expect(() =>
      createSourcingProvider({ SOURCING_PROVIDER: "acme" } as NodeJS.ProcessEnv)
    ).toThrowError(expect.objectContaining({ code: "MYGRANT_NOT_CONFIGURED" }));
  });
});
