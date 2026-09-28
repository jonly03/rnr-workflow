import { describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { JsonCaseStore } from "../src/store.js";
import { hashPassword } from "../src/auth.js";
import {
  extractVinCandidate,
  ocrVinFromImage,
  OcrError
} from "../src/vin-ocr.js";

describe("extractVinCandidate", () => {
  it("finds a VIN embedded in surrounding text", () => {
    expect(
      extractVinCandidate("VIN: 1HGCM82633A004352\nYear: 2003")
    ).toBe("1HGCM82633A004352");
  });

  it("normalizes OCR confusions: O→0, I/Q→1", () => {
    // Tesseract often reads 0 as O on VIN plates.
    expect(extractVinCandidate("1HGCM82633AOO4352")).toBe("1HGCM82633A004352");
    expect(extractVinCandidate("IHGCM82633A004352")).toBe("1HGCM82633A004352");
  });

  it("returns null when no 17-char candidate exists", () => {
    expect(extractVinCandidate("no vin here")).toBeNull();
    expect(extractVinCandidate("SHORT123")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractVinCandidate("vin 1hgcm82633a004352")).toBe(
      "1HGCM82633A004352"
    );
  });
});

describe("ocrVinFromImage", () => {
  const fakeImage = Buffer.from("fake-image-bytes");

  it("returns the VIN from stubbed OCR text", async () => {
    const result = await ocrVinFromImage(fakeImage, async () => ({
      text: "Plate reads 1HGCM82633A004352 clearly"
    }));
    expect(result.vin).toBe("1HGCM82633A004352");
  });

  it("returns null VIN when OCR text has none", async () => {
    const result = await ocrVinFromImage(fakeImage, async () => ({
      text: "blurry dashboard, nothing readable"
    }));
    expect(result.vin).toBeNull();
  });

  it("rejects empty images", async () => {
    await expect(ocrVinFromImage(Buffer.alloc(0))).rejects.toThrow(OcrError);
  });

  it("wraps recognizer failures in OcrError", async () => {
    await expect(
      ocrVinFromImage(fakeImage, async () => {
        throw new Error("tesseract exploded");
      })
    ).rejects.toThrow(OcrError);
  });
});

describe("POST /api/v1/vin/ocr", () => {
  async function authedFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnr-ocr-"));
    const store = new JsonCaseStore(path.join(dir, "cases.json"));
    await store.createStaffUser({
      email: "staff@example.com",
      name: "Test Staff",
      role: "staff",
      passwordHash: await hashPassword("password123")
    });
    const app = createApp(store, { authSecret: "test-secret-for-ocr" });
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "staff@example.com", password: "password123" })
      .expect(200);
    return { app, token: login.body.token as string };
  }

  // NOTE: these hit the real Tesseract with a 1x1 PNG — OCR finds no
  // text, which exercises the NOT_FOUND path deterministically.
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );

  it("requires authentication", async () => {
    const { app } = await authedFixture();
    await request(app)
      .post("/api/v1/vin/ocr")
      .attach("photo", tinyPng, "vin.png")
      .expect(401);
  });

  it("returns 422 when no photo is attached", async () => {
    const { app, token } = await authedFixture();
    const res = await request(app)
      .post("/api/v1/vin/ocr")
      .set("Authorization", `Bearer ${token}`)
      .expect(422);
    expect(res.body.error.code).toBe("VIN_OCR_NO_PHOTO");
  });

  it("returns 422 when no VIN is found in the image", async () => {
    const { app, token } = await authedFixture();
    const res = await request(app)
      .post("/api/v1/vin/ocr")
      .set("Authorization", `Bearer ${token}`)
      .attach("photo", tinyPng, "vin.png")
      .expect(422);
    expect(res.body.error.code).toBe("VIN_OCR_NOT_FOUND");
  }, 60000);
});
