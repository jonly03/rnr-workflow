import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAssetStorage,
  LocalAssetStorage,
  MockAssetStorage,
  S3AssetStorage
} from "../src/asset-storage.js";

const SECRET = ["storage", "test", "secret"].join("-");

describe("LocalAssetStorage (Slice B §7.2)", () => {
  it("round-trips bytes on disk and verifies capability signatures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-assets-"));
    const storage = new LocalAssetStorage(SECRET, "/api/v1", dir);
    const key = "cases/case-1/asset-1-photo.jpg";
    await storage.putBytes(key, Buffer.from([1, 2, 3]));
    expect(await storage.getBytes(key)).toEqual(Buffer.from([1, 2, 3]));
    expect(await storage.headObject(key)).toEqual({
      size_bytes: 3,
      content_type: null
    });
    expect(await storage.getBytes("cases/case-1/missing.jpg")).toBeNull();
    expect(await storage.headObject("cases/case-1/missing.jpg")).toBeNull();

    const target = await storage.createUploadTarget({
      assetId: "asset-1",
      key,
      contentType: "image/jpeg"
    });
    const url = new URL(target.url, "http://localhost");
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    expect(
      storage.verifyCapability({ method: "PUT", assetId: "asset-1", exp, sig })
    ).toBe(true);
    // A GET capability is not a PUT capability, and tampering fails.
    expect(
      storage.verifyCapability({ method: "GET", assetId: "asset-1", exp, sig })
    ).toBe(false);
    expect(
      storage.verifyCapability({
        method: "PUT",
        assetId: "asset-2",
        exp,
        sig
      })
    ).toBe(false);
  });

  it("refuses keys that escape the storage root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-assets-"));
    const storage = new LocalAssetStorage(SECRET, "/api/v1", dir);
    await expect(storage.putBytes("../escape.bin", Buffer.from([1]))).rejects.toThrow(
      /escapes the storage root/
    );
  });
});

describe("Asset storage factory (Slice B §7.2)", () => {
  it("defaults to local, and falls back loudly when s3 is half-configured", () => {
    expect(createAssetStorage({}, { signingSecret: SECRET }).name).toBe("local");
    expect(
      createAssetStorage(
        { ASSETS_STORAGE: "s3" },
        { signingSecret: SECRET }
      ).name
    ).toBe("local");
    const s3 = createAssetStorage(
      {
        ASSETS_STORAGE: "s3",
        ASSETS_S3_BUCKET: "rr-case-assets",
        AWS_ACCESS_KEY_ID: "AKIAFAKE",
        AWS_SECRET_ACCESS_KEY: "fake-secret"
      },
      { signingSecret: SECRET }
    );
    expect(s3.name).toBe("s3");
    expect(s3.serves).toEqual(["s3"]);
  });

  it("mints well-formed S3 presigned URLs without any network call", async () => {
    const storage = new S3AssetStorage({
      bucket: "rr-case-assets",
      region: "us-east-1",
      accessKeyId: "AKIAFAKE",
      secretAccessKey: "fake-secret"
    });
    const target = await storage.createUploadTarget({
      assetId: "asset-1",
      key: "cases/case-1/asset-1-photo.jpg",
      contentType: "image/jpeg"
    });
    const url = new URL(target.url);
    expect(url.host).toBe("rr-case-assets.s3.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/cases/case-1/asset-1-photo.jpg");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(target.headers["Content-Type"]).toBe("image/jpeg");

    const download = new URL(
      await storage.createDownloadUrl({ assetId: "asset-1", key: "cases/case-1/asset-1-photo.jpg" })
    );
    expect(download.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("mock driver keeps bytes in memory for tests", async () => {
    const storage = new MockAssetStorage(SECRET);
    await storage.putBytes("k", Buffer.from([7]));
    expect(await storage.getBytes("k")).toEqual(Buffer.from([7]));
    expect(storage.serves).toContain("mock");
  });
});
