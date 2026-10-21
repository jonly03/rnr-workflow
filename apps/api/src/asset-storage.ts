import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Asset byte storage — Fulfillment Slice B (brief §7.2).
 *
 * Bytes live in object storage; Postgres/JSON rows hold only metadata
 * (case_assets). Access is always mediated by the API: it checks the
 * requester's right to the asset FIRST, then mints a short-lived URL.
 * No permanent or public links, ever.
 *
 * Drivers:
 *  - `s3`    — a private S3 bucket. Uploads go direct-to-S3 from the
 *              phone/browser via a presigned PUT (5 min); downloads via
 *              a presigned GET (15 min). Bytes never proxy through the
 *              API. Complete but inert until the bucket + IAM env vars
 *              are set (see createAssetStorage).
 *  - `local` — dev/test driver: bytes on local disk, URLs are
 *              capability-signed API paths served by the content route.
 *  - `mock`  — in-memory driver for tests (same capability-URL shape).
 */

export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface StoredObjectInfo {
  size_bytes: number;
  content_type: string | null;
}

export interface AssetStorage {
  readonly name: string;
  /** Driver names whose objects this instance can serve. */
  readonly serves: string[];
  createUploadTarget(input: {
    assetId: string;
    key: string;
    contentType: string;
  }): Promise<UploadTarget>;
  createDownloadUrl(input: { assetId: string; key: string }): Promise<string>;
  headObject(key: string): Promise<StoredObjectInfo | null>;
}

/** A driver whose bytes move through the API content route (local/mock). */
export interface ByteServingStorage extends AssetStorage {
  putBytes(key: string, bytes: Buffer): Promise<void>;
  getBytes(key: string): Promise<Buffer | null>;
  verifyCapability(input: {
    method: string;
    assetId: string;
    exp: string;
    sig: string;
  }): boolean;
}

export function isByteServing(storage: AssetStorage): storage is ByteServingStorage {
  return (
    typeof (storage as ByteServingStorage).putBytes === "function" &&
    typeof (storage as ByteServingStorage).verifyCapability === "function"
  );
}

export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------
// Capability-signed local URLs: an HMAC over (method, asset id, expiry)
// is the credential — the same hash-token pattern the app already uses
// for invite and approval links. The signing secret is the API's auth
// secret, passed in at construction; it is never stored or serialized.
// ---------------------------------------------------------------------

abstract class CapabilityStorage implements ByteServingStorage {
  abstract readonly name: string;
  abstract readonly serves: string[];

  constructor(
    protected readonly signingSecret: string,
    protected readonly contentBasePath: string
  ) {}

  protected capability(method: string, assetId: string, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac("sha256", this.signingSecret)
      .update(`${method}:${assetId}:${exp}`)
      .digest("hex");
    return `${this.contentBasePath}/assets/${assetId}/content?exp=${exp}&sig=${sig}`;
  }

  verifyCapability(input: {
    method: string;
    assetId: string;
    exp: string;
    sig: string;
  }): boolean {
    const exp = Number(input.exp);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const expected = createHmac("sha256", this.signingSecret)
      .update(`${input.method}:${input.assetId}:${exp}`)
      .digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(input.sig, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async createUploadTarget(input: {
    assetId: string;
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    return {
      url: this.capability("PUT", input.assetId, UPLOAD_URL_TTL_SECONDS),
      method: "PUT",
      headers: { "Content-Type": input.contentType }
    };
  }

  async createDownloadUrl(input: { assetId: string; key: string }): Promise<string> {
    return this.capability("GET", input.assetId, DOWNLOAD_URL_TTL_SECONDS);
  }

  abstract putBytes(key: string, bytes: Buffer): Promise<void>;
  abstract getBytes(key: string): Promise<Buffer | null>;
  abstract headObject(key: string): Promise<StoredObjectInfo | null>;
}

/** Dev/test driver: bytes under a local directory (default ../data/assets). */
export class LocalAssetStorage extends CapabilityStorage {
  readonly name = "local";
  readonly serves = ["local"];
  private readonly rootDir: string;

  constructor(signingSecret: string, contentBasePath: string, rootDir?: string) {
    super(signingSecret, contentBasePath);
    this.rootDir = rootDir ?? path.resolve(here, "../data/assets");
  }

  private fileFor(key: string): string {
    const resolved = path.resolve(this.rootDir, key);
    if (!resolved.startsWith(path.resolve(this.rootDir) + path.sep)) {
      throw new Error("Asset key escapes the storage root.");
    }
    return resolved;
  }

  async putBytes(key: string, bytes: Buffer): Promise<void> {
    const file = this.fileFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }

  async getBytes(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.fileFor(key));
    } catch {
      return null;
    }
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    try {
      const stat = fs.statSync(this.fileFor(key));
      return { size_bytes: stat.size, content_type: null };
    } catch {
      return null;
    }
  }
}

/** In-memory driver for tests: records bytes in a Map, no disk, no AWS. */
export class MockAssetStorage extends CapabilityStorage {
  readonly name = "mock";
  readonly serves = ["mock", "local"];
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  constructor(signingSecret = "mock-signing-secret", contentBasePath = "/api/v1") {
    super(signingSecret, contentBasePath);
  }

  async putBytes(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, { bytes, contentType: "application/octet-stream" });
  }

  async getBytes(key: string): Promise<Buffer | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    const found = this.objects.get(key);
    return found
      ? { size_bytes: found.bytes.length, content_type: found.contentType }
      : null;
  }
}

// ---------------------------------------------------------------------
// S3 driver: AWS Signature Version 4 presigned URLs + a signed HEAD
// for upload confirmation. No SDK dependency — presigning is a
// self-contained HMAC construction.
// ---------------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function s3SigningKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3AssetStorage implements AssetStorage {
  readonly name = "s3";
  readonly serves = ["s3"];

  constructor(private readonly config: S3StorageConfig) {}

  private host(): string {
    return `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
  }

  private presign(method: "PUT" | "GET", key: string, expiresSeconds: number): string {
    const { bucket, region, accessKeyId, secretAccessKey } = this.config;
    const { amzDate, dateStamp } = amzDates(new Date());
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const canonicalUri = `/${encodeKey(key)}`;
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host"
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join("&");
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      `host:${this.host()}\n`,
      "host",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signature = hmac(
      s3SigningKey(secretAccessKey, dateStamp, region),
      stringToSign
    ).toString("hex");
    return `https://${this.host()}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async createUploadTarget(input: {
    assetId: string;
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    return {
      url: this.presign("PUT", input.key, UPLOAD_URL_TTL_SECONDS),
      method: "PUT",
      headers: { "Content-Type": input.contentType }
    };
  }

  async createDownloadUrl(input: { assetId: string; key: string }): Promise<string> {
    return this.presign("GET", input.key, DOWNLOAD_URL_TTL_SECONDS);
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    const { region, accessKeyId, secretAccessKey } = this.config;
    const { amzDate, dateStamp } = amzDates(new Date());
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const canonicalUri = `/${encodeKey(key)}`;
    const signedHeaders = "host;x-amz-date";
    const canonicalRequest = [
      "HEAD",
      canonicalUri,
      "",
      `host:${this.host()}\nx-amz-date:${amzDate}\n`,
      signedHeaders,
      sha256Hex("")
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signature = hmac(
      s3SigningKey(secretAccessKey, dateStamp, region),
      stringToSign
    ).toString("hex");
    const response = await fetch(`https://${this.host()}${canonicalUri}`, {
      method: "HEAD",
      headers: {
        "x-amz-date": amzDate,
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`
      }
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`S3 HEAD failed with status ${response.status}.`);
    }
    return {
      size_bytes: Number(response.headers.get("content-length") ?? 0),
      content_type: response.headers.get("content-type")
    };
  }
}

// ---------------------------------------------------------------------
// Factory: ASSETS_STORAGE=s3|local (default local). S3 is used only
// when bucket + credentials are all present; asking for s3 without
// them logs loudly and falls back to local rather than crashing the
// API or silently dropping photos.
// ---------------------------------------------------------------------

export function createAssetStorage(
  env: NodeJS.ProcessEnv = process.env,
  opts: { signingSecret: string; contentBasePath?: string }
): AssetStorage {
  const contentBasePath = opts.contentBasePath ?? "/api/v1";
  const local = () =>
    new LocalAssetStorage(
      opts.signingSecret,
      contentBasePath,
      env.ASSETS_LOCAL_DIR?.trim() || undefined
    );
  if ((env.ASSETS_STORAGE ?? "").trim().toLowerCase() !== "s3") {
    return local();
  }
  const bucket = env.ASSETS_S3_BUCKET?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  const region = env.ASSETS_S3_REGION?.trim() || env.AWS_REGION?.trim() || "us-east-1";
  if (!bucket || !accessKeyId || !secretAccessKey) {
    console.error(
      "ASSETS_STORAGE=s3 but ASSETS_S3_BUCKET / AWS_ACCESS_KEY_ID / " +
        "AWS_SECRET_ACCESS_KEY are not all set; falling back to local asset storage."
    );
    return local();
  }
  return new S3AssetStorage({ bucket, region, accessKeyId, secretAccessKey });
}
