import type { GlassCandidate, GlassType } from "./types.js";
import {
  MockGlassCatalogProvider,
  type GlassCatalogProvider,
  type VinLookupResult,
  type YmmSearchInput
} from "./glass-catalog.js";

/**
 * Live MyGrant provider (web automation).
 *
 * MyGrant exposes no usable API, so this provider drives the MyGrant
 * website (plain ASP.NET WebForms postbacks) over HTTP: login once with
 * the shop's credentials, reuse the session cookie, submit the search
 * forms, and parse the results pages.
 *
 * FAIL-LOUD CONTRACT (non-negotiable): in live mode this provider NEVER
 * substitutes mock data, empty results-as-success, or guesses. Any
 * transport failure, auth failure, zero-credit state, or unexpected page
 * structure throws a MyGrantError with a machine-readable code. The
 * identification flow turns that into a loud failure (SYSTEM_ATTENTION_REQUIRED),
 * never a silent wrong part.
 *
 * Cost model (per the shop's MyGrant terms):
 * - VIN lookup: $1 per lookup (MYGRANT_VIN_LOOKUP_COST_USD).
 * - YMM lookup and part-number search: FREE.
 * Charge-avoidance (cache first, single-flight claims) lives in
 * glass-identification.ts and applies to the paid VIN path.
 *
 * PARSING STATUS: the result-page parsers below are PROVISIONAL. They
 * were written against the logged-out page structure; the authenticated
 * results tables have not been captured yet. After a live capture run,
 * finalize the parsers against real HTML and reshape the mock to match.
 * Until then they throw MYGRANT_PARSE_ERROR rather than guess.
 */

export const MYGRANT_BASE_URL_DEFAULT = "https://www.mygrantglass.com";
export const MYGRANT_LOGIN_PATH = "/pages/login.aspx";
export const MYGRANT_VIN_SEARCH_PATH = "/pages/searchvin.aspx";
export const MYGRANT_YMM_SEARCH_PATH = "/pages/searchm.aspx";
export const MYGRANT_PART_SEARCH_PATH = "/pages/search.aspx";

/** What MyGrant charges the shop per VIN lookup, in USD. */
export const MYGRANT_VIN_LOOKUP_COST_USD = 1;

export type MyGrantErrorCode =
  | "MYGRANT_NOT_CONFIGURED"
  | "MYGRANT_AUTH_FAILED"
  | "MYGRANT_NO_CREDITS"
  | "MYGRANT_UNAVAILABLE"
  | "MYGRANT_PARSE_ERROR"
  | "MYGRANT_SPEND_CAP_EXCEEDED";

export class MyGrantError extends Error {
  /**
   * True when the lookup was submitted to MyGrant before failing, so the
   * $1 charge may have been consumed. False when the failure happened
   * before submission (auth rejected, zero credits, credits unreadable):
   * then no charge was possible. Callers record spend conservatively on
   * charged=true.
   */
  charged = false;

  constructor(
    readonly code: MyGrantErrorCode,
    message: string,
    readonly httpStatus: number = 502
  ) {
    super(message);
    this.name = "MyGrantError";
  }
}

/** Attach charged=true to an error that happened after submitting the lookup. */
function markCharged(error: unknown): unknown {
  if (error instanceof MyGrantError) error.charged = true;
  return error;
}

/**
 * Daily cap on paid MyGrant VIN lookups, in cents. Configured with
 * MYGRANT_DAILY_SPEND_CAP_USD (default $25). The cap is enforced against
 * recorded spend for the current UTC day.
 */
export function getVinSpendCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MYGRANT_DAILY_SPEND_CAP_USD ?? 25);
  if (!Number.isFinite(raw) || raw < 0) {
    throw new MyGrantError(
      "MYGRANT_SPEND_CAP_EXCEEDED",
      `Invalid MYGRANT_DAILY_SPEND_CAP_USD value. Paid VIN lookups are blocked until it is fixed.`,
      500
    );
  }
  return Math.round(raw * 100);
}

export interface MyGrantConfig {
  baseUrl: string;
  username: string;
  password: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? "").trim();
  if (!value) {
    throw new MyGrantError(
      "MYGRANT_NOT_CONFIGURED",
      `Live MyGrant provider selected but ${name} is not set. ` +
        `Add it as a secret env var (never in code).`,
      500
    );
  }
  return value;
}

export function loadMyGrantConfig(env: NodeJS.ProcessEnv = process.env): MyGrantConfig {
  return {
    baseUrl: (env.MYGRANT_BASE_URL ?? MYGRANT_BASE_URL_DEFAULT).replace(/\/$/, ""),
    username: requiredEnv(env, "MYGRANT_USERNAME"),
    password: requiredEnv(env, "MYGRANT_PASSWORD"),
    timeoutMs: Number(env.MYGRANT_TIMEOUT_MS ?? 30_000)
  };
}

/**
 * Selects the glass catalog provider. Defaults to the deterministic mock
 * (no network, no charges). Set GLASS_CATALOG_PROVIDER=mygrant plus the
 * MYGRANT_* secrets to go live. Unknown values fail at startup, loudly.
 */
export function createGlassCatalogProvider(
  env: NodeJS.ProcessEnv = process.env
): GlassCatalogProvider {
  const selection = (env.GLASS_CATALOG_PROVIDER ?? "mock").trim().toLowerCase();
  if (selection === "mygrant") {
    return new MyGrantWebProvider(loadMyGrantConfig(env));
  }
  if (selection === "mock") {
    return new MockGlassCatalogProvider();
  }
  throw new MyGrantError(
    "MYGRANT_NOT_CONFIGURED",
    `Unknown GLASS_CATALOG_PROVIDER "${selection}". Expected "mock" or "mygrant".`,
    500
  );
}

// ---------------------------------------------------------------------------
// Transport: HTTP with a cookie jar and ASP.NET WebForms postback support.
// ---------------------------------------------------------------------------

/** Minimal page-level HTTP surface the provider needs. */
export interface MyGrantTransport {
  get(url: string): Promise<string>;
  /**
   * Submit a WebForms form: re-GETs the page, merges its hidden
   * __VIEWSTATE/__EVENTVALIDATION fields with the caller's fields, and
   * POSTs url-encoded. Throws MyGrantError on transport failure.
   */
  postForm(url: string, fields: Record<string, string>): Promise<string>;
  close(): Promise<void>;
}

type FetchImpl = typeof fetch;

const HIDDEN_FIELD_NAMES = new Set([
  "__VIEWSTATE",
  "__VIEWSTATEGENERATOR",
  "__EVENTVALIDATION",
  "__EVENTTARGET",
  "__EVENTARGUMENT"
]);

/** Extract hidden input name/value pairs from HTML (ViewState etc.). */
export function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re =
    /<input\b[^>]*\btype\s*=\s*["']?hidden["']?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (name && HIDDEN_FIELD_NAMES.has(name)) fields[name] = value;
  }
  return fields;
}

/** Decode a small set of HTML entities found in attribute values. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export class HttpMyGrantTransport implements MyGrantTransport {
  private cookies = new Map<string, string>();

  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchImpl = fetch
  ) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(headers: Headers): void {
    // getSetCookie() is available in undici/Node 18+; fall back to set-cookie.
    const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie;
    const raw: string[] = getSetCookie
      ? getSetCookie.call(headers)
      : (headers.get("set-cookie")?.split(/,(?=[^;,=]+=[^;,]*)/) ?? []);
    for (const entry of raw) {
      const pair = entry.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private async request(url: string, init: RequestInit): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      const cookieHeader = this.cookieHeader();
      if (cookieHeader) headers.set("Cookie", cookieHeader);
      headers.set(
        "User-Agent",
        "Mozilla/5.0 (compatible; RNR-CaseCore/1.0; +shop-automation)"
      );
      const res = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
      this.storeCookies(res.headers);
      if (!res.ok) {
        throw new MyGrantError(
          "MYGRANT_UNAVAILABLE",
          `MyGrant returned HTTP ${res.status} for ${url}.`,
          502
        );
      }
      return await res.text();
    } catch (error) {
      if (error instanceof MyGrantError) throw error;
      throw new MyGrantError(
        "MYGRANT_UNAVAILABLE",
        `Could not reach MyGrant (${url}): ${
          error instanceof Error ? error.message : "unknown error"
        }.`,
        502
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async get(url: string): Promise<string> {
    return this.request(url, { method: "GET" });
  }

  async postForm(url: string, fields: Record<string, string>): Promise<string> {
    const page = await this.get(url);
    const hidden = extractHiddenFields(page);
    const body = new URLSearchParams({ ...hidden, ...fields });
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
  }

  async close(): Promise<void> {
    this.cookies.clear();
  }
}

// ---------------------------------------------------------------------------
// Fixture record/replay: real responses are captured once, tests replay
// them. A replay miss throws loudly — tests must never silently pass on
// an unstubbed call.
// ---------------------------------------------------------------------------

export interface MyGrantFixture {
  op: "get" | "postForm";
  url: string;
  /** Sorted, for stable matching. */
  fields?: Record<string, string>;
  responseHtml: string;
}

export function loadMyGrantFixtures(json: string): MyGrantFixture[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new MyGrantError("MYGRANT_PARSE_ERROR", "Fixture file must be a JSON array.", 500);
  }
  return parsed as MyGrantFixture[];
}

export function serializeMyGrantFixtures(fixtures: MyGrantFixture[]): string {
  return JSON.stringify(fixtures, null, 2);
}

function normalizeFields(fields?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(fields ?? {}).sort()) out[key] = fields![key];
  // ViewState blobs are session-specific; never part of the match key.
  for (const hidden of HIDDEN_FIELD_NAMES) delete out[hidden];
  return out;
}

function fixturesEqual(a: MyGrantFixture, b: MyGrantFixture): boolean {
  if (a.op !== b.op || a.url !== b.url) return false;
  const fa = normalizeFields(a.fields);
  const fb = normalizeFields(b.fields);
  return JSON.stringify(fa) === JSON.stringify(fb);
}

/** Wraps a transport and records every call for later replay. */
export class RecordingMyGrantTransport implements MyGrantTransport {
  readonly fixtures: MyGrantFixture[] = [];

  constructor(private readonly inner: MyGrantTransport) {}

  async get(url: string): Promise<string> {
    const responseHtml = await this.inner.get(url);
    this.fixtures.push({ op: "get", url, responseHtml });
    return responseHtml;
  }

  async postForm(url: string, fields: Record<string, string>): Promise<string> {
    const responseHtml = await this.inner.postForm(url, fields);
    this.fixtures.push({ op: "postForm", url, fields: normalizeFields(fields), responseHtml });
    return responseHtml;
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/** Serves recorded fixtures. No network, deterministic, zero charges. */
export class ReplayMyGrantTransport implements MyGrantTransport {
  private remaining: MyGrantFixture[];

  constructor(fixtures: MyGrantFixture[]) {
    this.remaining = [...fixtures];
  }

  /** How many fixtures were consumed (useful for "did it call out?" assertions). */
  get consumed(): number {
    return this.consumedCount;
  }
  private consumedCount = 0;

  private take(op: "get" | "postForm", url: string, fields?: Record<string, string>): string {
    const probe: MyGrantFixture = { op, url, fields, responseHtml: "" };
    const idx = this.remaining.findIndex(f => fixturesEqual(f, probe));
    if (idx === -1) {
      throw new MyGrantError(
        "MYGRANT_UNAVAILABLE",
        `Replay transport has no fixture for ${op} ${url}. ` +
          `Record one from the live site instead of hitting MyGrant from tests.`,
        500
      );
    }
    this.consumedCount++;
    return this.remaining.splice(idx, 1)[0].responseHtml;
  }

  async get(url: string): Promise<string> {
    return this.take("get", url);
  }

  async postForm(url: string, fields: Record<string, string>): Promise<string> {
    return this.take("postForm", url, fields);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Provisional result parsers. Structure of the authenticated results pages
// is still unknown — these parse conservatively and throw MYGRANT_PARSE_ERROR
// instead of guessing. Finalize against a live capture.
// ---------------------------------------------------------------------------

/** Strip tags and collapse whitespace for text extraction. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read the "VIN Lookups Remaining:" counter. Returns null when the counter
 * cannot be found — the caller treats that as a loud failure, not as "plenty".
 */
export function parseVinLookupsRemaining(html: string): number | null {
  const m = /VIN Lookups Remaining:\s*([0-9,]+)/i.exec(textOf(html));
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

/** True when the HTML renders the login form (session expired / not logged in). */
export function isLoginPage(html: string): boolean {
  return /clogin:TxtUsername/i.test(html);
}

/** True when the HTML looks like an authenticated MyGrant page. */
export function isAuthenticatedPage(html: string): boolean {
  return /logout/i.test(html) && !isLoginPage(html);
}

/**
 * Extract <option> values from a <select>, matched by visible label text.
 * Used for the glass-type dropdown whose option *values* are unknown.
 */
export function selectOptionValue(html: string, selectName: string, label: string): string | null {
  const selectRe = new RegExp(
    `<select\\b[^>]*\\bname\\s*=\\s*["']${selectName}["'][^>]*>([\\s\\S]*?)</select>`,
    "i"
  );
  const body = selectRe.exec(html)?.[1];
  if (!body) return null;
  const optionRe = /<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/option\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = optionRe.exec(body)) !== null) {
    if (textOf(m[2]).toLowerCase() === label.toLowerCase()) return decodeEntities(m[1]);
  }
  // Fallback: option without an explicit value attribute.
  const bareRe = /<option\b[^>]*>([\s\S]*?)<\/option\s*>/gi;
  while ((m = bareRe.exec(body)) !== null) {
    if (textOf(m[1]).toLowerCase() === label.toLowerCase()) return textOf(m[1]);
  }
  return null;
}

const GLASS_TYPE_LABEL: Record<GlassType, string> = {
  WINDSHIELD: "Windshield",
  BACK_GLASS: "Back Glass",
  DOOR_GLASS: "Door Glass",
  QUARTER_GLASS: "Quarter Glass",
  VENT_GLASS: "Vent Glass"
};

/**
 * PROVISIONAL: parse VIN search results into candidates. Throws
 * MYGRANT_PARSE_ERROR unless a recognizable results table is present.
 */
export function parseVinResults(
  html: string,
  vin: string,
  glassType: GlassType
): VinLookupResult {
  const rows = extractResultRows(html);
  if (rows.length === 0) {
    throw new MyGrantError(
      "MYGRANT_PARSE_ERROR",
      "MyGrant VIN results page has no recognizable results table. " +
        "The provisional parser needs finalizing against a live capture.",
      502
    );
  }
  const candidates: GlassCandidate[] = rows.map(row => ({
    part_number: row.partNumber,
    description: row.description || `${GLASS_TYPE_LABEL[glassType]} (VIN ${vin})`,
    features: row.features,
    position: glassType,
    // PROVISIONAL: price extraction finalized after live capture.
    list_price_cents: row.listPriceCents ?? 0
  }));
  return {
    vin,
    decoded: extractDecodedVehicle(html),
    candidates
  };
}

/** PROVISIONAL: parse YMM search results into candidates. */
export function parseYmmResults(html: string, input: YmmSearchInput): GlassCandidate[] {
  const rows = extractResultRows(html);
  if (rows.length === 0) {
    throw new MyGrantError(
      "MYGRANT_PARSE_ERROR",
      "MyGrant YMM results page has no recognizable results table. " +
        "The provisional parser needs finalizing against a live capture.",
      502
    );
  }
  return rows.map(row => ({
    part_number: row.partNumber,
    description:
      row.description ||
      `${input.year} ${input.make} ${input.model} ${GLASS_TYPE_LABEL[input.glassType]}`,
    features: row.features,
    position: input.glassType,
    list_price_cents: row.listPriceCents ?? 0
  }));
}

interface ResultRow {
  partNumber: string;
  description: string;
  features: string[];
  listPriceCents: number | null;
}

/**
 * PROVISIONAL table extraction: finds table rows whose first cell looks
 * like a part number (letters/digits/dashes, reasonably long). Returns []
 * when nothing matches so callers can fail loudly.
 */
function extractResultRows(html: string): ResultRow[] {
  const rows: ResultRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(html)) !== null) {
    // Skip pure header rows (<th> with no <td>).
    if (/<th\b/i.test(tr[1]) && !/<td\b/i.test(tr[1])) continue;
    const cells: string[] = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(tr[1])) !== null) cells.push(textOf(td[1]));
    if (cells.length === 0) continue;
    const partNumber = cells.find(c => /^[A-Z0-9][A-Z0-9\-/]{5,}$/i.test(c.trim()));
    if (!partNumber) continue;
    rows.push({
      partNumber: partNumber.trim(),
      description: cells.filter(c => c !== partNumber).join(" ").slice(0, 200),
      features: [],
      listPriceCents: extractPrice(cells.join(" "))
    });
  }
  return rows;
}

function extractPrice(text: string): number | null {
  const m = /\$\s*([0-9,]+(?:\.[0-9]{2})?)/.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, "")) * 100);
}

/** PROVISIONAL: pull decoded YMM from the VIN results page, if present. */
function extractDecodedVehicle(html: string): VinLookupResult["decoded"] {
  const text = textOf(html);
  const year = /\b(19|20)\d{2}\b/.exec(text)?.[0];
  if (!year) {
    throw new MyGrantError(
      "MYGRANT_PARSE_ERROR",
      "MyGrant VIN results page shows no recognizable model year. " +
        "The provisional parser needs finalizing against a live capture.",
      502
    );
  }
  return { year: Number(year), make: "", model: "", trim: "" };
}

// ---------------------------------------------------------------------------
// Provider: same GlassCatalogProvider interface as the mock.
// ---------------------------------------------------------------------------

const LOGIN_USERNAME_FIELD = "clogin:TxtUsername";
const LOGIN_PASSWORD_FIELD = "clogin:TxtPassword";
const LOGIN_BUTTON_FIELD = "clogin:ButtonLogin";
const VIN_FIELD = "vin";

export class MyGrantWebProvider implements GlassCatalogProvider {
  readonly name = "mygrant-web";
  /** MyGrant charges the shop $1 per VIN lookup. YMM/part search are free. */
  readonly vinLookupCostCents = 100;
  private loggedIn = false;

  constructor(
    private readonly config: MyGrantConfig,
    private readonly transport?: MyGrantTransport
  ) {}

  private get baseUrl(): string {
    return this.config.baseUrl;
  }

  private getTransport(): MyGrantTransport {
    return this.transport ?? new HttpMyGrantTransport(this.config.timeoutMs);
  }

  private loginUrl(): string {
    return this.baseUrl + MYGRANT_LOGIN_PATH;
  }

  /**
   * Log in once per provider lifetime; reuse the session cookie after.
   * Throws MYGRANT_AUTH_FAILED when the credentials are rejected.
   */
  private async ensureLoggedIn(transport: MyGrantTransport): Promise<void> {
    if (this.loggedIn) return;
    const response = await transport.postForm(this.loginUrl(), {
      [LOGIN_USERNAME_FIELD]: this.config.username,
      [LOGIN_PASSWORD_FIELD]: this.config.password,
      [LOGIN_BUTTON_FIELD]: "Login"
    });
    if (!isAuthenticatedPage(response)) {
      throw new MyGrantError(
        "MYGRANT_AUTH_FAILED",
        "MyGrant rejected the login. Check MYGRANT_USERNAME / MYGRANT_PASSWORD.",
        502
      );
    }
    this.loggedIn = true;
  }

  /**
   * Re-login once if the session expired mid-flow, then retry the fetch.
   * Anything else throws loudly.
   */
  private async authenticatedGet(
    transport: MyGrantTransport,
    url: string
  ): Promise<string> {
    await this.ensureLoggedIn(transport);
    let html = await transport.get(url);
    if (isLoginPage(html)) {
      this.loggedIn = false;
      await this.ensureLoggedIn(transport);
      html = await transport.get(url);
      if (isLoginPage(html)) {
        throw new MyGrantError(
          "MYGRANT_AUTH_FAILED",
          "MyGrant session could not be re-established.",
          502
        );
      }
    }
    return html;
  }

  /**
   * FREE path: YMM search costs the shop nothing. Still goes through the
   * session, still fails loudly on any anomaly.
   */
  async searchYmm(input: YmmSearchInput): Promise<GlassCandidate[]> {
    const transport = this.getTransport();
    try {
      const url = this.baseUrl + MYGRANT_YMM_SEARCH_PATH;
      await this.authenticatedGet(transport, url);
      const html = await transport.postForm(url, {
        yr: String(input.year),
        mk: input.make,
        // MyGrant's model search is case-sensitive: a single first
        // character returns the exhaustive model list.
        md: input.model.slice(0, 1),
        search: "Search"
      });
      return parseYmmResults(html, input);
    } finally {
      if (!this.transport) await transport.close();
    }
  }

  /**
   * PAID path: every call spends one $1 VIN lookup credit. Callers MUST
   * check the VIN cache first (glass-identification.ts does). The credits
   * counter is read before submitting: zero credits fails loudly WITHOUT
   * attempting the lookup.
   */
  async lookupVin(vin: string, glassType: GlassType): Promise<VinLookupResult> {
    const transport = this.getTransport();
    try {
      const url = this.baseUrl + MYGRANT_VIN_SEARCH_PATH;
      const searchPage = await this.authenticatedGet(transport, url);

      const remaining = parseVinLookupsRemaining(searchPage);
      if (remaining === null) {
        throw new MyGrantError(
          "MYGRANT_PARSE_ERROR",
          'Could not read "VIN Lookups Remaining" from the MyGrant VIN page. ' +
            "Refusing to spend a $1 lookup without verifying credits.",
          502
        );
      }
      if (remaining <= 0) {
        throw new MyGrantError(
          "MYGRANT_NO_CREDITS",
          "MyGrant VIN lookup credits are exhausted (0 remaining). " +
            "Purchase a credit block before retrying — no lookup was attempted.",
          402
        );
      }

      const optionValue = selectOptionValue(
        searchPage,
        "glassType",
        GLASS_TYPE_LABEL[glassType]
      );
      // From here on the $1 lookup is submitted: any failure may have
      // consumed the credit, so mark it charged (conservative with real money).
      try {
        const html = await transport.postForm(url, {
          [VIN_FIELD]: vin,
          ...(optionValue !== null ? { glassType: optionValue } : {}),
          search: "Search"
        });
        return parseVinResults(html, vin, glassType);
      } catch (error) {
        throw markCharged(error);
      }
    } finally {
      if (!this.transport) await transport.close();
    }
  }

  /**
   * FREE path: part-number search (e.g. re-verifying a part before
   * ordering). Not part of the GlassCatalogProvider interface; used by
   * future sourcing/order flows.
   */
  async searchPartNumber(
    partNumber: string,
    warehouse = "Randolph MA Default"
  ): Promise<GlassCandidate[]> {
    const transport = this.getTransport();
    try {
      const url = this.baseUrl + MYGRANT_PART_SEARCH_PATH;
      await this.authenticatedGet(transport, url);
      const html = await transport.postForm(url, {
        q: partNumber,
        warehouse,
        search: "Search"
      });
      return parseYmmResults(html, {
        year: 0,
        make: "",
        model: "",
        glassType: "WINDSHIELD"
      });
    } finally {
      if (!this.transport) await transport.close();
    }
  }
}
