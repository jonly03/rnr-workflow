import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ocrVinPhoto } from "./api";

describe("ocrVinPhoto", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    // jsdom has no createImageBitmap: exercises the original-file fallback.
    (globalThis as any).createImageBitmap = undefined;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("uploads the photo as multipart form data", async () => {
    const seen = new Map<string, unknown>();
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/vin\/ocr$/);
      expect(init.method).toBe("POST");
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const photo = form.get("photo");
      expect(photo).toBeInstanceOf(File);
      seen.set("name", (photo as File).name);
      return new Response(JSON.stringify({ vin: "1HGCM82633A004352" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const file = new File(["fake-image"], "vin.jpg", { type: "image/jpeg" });
    const result = await ocrVinPhoto(file);
    expect(result.vin).toBe("1HGCM82633A004352");
    expect(seen.get("name")).toBe("vin.jpg");
  });

  it("surfaces the API error message on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: "VIN_OCR_NOT_FOUND", message: "No VIN found in the photo." } }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const file = new File(["fake-image"], "vin.jpg", { type: "image/jpeg" });
    await expect(ocrVinPhoto(file)).rejects.toThrow("No VIN found in the photo.");
  });
});
