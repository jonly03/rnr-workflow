import { describe, expect, it } from "vitest";
import {
  OCR_BLUR_VARIANCE_THRESHOLD,
  PhotoBlurryError,
  contrastStretch,
  laplacianVariance,
  otsuThreshold,
  toGrayscale
} from "./api";

/** Build RGBA pixel data from a grayscale generator. */
function rgba(
  width: number,
  height: number,
  fn: (x: number, y: number) => number
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe("toGrayscale", () => {
  it("uses luminosity weights", () => {
    // pure red -> 0.299*255 ≈ 76
    const data = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(toGrayscale(data)[0]).toBe(76);
  });
});

describe("laplacianVariance", () => {
  it("scores a flat image near zero (hopeless blur)", () => {
    const gray = new Uint8ClampedArray(100 * 100).fill(128);
    expect(laplacianVariance(gray, 100, 100)).toBe(0);
  });

  it("scores sharp edges far above the blur threshold", () => {
    // checkerboard: maximum edge density
    const gray = new Uint8ClampedArray(100 * 100);
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) gray[y * 100 + x] = (x + y) % 2 ? 255 : 0;
    expect(laplacianVariance(gray, 100, 100)).toBeGreaterThan(
      OCR_BLUR_VARIANCE_THRESHOLD * 10
    );
  });

  it("scores a smooth gradient below the blur threshold", () => {
    // gentle ramp: no sharp edges, like an out-of-focus photo
    const gray = new Uint8ClampedArray(100 * 100);
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) gray[y * 100 + x] = Math.round((x / 100) * 40) + 100;
    expect(laplacianVariance(gray, 100, 100)).toBeLessThan(
      OCR_BLUR_VARIANCE_THRESHOLD
    );
  });
});

describe("contrastStretch", () => {
  it("expands a washed-out range to full scale", () => {
    // all pixels in [100, 140]: haze/glare washout
    const gray = new Uint8ClampedArray(1000).map(
      (_, i) => 100 + Math.round((i / 1000) * 40)
    );
    const out = contrastStretch(gray);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(255);
  });

  it("leaves a uniform image untouched", () => {
    const gray = new Uint8ClampedArray(500).fill(90);
    expect(Array.from(contrastStretch(gray)).every(v => v === 90)).toBe(true);
  });
});

describe("otsuThreshold", () => {
  it("splits a bimodal histogram between the peaks", () => {
    // dark text cluster ~40, light background cluster ~210
    const gray = new Uint8ClampedArray(2000);
    for (let i = 0; i < 1000; i++) gray[i] = 40 + (i % 7);
    for (let i = 1000; i < 2000; i++) gray[i] = 210 + (i % 7);
    const t = otsuThreshold(gray);
    // Any threshold in the gap between the clusters is optimal; assert it
    // separates the two cluster centers rather than pinning a location.
    expect(t).toBeGreaterThan(40); // above the dark cluster's floor
    expect(t).toBeLessThan(210); // below the light cluster's ceiling
    expect(t).toBeGreaterThan(43); // separates the dark center…
    expect(t).toBeLessThan(213); // …from the light center
  });
});

describe("PhotoBlurryError", () => {
  it("carries guidance and the measured sharpness", () => {
    const err = new PhotoBlurryError(12.5);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PhotoBlurryError");
    expect(err.sharpness).toBe(12.5);
    expect(err.message).toMatch(/too blurry/i);
    expect(err.message).toMatch(/type the VIN manually/i);
  });
});

describe("rgba helper sanity", () => {
  it("builds predictable test images", () => {
    const data = rgba(2, 1, x => (x === 0 ? 0 : 255));
    expect(toGrayscale(data)).toEqual(new Uint8ClampedArray([0, 255]));
  });
});
