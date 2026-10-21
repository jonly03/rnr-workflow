import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject
} from "node:crypto";

/**
 * Google Sign-In (OIDC) for operators — brief §7.1.
 *
 * Google is the identity provider for techs: it holds the credential, we
 * hold none. This module is deliberately inert when unconfigured: with no
 * GOOGLE_OIDC_CLIENT_ID / GOOGLE_OIDC_CLIENT_SECRET in the environment,
 * `loadGoogleOidcConfig` returns null and every Google route/flows
 * feature-detects off. Staff password auth is never affected.
 *
 * The provider seam (`GoogleIdentityProvider`) keeps tests off the live
 * Google endpoints: tests inject `MockGoogleIdentityProvider`, which
 * issues deterministic identities — no network, no real accounts.
 */

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  /** Absolute URL of this API's /auth/google/callback route. */
  redirectUri: string;
  /** Where the browser lands after the callback (the web app origin). */
  webOrigin: string;
}

/** Scopes kept minimal (least-privilege): identity + calendar event write. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events"
];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function loadGoogleOidcConfig(
  env: NodeJS.ProcessEnv = process.env
): GoogleOidcConfig | null {
  const clientId = env.GOOGLE_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OIDC_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  const webOrigin =
    env.GOOGLE_OIDC_WEB_ORIGIN?.trim() ||
    (env.CORS_ORIGIN ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)[0] ||
    "";
  return { clientId, clientSecret, redirectUri, webOrigin };
}

export interface GoogleIdentity {
  /** Google account subject id (stable per account). */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleTokenSet {
  idToken: string;
  accessToken: string | null;
  /** Present when Google grants offline access (first consent). */
  refreshCredential: string | null;
  expiresInSeconds: number | null;
}

export interface GoogleIdentityProvider {
  readonly name: string;
  buildAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<GoogleTokenSet>;
  verifyIdToken(idToken: string): Promise<GoogleIdentity>;
}

export class GoogleAuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

// --- Signed OAuth state (CSRF + flow context) ---

export interface GoogleOAuthState {
  nonce: string;
  /** Raw invite credential when this flow is an onboarding accept. */
  invite: string | null;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlDecode = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function signOAuthState(state: GoogleOAuthState, secret: string): string {
  const body = b64url(JSON.stringify(state));
  const signature = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}

export function verifyOAuthState(
  signed: string,
  secret: string
): GoogleOAuthState | null {
  const parts = signed.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (typeof parsed?.nonce !== "string") return null;
    return {
      nonce: parsed.nonce,
      invite: typeof parsed.invite === "string" ? parsed.invite : null
    };
  } catch {
    return null;
  }
}

export function newOAuthState(invite: string | null): GoogleOAuthState {
  return { nonce: randomBytes(16).toString("hex"), invite };
}

// --- Live Google provider (real endpoints; used only when configured) ---

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export class HttpGoogleIdentityProvider implements GoogleIdentityProvider {
  readonly name = "google";
  private jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

  constructor(private readonly config: GoogleOidcConfig) {}

  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true"
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<GoogleTokenSet> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code"
      })
    });
    if (!response.ok) {
      throw new GoogleAuthError(
        "GOOGLE_EXCHANGE_FAILED",
        "Google sign-in could not be completed. Please try again."
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.id_token !== "string") {
      throw new GoogleAuthError(
        "GOOGLE_EXCHANGE_FAILED",
        "Google sign-in could not be completed. Please try again."
      );
    }
    return {
      idToken: body.id_token,
      accessToken: typeof body.access_token === "string" ? body.access_token : null,
      refreshCredential:
        typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null
    };
  }

  private async jwks(): Promise<Jwk[]> {
    if (this.jwksCache && Date.now() - this.jwksCache.fetchedAt < 10 * 60 * 1000) {
      return this.jwksCache.keys;
    }
    const response = await fetch(GOOGLE_JWKS_URL);
    if (!response.ok) {
      throw new GoogleAuthError(
        "GOOGLE_JWKS_FAILED",
        "Google sign-in could not be verified. Please try again."
      );
    }
    const body = (await response.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    this.jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    let header: { kid?: string; alg?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlDecode(headerPart).toString("utf8"));
      payload = JSON.parse(b64urlDecode(payloadPart).toString("utf8"));
    } catch {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    const jwk = (await this.jwks()).find(k => k.kid === header.kid);
    if (!jwk) {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as never, format: "jwk" });
    } catch {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, "utf8");
    const signature = b64urlDecode(signaturePart);
    if (!cryptoVerify("RSA-SHA256", signed, key, signature)) {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    if (!GOOGLE_ISSUERS.includes(String(payload.iss))) {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    if (payload.aud !== this.config.clientId) {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      throw new GoogleAuthError("GOOGLE_TOKEN_EXPIRED", "Google sign-in expired. Please try again.");
    }
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Google sign-in was not valid.");
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : payload.email
    };
  }
}

// --- Mock provider (tests + local demos; never talks to Google) ---

/**
 * Deterministic in-memory provider. `identities` maps an authorization
 * "code" to the identity Google would have asserted, so tests drive the
 * full callback flow — including the invite email-match rule — without
 * any network access.
 */
export class MockGoogleIdentityProvider implements GoogleIdentityProvider {
  readonly name = "mock-google";
  private readonly tokens = new Map<string, GoogleIdentity>();

  constructor(
    private readonly config: GoogleOidcConfig,
    private readonly identities: Record<string, GoogleIdentity> = {}
  ) {}

  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      state
    });
    return `https://mock-google.invalid/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<GoogleTokenSet> {
    const identity = this.identities[code];
    if (!identity) {
      throw new GoogleAuthError(
        "GOOGLE_EXCHANGE_FAILED",
        "Unknown mock authorization code."
      );
    }
    const idToken = `mock.${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
    this.tokens.set(idToken, identity);
    return {
      idToken,
      accessToken: "mock-access",
      refreshCredential: `mock-refresh-${identity.sub}`,
      expiresInSeconds: 3600
    };
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    const identity = this.tokens.get(idToken);
    if (!identity) {
      throw new GoogleAuthError("GOOGLE_TOKEN_INVALID", "Unknown mock id token.");
    }
    return identity;
  }
}
