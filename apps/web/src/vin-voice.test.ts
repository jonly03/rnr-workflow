import { describe, expect, it } from "vitest";
import { normalizeSpokenVin, validateSpokenVin, vinCheckDigit } from "./vin-voice";

describe("normalizeSpokenVin", () => {
  it("maps NATO phonetics to letters", () => {
    expect(
      normalizeSpokenVin(
        "one charlie four hotel juliet xray echo golf three juliet whiskey two two four eight six two"
      )
    ).toBe("1C4HJXEG3JW224862");
  });

  it("maps spoken letter and digit names", () => {
    expect(normalizeSpokenVin("one see four aitch jay ex echo golf three jay double-you two two four eight six two")).toBe(
      "1C4HJXEG3JW224862"
    );
  });

  it("maps oh to zero and drops clarifications like 'B as in Bravo'", () => {
    expect(normalizeSpokenVin("bee as in bravo oh seven")).toBe("B07");
    expect(normalizeSpokenVin("em as in mary")).toBe("M");
  });

  it("strips filler words and passes through clean runs", () => {
    expect(normalizeSpokenVin("uh one c four, then hotel juliet dash xray")).toBe("1C4HJX");
  });

  it("handles doubled and tripled characters", () => {
    expect(normalizeSpokenVin("double oh seven triple five")).toBe("007555");
  });

  it("handles an empty transcript", () => {
    expect(normalizeSpokenVin("")).toBe("");
    expect(normalizeSpokenVin("um uh")).toBe("");
  });
});

describe("vinCheckDigit", () => {
  it("verifies the documented Honda example (check digit 3)", () => {
    expect(vinCheckDigit("1HGCM82633A004352")).toBe("3");
  });

  it("verifies the Wikipedia example with check digit X", () => {
    expect(vinCheckDigit("1M8GDM9AXKP042788")).toBe("X");
  });

  it("returns null for malformed input", () => {
    expect(vinCheckDigit("SHORT")).toBeNull();
    expect(vinCheckDigit("1HGCM82633A00435!")).toBeNull();
  });
});

describe("validateSpokenVin", () => {
  it("accepts a valid VIN", () => {
    const result = validateSpokenVin("1HGCM82633A004352");
    expect(result).toEqual({ ok: true, vin: "1HGCM82633A004352" });
  });

  it("accepts a valid VIN with check digit X", () => {
    expect(validateSpokenVin("1M8GDM9AXKP042788").ok).toBe(true);
  });

  it("rejects a short transcript with a helpful message", () => {
    const result = validateSpokenVin("1HGCM82633A00435");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/16 of 17/);
  });

  it("rejects a VIN with a wrong check digit", () => {
    // Position 9 changed from 3 to 5.
    const result = validateSpokenVin("1HGCM82635A004352");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/check digit/i);
  });

  it("rejects forbidden characters (I, O, Q)", () => {
    const result = validateSpokenVin("1HGCM82633A00435O");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/never use I, O, or Q/);
  });
});
