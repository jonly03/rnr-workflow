import { randomUUID } from "node:crypto";
import type { CaseStore } from "./store.js";
import type { AssetStorage } from "./asset-storage.js";
import type {
  AssetKind,
  AssetVisibility,
  CaseAsset,
  Channel,
  StaffUser
} from "./types.js";

/**
 * Case assets — Fulfillment Slice B (brief §7.3).
 *
 * Every file on a case is registered here with a visibility class, and
 * every read path filters by (role + case relationship + visibility).
 * The law, enforced server-side on upload authorization, download-URL
 * issuance, and listing:
 *
 *  - staff / admin / owner: everything on cases in their channels.
 *  - the ASSIGNED tech: TECH_VISIBLE assets on their job's case, plus
 *    the case's intake photos (the damage view they work from, §7.3
 *    matrix). NEVER invoice / signed-quote assets (no economics) and
 *    never INTERNAL assets.
 *  - anyone else (another tech, the client surface): nothing. Client
 *    photo display is out of scope for v1 (§5.1: clients get summaries),
 *    so no public/client route serves assets at all in this slice.
 */

export type AssetErrorCode =
  | "ASSET_NOT_FOUND"
  | "ASSET_FORBIDDEN"
  | "ASSET_NOT_READY"
  | "ASSET_NO_BYTES"
  | "ASSET_STORAGE_UNAVAILABLE"
  | "VALIDATION_ERROR";

export class AssetError extends Error {
  constructor(
    readonly code: AssetErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "AssetError";
  }
}

/** Upload allowlist (brief §7.2): images + PDF, 10 MB per file — the
 *  same cap the existing multer flows use. */
export const ASSET_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf"
] as const;

export const ASSET_MAX_BYTES = 10 * 1024 * 1024;

/** Kinds a tech may upload from a job's checklist. */
export const TECH_UPLOAD_KINDS: AssetKind[] = ["BEFORE_PHOTO", "AFTER_PHOTO"];

/** Default visibility per kind (§7.3 matrix). */
export const ASSET_VISIBILITY_BY_KIND: Record<AssetKind, AssetVisibility> = {
  INTAKE_PHOTO: "CLIENT_VISIBLE",
  BEFORE_PHOTO: "TECH_VISIBLE",
  AFTER_PHOTO: "TECH_VISIBLE",
  INVOICE_PDF: "CLIENT_VISIBLE",
  SIGNED_QUOTE: "CLIENT_VISIBLE",
  OTHER: "INTERNAL"
};

/** An asset as it may leave the server: the storage key never does. */
export type AssetView = Omit<CaseAsset, "storage_key"> & { has_bytes: boolean };

export function assetView(asset: CaseAsset): AssetView {
  const { storage_key: _key, ...rest } = asset;
  return { ...rest, has_bytes: asset.storage_driver !== "metadata" };
}

const STAFF_ROLES = ["staff", "admin", "owner"];

function channelAllowed(staff: StaffUser, channel: Channel): boolean {
  if (!staff.channels) return true;
  return staff.channels.includes(channel);
}

/**
 * The read law. `staff` is the authenticated operator record (any role).
 * Returns true only when the requester may see this asset's metadata AND
 * be issued a download URL for its bytes.
 */
export async function canReadAsset(
  store: CaseStore,
  staff: StaffUser,
  asset: CaseAsset
): Promise<boolean> {
  const caseRecord = await store.getCase(asset.case_id);
  if (!caseRecord) return false;
  if (STAFF_ROLES.includes(staff.role)) {
    return channelAllowed(staff, caseRecord.channel);
  }
  if (staff.role === "tech") {
    // Own jobs only: the asset must belong to a case whose job is
    // assigned to this tech. Completed jobs count — the tech who did
    // the work can still show their photos.
    const job = await store.getJobByCase(asset.case_id);
    if (!job || job.assigned_tech_id !== staff.id) return false;
    if (asset.visibility === "TECH_VISIBLE") return true;
    // §7.3 matrix: the assigned tech sees the client's intake photos
    // (damage view) even though they are CLIENT_VISIBLE — but never the
    // other CLIENT_VISIBLE kinds (invoice, signed quote = economics).
    return asset.kind === "INTAKE_PHOTO";
  }
  return false;
}

/** Loads an asset the requester may read; absence and denial are the
 *  same 404 so asset existence cannot be probed across the law. */
export async function loadReadableAsset(
  store: CaseStore,
  staff: StaffUser,
  assetId: string
): Promise<CaseAsset> {
  const asset = await store.getCaseAsset(assetId);
  if (!asset || !(await canReadAsset(store, staff, asset))) {
    throw new AssetError("ASSET_NOT_FOUND", "Asset not found.", 404);
  }
  return asset;
}

/** Lists the assets on a case that the requester may read. */
export async function listReadableAssets(
  store: CaseStore,
  staff: StaffUser,
  caseId: string
): Promise<CaseAsset[]> {
  const assets = await store.listCaseAssets(caseId);
  const readable: CaseAsset[] = [];
  for (const asset of assets) {
    if (await canReadAsset(store, staff, asset)) readable.push(asset);
  }
  return readable;
}

/**
 * Issues a short-lived download URL for an asset the requester may
 * read. The access check happens HERE, before any URL exists (brief
 * §7.2: presigned URLs only after an API case-access check).
 */
export async function issueDownloadUrl(
  store: CaseStore,
  storage: AssetStorage,
  staff: StaffUser,
  assetId: string
): Promise<{ asset: AssetView; url: string }> {
  const asset = await loadReadableAsset(store, staff, assetId);
  if (asset.storage_driver === "metadata") {
    throw new AssetError(
      "ASSET_NO_BYTES",
      "This asset is metadata only — no file bytes were stored.",
      409
    );
  }
  if (!storage.serves.includes(asset.storage_driver)) {
    throw new AssetError(
      "ASSET_STORAGE_UNAVAILABLE",
      "This file lives in a storage driver that is not active on this deployment.",
      409
    );
  }
  if (asset.status !== "READY") {
    throw new AssetError("ASSET_NOT_READY", "This file has not finished uploading.", 409);
  }
  const url = await storage.createDownloadUrl({ assetId: asset.id, key: asset.storage_key });
  return { asset: assetView(asset), url };
}

export interface UploadRequestInput {
  kind: AssetKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** Validates an upload request against the §7.2 allowlist + size cap. */
export function validateUploadRequest(input: UploadRequestInput): void {
  if (!(ASSET_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new AssetError(
      "VALIDATION_ERROR",
      `Files of type ${input.contentType || "(unknown)"} cannot be uploaded. Use a photo (JPEG, PNG, WebP, HEIC) or a PDF.`,
      422
    );
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new AssetError("VALIDATION_ERROR", "A positive file size is required.", 422);
  }
  if (input.sizeBytes > ASSET_MAX_BYTES) {
    throw new AssetError(
      "VALIDATION_ERROR",
      `Files are limited to ${Math.round(ASSET_MAX_BYTES / (1024 * 1024))} MB.`,
      422
    );
  }
  if (!input.filename.trim() || input.filename.length > 200) {
    throw new AssetError("VALIDATION_ERROR", "A file name is required.", 422);
  }
}

/** Storage key layout: case-scoped prefix (multi-tenant friendly, §7.2). */
export function assetStorageKey(input: {
  caseId: string;
  assetId: string;
  filename: string;
}): string {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
  return `cases/${input.caseId}/${input.assetId}-${safeName}`;
}

/**
 * Registers an authorized upload: creates the PENDING asset row and
 * returns the storage target the client PUTs bytes to. The asset id is
 * minted here (not by the store) because the storage key embeds it and
 * the key must be final before any bytes land. Confirmation is a
 * separate step (confirmAssetUpload) once the bytes are stored.
 * Callers authorize BEFORE calling this — registration itself assumes
 * the uploader's right to the case/job was already established.
 */
export async function registerAssetUpload(
  store: CaseStore,
  storage: AssetStorage,
  input: {
    caseId: string;
    jobId: string | null;
    kind: AssetKind;
    filename: string;
    contentType: string;
    sizeBytes: number;
    uploadedBy: { type: string; id: string | null };
  }
): Promise<{
  asset: CaseAsset;
  upload: { url: string; method: "PUT"; headers: Record<string, string> };
}> {
  validateUploadRequest(input);
  const id = randomUUID();
  const key = assetStorageKey({ caseId: input.caseId, assetId: id, filename: input.filename });
  const asset = await store.createCaseAsset({
    id,
    caseId: input.caseId,
    jobId: input.jobId,
    kind: input.kind,
    visibility: ASSET_VISIBILITY_BY_KIND[input.kind],
    storageDriver: storage.name,
    storageKey: key,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    status: "PENDING",
    uploadedBy: input.uploadedBy
  });
  const upload = await storage.createUploadTarget({
    assetId: asset.id,
    key,
    contentType: input.contentType
  });
  return { asset, upload };
}

/**
 * Confirms an upload: the object must actually exist in storage before
 * the asset becomes READY (only READY assets count for the checklist
 * photo gates and can be downloaded). The recorded size is corrected
 * to what storage reports.
 */
export async function confirmAssetUpload(
  store: CaseStore,
  storage: AssetStorage,
  asset: CaseAsset
): Promise<CaseAsset> {
  if (asset.status === "READY") return asset;
  if (!storage.serves.includes(asset.storage_driver)) {
    throw new AssetError(
      "ASSET_STORAGE_UNAVAILABLE",
      "This file lives in a storage driver that is not active on this deployment.",
      409
    );
  }
  const head = await storage.headObject(asset.storage_key);
  if (!head) {
    throw new AssetError(
      "ASSET_NOT_READY",
      "The file has not arrived in storage yet. Finish the upload, then confirm.",
      409
    );
  }
  return store.updateCaseAsset(asset.id, {
    status: "READY",
    size_bytes: head.size_bytes
  });
}
