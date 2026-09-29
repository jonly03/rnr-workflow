import { describe, expect, it } from "vitest";
import {
  assertValidVin,
  expectedCheckDigit,
  isValidVin,
  VinValidationError
} from "../src/vin-validation.js";

describe("VIN validation (ISO 3779)", () => {
  it("accepts VINs with valid check digits", () => {
    expect(assertValidVin("1C4HJXEG3JW224862")).toBe("1C4HJXEG3JW224862");
    expect(assertValidVin("1HGCM82633A004352")).toBe("1HGCM82633A004352");
  });

  it("accepts X as a check digit", () => {
    expect(assertValidVin("8HGCM826X0A004352")).toBe("8HGCM826X0A004352");
    expect(expectedCheckDigit("8HGCM826X0A004352")).toBe("X");
  });

  it("normalizes lowercase input and surrounding whitespace", () => {
    expect(assertValidVin("  1hgcm82633a004352\t")).toBe("1HGCM82633A004352");
  });

  it("rejects VINs with the wrong check digit", () => {
    expect(() => assertValidVin("1HGCM82633A004353")).toThrow(VinValidationError);
    expect(() => assertValidVin("1HGCM82633A004353")).toThrow(/check digit/);
    // A single-character OCR-style misread is caught by the check digit.
    expect(() => assertValidVin("AAAAAAAAAAAAAAAAA")).toThrow(/check digit/);
  });

  it("rejects malformed VINs", () => {
    expect(() => assertValidVin("SHORT")).toThrow(/17 characters/);
    expect(() => assertValidVin("1HGCM82633A0043520")).toThrow(/17 characters/);
    expect(() => assertValidVin("1HGCM82633A00435I")).toThrow(/17 characters/);
    expect(() => assertValidVin("1HGCM82633A00435O")).toThrow(/17 characters/);
    expect(() => assertValidVin("1HGCM82633A00435Q")).toThrow(/17 characters/);
    expect(() => assertValidVin("")).toThrow(/17 characters/);
  });

  it("isValidVin mirrors assertValidVin without throwing", () => {
    expect(isValidVin("1HGCM82633A004352")).toBe(true);
    expect(isValidVin("8HGCM826X0A004352")).toBe(true);
    expect(isValidVin("1HGCM82633A004353")).toBe(false);
    expect(isValidVin("SHORT")).toBe(false);
    expect(isValidVin("1HGCM82633A00435I")).toBe(false);
  });
});
