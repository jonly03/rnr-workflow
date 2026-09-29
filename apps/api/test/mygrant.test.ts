import { describe, expect, it, vi } from "vitest";
import {
  createGlassCatalogProvider,
  extractHiddenFields,
  HttpMyGrantTransport,
  loadMyGrantConfig,
  loadMyGrantFixtures,
  MYGRANT_VIN_LOOKUP_COST_USD,
  MyGrantError,
  MyGrantWebProvider,
  parseVinLookupsRemaining,
  RecordingMyGrantTransport,
  ReplayMyGrantTransport,
  selectOptionValue,
  serializeMyGrantFixtures,
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
// Synthetic pages (provisional structures; replaced by live captures).
// ---------------------------------------------------------------------------

function loginPageHtml(): string {
  return `<html><body><form>
    <input type="hidden" name="__VIEWSTATE" value="vs123" />
    <input type="text" name="clogin:TxtUsername" />
    <input type="password" name="clogin:TxtPassword" />
    <input type="submit" name="clogin:ButtonLogin" value="Login" />
  </form></body></html>`;
}

function authedChrome(inner: string): string {
  return `<html><body><a href="/logout">Logout</a> R&amp;R's Finest ${inner}</body></html>`;
}

function vinSearchPageHtml(remaining: number | null): string {
  const counter =
    remaining === null ? "" : `<div>VIN Lookups Remaining: ${remaining}</div>`;
  return authedChrome(`
    ${counter}
    <form>
      <input type="hidden" name="__VIEWSTATE" value="vs456" />
      <input type="hidden" name="__EVENTVALIDATION" value="ev789" />
      <input type="text" name="vin" />
      <select name="glassType">
        <option value="WS">Windshield</option>
        <option value="BG">Back Glass</option>
      </select>
      <input type="submit" name="search" value="Search" />
    </form>`);
}

function vinResultsHtml(): string {
  return authedChrome(`
    <h1>2020 Honda Accord EX</h1>
    <table><tr><th>Part #</th><th>Description</th><th>Price</th></tr>
    <tr><td>FW02345GTY</td><td>Windshield acoustic rain-sensor</td><td>$512.00</td></tr>
    </table>`);
}

/** Scripted transport stub with a call log. */
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

function authedVinTransport(resultsHtml: string, remaining: number | null): StubTransport {
  return new StubTransport(
    url => (url.endsWith("/pages/searchvin.aspx") ? vinSearchPageHtml(remaining) : loginPageHtml()),
    (url, fields) => {
      if (url.endsWith("/pages/login.aspx")) return authedChrome("<p>home</p>");
      if (fields.vin) return resultsHtml;
      return vinSearchPageHtml(remaining);
    }
  );
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
    const transport = authedVinTransport(vinResultsHtml(), 0);
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(
      provider.lookupVin("1HGCM82633A004352", "WINDSHIELD")
    ).rejects.toMatchObject({ code: "MYGRANT_NO_CREDITS" });
    // No charge attempted: the VIN was never submitted.
    expect(transport.calls.some(c => c.op === "postForm" && c.fields?.vin)).toBe(false);
  });

  it("refuses to spend when the credits counter cannot be read", async () => {
    const transport = authedVinTransport(vinResultsHtml(), null);
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await expect(
      provider.lookupVin("1HGCM82633A004352", "WINDSHIELD")
    ).rejects.toMatchObject({ code: "MYGRANT_PARSE_ERROR" });
    expect(transport.calls.some(c => c.op === "postForm" && c.fields?.vin)).toBe(false);
  });

  it("spends the lookup when credits remain and returns parsed candidates", async () => {
    const transport = authedVinTransport(vinResultsHtml(), 5);
    const provider = new MyGrantWebProvider(CONFIG, transport);
    const result = await provider.lookupVin("1HGCM82633A004352", "WINDSHIELD");
    expect(result.vin).toBe("1HGCM82633A004352");
    expect(result.decoded.year).toBe(2020);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].part_number).toBe("FW02345GTY");
    expect(result.candidates[0].position).toBe("WINDSHIELD");
    expect(result.candidates[0].list_price_cents).toBe(51200);
    // The VIN was actually submitted this time.
    expect(transport.calls.some(c => c.op === "postForm" && c.fields?.vin)).toBe(true);
  });

  it("maps Back Glass to the site's Back Glass dropdown option", async () => {
    const transport = authedVinTransport(vinResultsHtml(), 3);
    const provider = new MyGrantWebProvider(CONFIG, transport);
    await provider.lookupVin("1HGCM82633A004352", "BACK_GLASS");
    const searchCall = transport.calls.find(c => c.op === "postForm" && c.fields?.vin);
    expect(searchCall?.fields?.glassType).toBe("BG");
  });
});

// ---------------------------------------------------------------------------
// Parsers.
// ---------------------------------------------------------------------------

describe("MyGrant page parsers", () => {
  it("reads the VIN lookups remaining counter", () => {
    expect(parseVinLookupsRemaining(vinSearchPageHtml(12))).toBe(12);
    expect(parseVinLookupsRemaining(vinSearchPageHtml(0))).toBe(0);
    expect(parseVinLookupsRemaining(vinSearchPageHtml(null))).toBeNull();
  });

  it("extracts hidden WebForms fields", () => {
    expect(extractHiddenFields(vinSearchPageHtml(1))).toEqual({
      __VIEWSTATE: "vs456",
      __EVENTVALIDATION: "ev789"
    });
  });

  it("matches dropdown options by visible label", () => {
    const html = vinSearchPageHtml(1);
    expect(selectOptionValue(html, "glassType", "Windshield")).toBe("WS");
    expect(selectOptionValue(html, "glassType", "Back Glass")).toBe("BG");
    expect(selectOptionValue(html, "glassType", "Door Glass")).toBeNull();
    expect(selectOptionValue(html, "nope", "Windshield")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fixture record/replay.
// ---------------------------------------------------------------------------

describe("fixture record/replay", () => {
  it("records and replays a lookup round-trip deterministically", async () => {
    const stub = authedVinTransport(vinResultsHtml(), 5);
    const recording = new RecordingMyGrantTransport(stub);
    const provider = new MyGrantWebProvider(CONFIG, recording);
    const live = await provider.lookupVin("1HGCM82633A004352", "WINDSHIELD");
    expect(recording.fixtures.length).toBeGreaterThan(0);

    const json = serializeMyGrantFixtures(recording.fixtures);
    const replay = new ReplayMyGrantTransport(loadMyGrantFixtures(json));
    const replayed = await new MyGrantWebProvider(CONFIG, replay).lookupVin(
      "1HGCM82633A004352",
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
// HTTP transport: WebForms postback mechanics.
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
      expect(body).toContain("vin=1HGCM82633A004352");
      return textResponse("<p>ok</p>");
    });
    const transport = new HttpMyGrantTransport(5000, fetchImpl as unknown as typeof fetch);
    await transport.postForm("https://mygrant.test/pages/searchvin.aspx", {
      vin: "1HGCM82633A004352"
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
