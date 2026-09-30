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
 * website over HTTP: login once via the WebForms POST with the shop's
 * credentials, reuse the session cookie, then submit the VIN/YMM/part
 * search forms as authenticated GET requests, and parse the results pages.
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
 * PARSING STATUS (finalized 2026-09-29 against live captures; fixtures in
 * test/fixtures/mygrant/):
 * - VIN search form (searchvin.aspx): verbatim. GET with params vin,
 *   cvs:GlassTypeSelect (Windshield|Back), svindo=Search. Credits counter
 *   at #cvs_lookupCredits. Only Windshield and Back Glass exist on the site.
 * - VIN results: RECONSTRUCTED from field notes of the single authorized $1
 *   lookup (see vin-results-wrangler-reconstructed.html). All selectors are
 *   real (#cvs_DivModel, #cvs_LabelMake/Model/Year/Style, <lh> headings,
 *   a.WsResult); nesting is best-guess, so the parser selects by id/class
 *   only. Replace with a verbatim capture on the next legitimate lookup.
 * - YMM search form + vehicle results (searchm.aspx): verbatim. GET with
 *   yr/mk/md/smdo=Search; results are vehicles in #cms_DivModels ol li a.
 *   The vehicle→parts drill-down page has NOT been captured, so live YMM
 *   cannot resolve glass candidates yet (fails loudly, see searchYmm).
 * - Part-number search (search.aspx): verbatim. GET with q/sc/do=Search;
 *   results in #table_searchparts with stock_high/stock_low spans.
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
  | "MYGRANT_SPEND_CAP_EXCEEDED"
  | "MYGRANT_UNSUPPORTED_GLASS_TYPE";

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

  private static readonly MAX_REDIRECTS = 10;

  private async request(url: string, init: RequestInit): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Follow redirects manually. fetch's automatic redirect handling
      // swallows Set-Cookie headers on intermediate responses, which drops
      // the .ASPXAUTH cookie MyGrant issues on its post-login 302 — the
      // login then "fails" even with correct credentials.
      let currentUrl = url;
      let method = (init.method ?? "GET").toUpperCase();
      let body = init.body;
      for (let hop = 0; hop <= HttpMyGrantTransport.MAX_REDIRECTS; hop++) {
        const headers = new Headers(init.headers);
        const cookieHeader = this.cookieHeader();
        if (cookieHeader) headers.set("Cookie", cookieHeader);
        headers.set(
          "User-Agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        );
        if (!headers.has("Accept")) {
          headers.set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          );
        }
        if (!headers.has("Accept-Language")) {
          headers.set("Accept-Language", "en-US,en;q=0.9");
        }
        if (method === "GET") headers.delete("Content-Type");
        const res = await this.fetchImpl(currentUrl, {
          ...init,
          method,
          body,
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
        this.storeCookies(res.headers);
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (hop === HttpMyGrantTransport.MAX_REDIRECTS || !location) {
            throw new MyGrantError(
              "MYGRANT_UNAVAILABLE",
              `MyGrant redirected too many times for ${url}.`,
              502
            );
          }
          currentUrl = new URL(location, currentUrl).toString();
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
          }
          continue;
        }
        if (!res.ok) {
          throw new MyGrantError(
            "MYGRANT_UNAVAILABLE",
            `MyGrant returned HTTP ${res.status} for ${url}.`,
            502
          );
        }
        return await res.text();
      }
      throw new MyGrantError(
        "MYGRANT_UNAVAILABLE",
        `MyGrant redirected too many times for ${url}.`,
        502
      );
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
// Result parsers, finalized against live captures 2026-09-29
// (fixtures in test/fixtures/mygrant/). Every parser selects by id/class,
// never by rigid nesting, because the VIN results fixture is reconstructed
// from field notes. Anything unrecognizable throws MYGRANT_PARSE_ERROR —
// never a guess.
// ---------------------------------------------------------------------------

/** Strip tags and collapse whitespace for text extraction. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Text of the element with the given id, or null when absent. */
function textOfId(html: string, id: string): string | null {
  const inner = innerHtmlOfId(html, id);
  return inner === null ? null : textOf(inner);
}

/**
 * Inner HTML of the element with the given id, or null when absent.
 * Counts nested tags so containers with nested same-name elements
 * (e.g. divs inside #cvs_DivModel) are extracted whole.
 */
function innerHtmlOfId(html: string, id: string): string | null {
  const openRe = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`,
    "i"
  );
  const open = openRe.exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const start = open.index + open[0].length;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].endsWith("/>")) continue; // self-closing: no depth change
    if (m[1] === "/") depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return null;
}

function parseError(what: string): MyGrantError {
  return new MyGrantError(
    "MYGRANT_PARSE_ERROR",
    `MyGrant page did not contain a recognizable ${what}. ` +
      "The site may have changed; refusing to guess.",
    502
  );
}

/**
 * Read the "VIN Lookups Remaining:" counter. Targets the #cvs_lookupCredits
 * span first, falls back to the label text. Returns null when the counter
 * cannot be found — the caller treats that as a loud failure, not "plenty".
 */
export function parseVinLookupsRemaining(html: string): number | null {
  const span = textOfId(html, "cvs_lookupCredits");
  if (span !== null) {
    const n = Number(span.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
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

const GLASS_TYPE_LABEL: Record<GlassType, string> = {
  WINDSHIELD: "Windshield",
  BACK_GLASS: "Back Glass",
  DOOR_GLASS: "Door Glass",
  QUARTER_GLASS: "Quarter Glass",
  VENT_GLASS: "Vent Glass"
};

/**
 * The MyGrant VIN form's glass-type dropdown (name="cvs:GlassTypeSelect")
 * offers exactly two options, confirmed live: value="Windshield" and
 * value="Back". Any other glass type cannot be looked up on the site.
 */
const GLASS_TYPE_SITE_VALUE: Partial<Record<GlassType, string>> = {
  WINDSHIELD: "Windshield",
  BACK_GLASS: "Back"
};

export function siteGlassTypeValue(glassType: GlassType): string {
  const value = GLASS_TYPE_SITE_VALUE[glassType];
  if (!value) {
    throw new MyGrantError(
      "MYGRANT_UNSUPPORTED_GLASS_TYPE",
      `MyGrant's VIN lookup only offers Windshield and Back Glass; ` +
        `cannot look up ${GLASS_TYPE_LABEL[glassType]}. No lookup was attempted.`,
      422
    );
  }
  return value;
}

/** One <a class="WsResult"> part anchor from a VIN results page. */
interface WsResultAnchor {
  partNumber: string;
  href: string;
}

function extractWsResultAnchors(scopeHtml: string): WsResultAnchor[] {
  const out: WsResultAnchor[] = [];
  const re =
    /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bWsResult\b[^"']*["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scopeHtml)) !== null) {
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? "";
    const partNumber = textOf(m[1]);
    if (partNumber) out.push({ partNumber, href: decodeEntities(href) });
  }
  return out;
}

/**
 * Find the <ul> whose <lh> heading matches `heading` (e.g. "Features:"),
 * and return the text of its <li> items. Returns null when no such list
 * exists in the scope HTML.
 */
function listItemsUnderHeading(scopeHtml: string, heading: string): string[] | null {
  const ulRe = /<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi;
  let ul: RegExpExecArray | null;
  while ((ul = ulRe.exec(scopeHtml)) !== null) {
    const lh = /<lh\b[^>]*>([\s\S]*?)<\/lh\s*>/i.exec(ul[1]);
    if (lh && textOf(lh[1]).toLowerCase() === heading.toLowerCase()) {
      const items: string[] = [];
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;
      let li: RegExpExecArray | null;
      while ((li = liRe.exec(ul[1])) !== null) {
        const t = textOf(li[1]);
        if (t) items.push(t);
      }
      return items;
    }
  }
  return null;
}

/** Inner HTML of the <ul> headed `heading`, or null when absent. */
function listHtmlUnderHeading(scopeHtml: string, heading: string): string | null {
  const ulRe = /<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi;
  let ul: RegExpExecArray | null;
  while ((ul = ulRe.exec(scopeHtml)) !== null) {
    const lh = /<lh\b[^>]*>([\s\S]*?)<\/lh\s*>/i.exec(ul[1]);
    if (lh && textOf(lh[1]).toLowerCase() === heading.toLowerCase()) return ul[1];
  }
  return null;
}

function stripListHtml(scopeHtml: string, listInner: string): string {
  return scopeHtml.replace(listInner, "");
}

/**
 * Parse a VIN results page (#cvs_DivModel) into the decoded vehicle, the
 * primary glass candidate, its features, interchangeable part numbers,
 * and OEM part numbers. Selectors confirmed live 2026-09-29.
 */
export function parseVinResults(
  html: string,
  vin: string,
  glassType: GlassType
): VinLookupResult {
  const scope = innerHtmlOfId(html, "cvs_DivModel");
  if (!scope) throw parseError("VIN results container (#cvs_DivModel)");

  const yearText = textOfId(scope, "cvs_LabelYear") ?? "";
  const year = Number(yearText);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    throw parseError("vehicle year (#cvs_LabelYear)");
  }
  const decoded = {
    year,
    make: textOfId(scope, "cvs_LabelMake") ?? "",
    model: textOfId(scope, "cvs_LabelModel") ?? "",
    trim: textOfId(scope, "cvs_LabelStyle") ?? ""
  };

  // Interchange anchors live under the "Interchangeables:" list; the
  // primary is any other .WsResult anchor in the results container.
  const interchangeListHtml = listHtmlUnderHeading(scope, "Interchangeables:");
  const interchangePartNumbers = interchangeListHtml
    ? extractWsResultAnchors(interchangeListHtml).map(a => a.partNumber)
    : [];
  const primaryScope = interchangeListHtml
    ? stripListHtml(scope, interchangeListHtml)
    : scope;
  const primary = extractWsResultAnchors(primaryScope)[0];
  if (!primary) throw parseError("primary part link (a.WsResult)");

  const features = listItemsUnderHeading(scope, "Features:") ?? [];
  const oemPartNumbers = listItemsUnderHeading(scope, "OEM Part Numbers:") ?? [];

  return {
    vin,
    decoded,
    candidates: [
      {
        part_number: primary.partNumber,
        description:
          `${decoded.year} ${decoded.make} ${decoded.model}`.trim() +
          ` ${GLASS_TYPE_LABEL[glassType]}`,
        features,
        position: glassType,
        // The VIN results page carries no prices; pricing comes from the
        // (free) part-number search in the sourcing step.
        list_price_cents: 0
      }
    ],
    interchangePartNumbers,
    oemPartNumbers
  };
}

/** One vehicle match from a YMM (year/make/model) search. */
export interface YmmVehicleMatch {
  /** Display name, e.g. "Honda Accord 2020 4 Door Sedan". */
  name: string;
  /** Relative drill-down link, e.g. "?yr=2020&mk=Honda&md=A&v=...". */
  detailPath: string;
}

/**
 * Parse a YMM results page: vehicles listed in #cms_DivModels as
 * <ol><li><a href="...">. An empty list is a legitimate "no matches"
 * result; a missing container is a parse error.
 */
export function parseYmmVehicleList(html: string): YmmVehicleMatch[] {
  const scope = innerHtmlOfId(html, "cms_DivModels");
  if (!scope) throw parseError("YMM results container (#cms_DivModels)");
  const out: YmmVehicleMatch[] = [];
  const re = /<li\b[^>]*>\s*<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>\s*<\/li\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const name = textOf(m[2]);
    if (name) out.push({ name, detailPath: decodeEntities(m[1]) });
  }
  return out;
}

export type PartStock = "in_stock" | "call_to_verify" | "unknown";

export interface PartOffer {
  /** Part number as displayed, including the brand suffix (e.g. "DW02416 GTY FYG"). */
  part_number: string;
  stock: PartStock;
  price_cents: number;
}

export interface PartSearchResults {
  /** Warehouse label from the results header, e.g. "Search Results - Randolph, MA - ...". */
  warehouse: string;
  results: PartOffer[];
}

function extractPriceCents(text: string): number | null {
  const m = /\$\s*([0-9,]+(?:\.[0-9]{2})?)/.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, "")) * 100);
}

/**
 * Parse a part-number search page (#table_searchparts). Each data row
 * carries a stock span (stock_high "Yes" = 2+ units, stock_low "Call" =
 * 1 unit, call to verify), a .partnumber cell (hidden srkey input holds
 * "WAREHOUSE_PART BRAND", link shows the display number), and a .price
 * cell. Rows without a parseable price are skipped — a price is required
 * for sourcing decisions.
 */
export function parsePartSearchResults(html: string): PartSearchResults {
  const scope = innerHtmlOfId(html, "cpsr_DivParts");
  if (!scope) throw parseError("part results container (#cpsr_DivParts)");
  const table = innerHtmlOfId(scope, "table_searchparts");
  if (!table) throw parseError("part results table (#table_searchparts)");

  const warehouse = textOfId(scope, "cpsr_LabelResultsHeader") ?? "";
  const results: PartOffer[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(table)) !== null) {
    const rowHtml = tr[1];
    // Skip the header row (<th>, no <td>).
    if (/<th\b/i.test(rowHtml) && !/<td\b/i.test(rowHtml)) continue;

    const stockCell = /<span\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/span\s*>/i.exec(rowHtml);
    const stockClass = stockCell?.[1] ?? "";
    const stockText = stockCell ? textOf(stockCell[2]).toLowerCase() : "";
    const stock: PartStock = /\bstock_high\b/.test(stockClass) || stockText === "yes"
      ? "in_stock"
      : /\bstock_low\b/.test(stockClass) || stockText === "call"
        ? "call_to_verify"
        : "unknown";

    const partCell = /<td\b[^>]*\bclass\s*=\s*["'][^"']*\bpartnumber\b[^"']*["'][^>]*>([\s\S]*?)<\/td\s*>/i.exec(rowHtml)?.[1];
    if (!partCell) continue;
    // Prefer the hidden srkey ("B036_DW02416 GTY FYG"); strip the warehouse prefix.
    const srkey = /<input\b[^>]*\bname\s*=\s*["']srkey\d*["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/i.exec(partCell)?.[1];
    const linkText = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/i.exec(partCell)?.[1];
    const partNumber = srkey
      ? decodeEntities(srkey).replace(/^[^_]+_/, "")
      : linkText
        ? textOf(linkText)
        : "";
    if (!partNumber) continue;

    const priceCell = /<td\b[^>]*\bclass\s*=\s*["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/td\s*>/i.exec(rowHtml)?.[1];
    const priceCents = priceCell ? extractPriceCents(textOf(priceCell)) : null;
    if (priceCents === null) continue;

    results.push({ part_number: partNumber, stock, price_cents: priceCents });
  }
  return { warehouse, results };
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
   * FREE path: YMM vehicle search costs the shop nothing. The site answers
   * with matching *vehicles* (#cms_DivModels), not glass parts — resolving
   * a vehicle to its parts needs the vehicle→parts drill-down page, which
   * has not been captured yet. Returns the vehicle matches.
   */
  async searchYmmVehicles(input: YmmSearchInput): Promise<YmmVehicleMatch[]> {
    const transport = this.getTransport();
    try {
      const params = new URLSearchParams({
        yr: String(input.year),
        mk: input.make,
        // MyGrant's model search is case-sensitive prefix matching: a
        // single first character returns the exhaustive model list.
        md: input.model,
        smdo: "Search"
      });
      const html = await this.authenticatedGet(
        transport,
        this.baseUrl + MYGRANT_YMM_SEARCH_PATH + "?" + params.toString()
      );
      return parseYmmVehicleList(html);
    } finally {
      if (!this.transport) await transport.close();
    }
  }

  /**
   * Interface method. The live site returns vehicles for a YMM search, not
   * glass candidates, and the vehicle→parts drill-down page has not been
   * captured — so this fails loudly rather than inventing candidates. Use
   * lookupVin for live identification, or searchYmmVehicles for the raw
   * vehicle matches.
   */
  async searchYmm(input: YmmSearchInput): Promise<GlassCandidate[]> {
    const vehicles = await this.searchYmmVehicles(input);
    throw new MyGrantError(
      "MYGRANT_PARSE_ERROR",
      `MyGrant YMM search matched ${vehicles.length} vehicle(s), but the ` +
        "vehicle→parts drill-down page has not been captured yet, so no " +
        "glass candidates can be produced. Use the $1 VIN lookup for live " +
        "identification instead. No charge was made (YMM is free).",
      502
    );
  }

  /**
   * PAID path: every call spends one $1 VIN lookup credit. Callers MUST
   * check the VIN cache first (glass-identification.ts does). The credits
   * counter is read before submitting: zero credits fails loudly WITHOUT
   * attempting the lookup. The form submits via GET (confirmed live).
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

      // Throws MYGRANT_UNSUPPORTED_GLASS_TYPE before anything is submitted.
      const glassTypeValue = siteGlassTypeValue(glassType);

      // From here on the $1 lookup is submitted: any failure may have
      // consumed the credit, so mark it charged (conservative with real money).
      try {
        const params = new URLSearchParams({
          [VIN_FIELD]: vin,
          // NOTE: the field name contains a colon; URLSearchParams encodes
          // it as cvs%3AGlassTypeSelect, which is what the site expects.
          "cvs:GlassTypeSelect": glassTypeValue,
          svindo: "Search"
        });
        const submitUrl = url + "?" + params.toString();
        let html = await transport.get(submitUrl);
        if (isLoginPage(html)) {
          // Session expired between the form read and the submission.
          this.loggedIn = false;
          await this.ensureLoggedIn(transport);
          html = await transport.get(submitUrl);
        }
        return parseVinResults(html, vin, glassType);
      } catch (error) {
        throw markCharged(error);
      }
    } finally {
      if (!this.transport) await transport.close();
    }
  }

  /**
   * FREE path: part-number search (pricing/stock for the sourcing flow).
   * Not part of the GlassCatalogProvider interface. Warehouse codes
   * observed live: B036 (Randolph, MA), B040 (Methuen, MA), B054
   * (Bloomfield, CT), r (regional), n (national).
   */
  async searchPartNumber(
    partNumber: string,
    warehouseCode = "B036"
  ): Promise<PartSearchResults> {
    const knownWarehouses = new Set(["B036", "B040", "B054", "r", "n"]);
    if (!knownWarehouses.has(warehouseCode)) {
      throw new MyGrantError(
        "MYGRANT_PARSE_ERROR",
        `Unknown MyGrant warehouse code "${warehouseCode}". ` +
          "Known codes: B036, B040, B054, r, n.",
        500
      );
    }
    const transport = this.getTransport();
    try {
      const params = new URLSearchParams({
        q: partNumber,
        sc: warehouseCode,
        do: "Search"
      });
      const html = await this.authenticatedGet(
        transport,
        this.baseUrl + MYGRANT_PART_SEARCH_PATH + "?" + params.toString()
      );
      return parsePartSearchResults(html);
    } finally {
      if (!this.transport) await transport.close();
    }
  }
}
