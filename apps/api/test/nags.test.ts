import { describe, expect, it } from "vitest";
import {
  decodeNagsPartNumber,
  expandGlassDescription,
  distinguishingFeatures
} from "../src/nags.js";

describe("decodeNagsPartNumber — the format sheet's own examples", () => {
  it("decodes the sheet's worked example DW01205GBYN position by position", () => {
    const d = decodeNagsPartNumber("DW01205GBYN");
    expect(d).not.toBeNull();
    expect(d!.prefix).toBe("DW");
    expect(d!.origin).toBe("Domestic");
    expect(d!.partType).toBe("Windshield");
    expect(d!.numericCode).toBe("01205");
    expect(d!.colorCode).toBe("GB");
    expect(d!.color).toBe("Green tint / blue shade");
    expect(d!.attachmentCode).toBe("Y");
    expect(d!.attachment).toBe("Hardware included");
    expect(d!.premiumCode).toBe("N");
    expect(d!.warnings).toEqual([]);
    expect(d!.normalized).toBe("DW01205GBYN");
  });

  it("treats the with-zeroes and without-zeroes forms as the same part", () => {
    const a = decodeNagsPartNumber("FW00817GTNY");
    const b = decodeNagsPartNumber("FW817GTNY");
    expect(a!.numericCode).toBe("00817");
    expect(b!.numericCode).toBe("00817");
    expect(a!.normalized).toBe(b!.normalized);
    expect(a!.color).toBe("Green tint");
    expect(a!.attachment).toBe("No hardware included");
    expect(a!.premium).toBe("Manufacturer part (designer stamp)");
  });

  it("handles the no-premium form and the spaced forms", () => {
    expect(decodeNagsPartNumber("FW817GTN")!.premiumCode).toBeNull();
    const spaced = decodeNagsPartNumber("FW00817 GTN P");
    expect(spaced!.colorCode).toBe("GT");
    expect(spaced!.attachmentCode).toBe("N");
    expect(spaced!.premiumCode).toBe("P");
    expect(spaced!.premium).toBe("Premium");
    expect(decodeNagsPartNumber("FW00817GTNP")!.normalized).toBe(spaced!.normalized);
  });
});

describe("decodeNagsPartNumber — real shop numbers", () => {
  it("decodes the Safelite order's FW04108 GTY (2026 Tacoma windshield)", () => {
    const d = decodeNagsPartNumber("FW04108 GTY");
    expect(d).not.toBeNull();
    expect(d!.origin).toBe("Foreign");
    expect(d!.partType).toBe("Windshield");
    expect(d!.numericCode).toBe("04108");
    expect(d!.color).toBe("Green tint");
    expect(d!.attachment).toBe("Hardware included");
    expect(d!.premiumCode).toBeNull();
    expect(d!.summary).toContain("Foreign windshield");
  });

  it("decodes a bare base number with no suffix at all", () => {
    const d = decodeNagsPartNumber("FW05205");
    expect(d!.partType).toBe("Windshield");
    expect(d!.colorCode).toBeNull();
    expect(d!.warnings).toEqual([]);
  });

  it("decodes tempered prefixes from the MyGrant Sentra list", () => {
    expect(decodeNagsPartNumber("FD28223")!.partType).toBe("Door glass");
    expect(decodeNagsPartNumber("FV28227")!.partType).toBe("Vent glass");
    expect(decodeNagsPartNumber("FB28229")!.partType).toBe("Backlite / OE slider");
    expect(decodeNagsPartNumber("FB28229")!.origin).toBe("Foreign");
  });

  it("rejects non-NAGS input instead of guessing", () => {
    expect(decodeNagsPartNumber("XX12345")).toBeNull();
    expect(decodeNagsPartNumber("hello")).toBeNull();
    expect(decodeNagsPartNumber("")).toBeNull();
    expect(decodeNagsPartNumber("FW")).toBeNull();
  });

  it("names an uninterpretable suffix as a warning, keeping the rest", () => {
    const d = decodeNagsPartNumber("FW04108ZZZ");
    // ZZ is a real color (bronze/bronze); the trailing Z is not a code.
    expect(d!.colorCode).toBe("ZZ");
    expect(d!.warnings).toHaveLength(1);
    expect(d!.warnings[0]).toContain("Z");
  });
});

// The actual YMM result list from the shop's 2021 Nissan Sentra search.
const SENTRA = [
  "20-25 Nissan Sentra 4D Sedan (Slr, 3VF, MEXICO Only)",
  "20-25 Nissan Sentra 4D Sedan (MEXICO ONLY) (Slr, Electrochromic Mirror, 3VF)",
  "20-25 Nissan Sentra 4D Sedan (Slr, 3VF, LDWS, Fwd Coll w/Ped Detect)",
  "21-25 Nissan Sentra 4D Sedan (Slr, 3VF, LDWS, w/o Vin Notch, FCA w/Ped Detect)",
  "20-25 Nissan Sentra 4D Sedan F/R (Slr)",
  "20-25 Nissan Sentra 4D Sedan (Htd, Slr)"
];

describe("expandGlassDescription", () => {
  it("expands the abbreviations in a MyGrant description", () => {
    const e = expandGlassDescription(SENTRA[2]);
    expect(e.features).toContain("Solar glass");
    expect(e.features).toContain("Lane departure warning (camera)");
    expect(e.features).toContain("Forward collision system");
    expect(e.features).toContain("Pedestrian detection");
  });

  it("keeps w/o Vin Notch distinct from Vin Notch", () => {
    const e = expandGlassDescription(SENTRA[3]);
    expect(e.featureKeys).toContain("no-vin-notch");
    expect(e.featureKeys).not.toContain("vin-notch");
  });

  it("expands position and heated codes on non-windshield rows", () => {
    expect(expandGlassDescription(SENTRA[4]).features).toContain("Front right position");
    expect(expandGlassDescription(SENTRA[5]).features).toContain("Heated glass");
  });
});

describe("distinguishingFeatures — the filtering game", () => {
  it("returns exactly what differs across the four Sentra windshields", () => {
    const diffs = distinguishingFeatures(SENTRA.slice(0, 4));
    const keys = diffs.map(d => d.key);
    // Shared by all four — must NOT appear: solar, third-visor-frit, 4-door.
    expect(keys).not.toContain("solar");
    expect(keys).not.toContain("third-visor-frit");
    // The real questions: market, mirror, LDWS, collision, VIN notch, years.
    expect(keys).toContain("mexico-market");
    expect(keys).toContain("electrochromic-mirror");
    expect(keys).toContain("ldws");
    expect(keys).toContain("no-vin-notch");
    expect(keys).toContain("years:21-25");
    const ldws = diffs.find(d => d.key === "ldws")!;
    expect(ldws.presentIn).toEqual([2, 3]);
    expect(ldws.absentFrom).toEqual([0, 1]);
    expect(ldws.question).toContain("lane-departure camera");
  });

  it("returns nothing when candidates are identical", () => {
    expect(distinguishingFeatures([SENTRA[0], SENTRA[0]])).toEqual([]);
  });
});
