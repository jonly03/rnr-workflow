import { describe, expect, it } from "vitest";
import {
  CHAT_NOTE_MAX_CHARS,
  buildChatNote,
  buildIntakeFormData,
  createEmptyChatData,
  damageVerdict,
  detectVoiceCapability,
  estimateRangeFor,
  formatPriceRange,
  isValidChatYear,
  isVinShape,
  nextChatStep,
  normalizeVin,
  parsePhoneNumber,
  parseYearMakeModel,
  previousChatStep,
  validatePhotos,
  verdictReason,
  type ChatIntakeData,
  type CustomerQuoteRanges
} from "./chat-intake";

const RANGES: CustomerQuoteRanges = {
  chip_repair_usd: [75, 125],
  windshield_usd: [300, 700],
  recalibration_usd: [275, 500]
};

function file(name: string, type = "image/jpeg", size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("step machine", () => {
  it("walks forward and back through the flow", () => {
    expect(nextChatStep("vehicle")).toBe("glass");
    expect(nextChatStep("damage")).toBe("verdict");
    expect(nextChatStep("review")).toBe("done");
    expect(nextChatStep("done")).toBeNull();
    expect(previousChatStep("glass")).toBe("vehicle");
    expect(previousChatStep("vehicle")).toBeNull();
  });
});

describe("VIN parsing", () => {
  it("normalizes a typed VIN", () => {
    expect(normalizeVin(" 1c4hjxeg3jw224862 ")).toBe("1C4HJXEG3JW224862");
    expect(normalizeVin("1c4-hjxeg3jw224862")).toBe("1C4HJXEG3JW224862");
  });

  it("checks the 17-character VIN shape", () => {
    expect(isVinShape("1C4HJXEG3JW224862")).toBe(true);
    expect(isVinShape("1C4HJXEG3JW22486")).toBe(false); // 16 chars
    expect(isVinShape("1C4HJXEG3JW22486I")).toBe(false); // I is not a VIN letter
    expect(isVinShape("1C4HJXEG3JW22486O")).toBe(false); // O is not a VIN letter
  });
});

describe("year/make/model parsing", () => {
  it("parses a full line", () => {
    expect(parseYearMakeModel("2018 Honda Civic")).toEqual({
      year: 2018,
      make: "Honda",
      model: "Civic"
    });
    expect(parseYearMakeModel("  2020 Toyota Tacoma  ")).toEqual({
      year: 2020,
      make: "Toyota",
      model: "Tacoma"
    });
  });

  it("keeps a multi-word model", () => {
    expect(parseYearMakeModel("2016 Ford F-150")).toEqual({
      year: 2016,
      make: "Ford",
      model: "F-150"
    });
  });

  it("returns an empty model when only year + make are given", () => {
    expect(parseYearMakeModel("2018 Honda")).toEqual({ year: 2018, make: "Honda", model: "" });
  });

  it("rejects lines without a plausible year", () => {
    expect(parseYearMakeModel("Honda Civic")).toBeNull();
    expect(parseYearMakeModel("1800 Honda Civic")).toBeNull();
    expect(parseYearMakeModel("2999 Honda Civic")).toBeNull();
    expect(parseYearMakeModel("")).toBeNull();
  });

  it("validates a 4-digit year in range", () => {
    expect(isValidChatYear("1950")).toBe(true);
    expect(isValidChatYear("1949")).toBe(false);
    expect(isValidChatYear("99")).toBe(false);
    expect(isValidChatYear("abcd")).toBe(false);
  });
});

describe("phone parsing", () => {
  it("normalizes common formats to 10 digits", () => {
    expect(parsePhoneNumber("(857) 266-1284")).toBe("8572661284");
    expect(parsePhoneNumber("+1 857-266-1284")).toBe("8572661284");
    expect(parsePhoneNumber("8572661284")).toBe("8572661284");
  });

  it("rejects short, long, and bad-area-code numbers", () => {
    expect(parsePhoneNumber("857266128")).toBeNull();
    expect(parsePhoneNumber("185726612845")).toBeNull();
    expect(parsePhoneNumber("0572661284")).toBeNull();
    expect(parsePhoneNumber("")).toBeNull();
  });
});

describe("chip vs replacement verdict", () => {
  it("repairs only when small, out of view, and off the edge", () => {
    expect(
      damageVerdict({ smallerThanQuarter: true, inLineOfSight: false, atEdge: false })
    ).toBe("chip_repair");
  });

  it("replaces when bigger than a quarter", () => {
    expect(
      damageVerdict({ smallerThanQuarter: false, inLineOfSight: false, atEdge: false })
    ).toBe("replacement");
  });

  it("replaces when in the driver's line of sight, even when small", () => {
    expect(
      damageVerdict({ smallerThanQuarter: true, inLineOfSight: true, atEdge: false })
    ).toBe("replacement");
  });

  it("replaces when at the edge, even when small", () => {
    expect(
      damageVerdict({ smallerThanQuarter: true, inLineOfSight: false, atEdge: true })
    ).toBe("replacement");
  });

  it("stays unknown until every question is answered", () => {
    expect(
      damageVerdict({ smallerThanQuarter: true, inLineOfSight: false, atEdge: null })
    ).toBe("unknown");
    expect(damageVerdict({ smallerThanQuarter: null, inLineOfSight: null, atEdge: null })).toBe(
      "unknown"
    );
  });

  it("explains the verdict in plain words, both languages", () => {
    const answers = { smallerThanQuarter: true, inLineOfSight: false, atEdge: false };
    expect(verdictReason("chip_repair", answers, "en")).toMatch(/Smaller than a quarter/);
    expect(verdictReason("chip_repair", answers, "es")).toMatch(/moneda de 25 centavos/);
    const bad = { smallerThanQuarter: false, inLineOfSight: true, atEdge: false };
    expect(verdictReason("replacement", bad, "en")).toMatch(/bigger than a quarter/);
    expect(verdictReason("replacement", bad, "en")).toMatch(/line of sight/);
  });
});

describe("price ranges", () => {
  it("formats a range", () => {
    expect(formatPriceRange([75, 125])).toBe("$75–$125");
  });

  it("shows the chip range for a chip repair on any glass", () => {
    expect(estimateRangeFor("DOOR_GLASS", "chip_repair", RANGES)).toEqual([75, 125]);
  });

  it("shows the windshield range for a windshield replacement", () => {
    expect(estimateRangeFor("WINDSHIELD", "replacement", RANGES)).toEqual([300, 700]);
  });

  it("shows no range for other glass replacements — the config has none", () => {
    expect(estimateRangeFor("BACK_GLASS", "replacement", RANGES)).toBeNull();
    expect(estimateRangeFor("WINDSHIELD", "unknown", RANGES)).toBeNull();
  });
});

describe("note builder", () => {
  it("packs the chat-only facts into one short note", () => {
    const note = buildChatNote({
      inputMode: "voice",
      payPath: "insurance",
      insurer: "Progressive",
      whenNeeded: "Friday morning",
      verdict: "chip_repair",
      verdictReason: "Smaller than a quarter, out of the driver's view, and away from the edge — it can be repaired.",
      lang: "en"
    });
    expect(note).toContain("Chat intake");
    expect(note).toContain("by voice");
    expect(note).toContain("Insurance: Progressive");
    expect(note).toContain("When: Friday morning");
    expect(note).toContain("First call: chip repair");
    expect(note.length).toBeLessThanOrEqual(CHAT_NOTE_MAX_CHARS);
  });

  it("handles cash with no insurer and no verdict", () => {
    const note = buildChatNote({
      inputMode: "typed",
      payPath: "cash",
      insurer: "",
      whenNeeded: "",
      verdict: "unknown",
      verdictReason: "",
      lang: "en"
    });
    expect(note).toBe("Chat intake · typed · Cash");
  });

  it("never exceeds 1000 chars, even with long free text", () => {
    const note = buildChatNote({
      inputMode: "typed",
      payPath: "insurance",
      insurer: "X".repeat(600),
      whenNeeded: "Y".repeat(600),
      verdict: "replacement",
      verdictReason: "Z".repeat(600),
      lang: "en"
    });
    expect(note.length).toBeLessThanOrEqual(CHAT_NOTE_MAX_CHARS);
  });

  it("builds the note in Spanish when the chat is Spanish", () => {
    const note = buildChatNote({
      inputMode: "typed",
      payPath: "cash",
      insurer: "",
      whenNeeded: "mañana",
      verdict: "unknown",
      verdictReason: "",
      lang: "es"
    });
    expect(note).toContain("Pago en efectivo");
    expect(note).toContain("Cuándo: mañana");
  });
});

describe("FormData builder", () => {
  function baseData(over: Partial<ChatIntakeData> = {}): ChatIntakeData {
    return {
      ...createEmptyChatData(),
      name: "Gaige Depina",
      phone: "(774) 297-4485",
      glassType: "WINDSHIELD",
      vin: "1C4HJXEG3JW224862",
      addressText: "36 Harrison St, Taunton MA 02780",
      ...over
    };
  }

  it("maps the chat fields to exactly the form's fields", () => {
    const form = buildIntakeFormData(baseData(), "Chat intake · typed · Cash");
    expect(form.get("customer_name")).toBe("Gaige Depina");
    expect(form.get("customer_phone")).toBe("7742974485");
    expect(form.get("glass_type")).toBe("WINDSHIELD");
    expect(form.get("vin")).toBe("1C4HJXEG3JW224862");
    expect(form.get("note")).toBe("Chat intake · typed · Cash");
    expect(JSON.parse(String(form.get("service_address")))).toEqual({
      formatted: "36 Harrison St, Taunton MA 02780"
    });
    // No stray keys: the server strips unknown keys, so only these may exist.
    expect([...form.keys()].sort()).toEqual(
      ["customer_name", "customer_phone", "glass_type", "note", "service_address", "vin"].sort()
    );
  });

  it("sends year/make/model when there is no VIN", () => {
    const form = buildIntakeFormData(
      baseData({ vin: "", year: "2016", make: "Toyota", model: "Tacoma" }),
      ""
    );
    expect(form.get("vin")).toBeNull();
    expect(form.get("year")).toBe("2016");
    expect(form.get("make")).toBe("Toyota");
    expect(form.get("model")).toBe("Tacoma");
    expect(form.get("note")).toBeNull();
  });

  it("sends a picked address with its structured fields", () => {
    const form = buildIntakeFormData(
      baseData({
        addressPicked: {
          place_id: "abc",
          formatted: "118 Terrace St, Roxbury, MA 02120",
          city: "Roxbury",
          state: "MA",
          zip: "02120",
          lat: 42.33,
          lon: -71.1
        },
        addressText: "118 Terrace St, Roxbury, MA 02120"
      }),
      ""
    );
    expect(JSON.parse(String(form.get("service_address")))).toEqual({
      place_id: "abc",
      formatted: "118 Terrace St, Roxbury, MA 02120",
      city: "Roxbury",
      state: "MA",
      zip: "02120",
      lat: 42.33,
      lon: -71.1
    });
  });

  it("attaches damage photos as photos entries", () => {
    const photo = file("crack.jpg");
    const form = buildIntakeFormData(baseData({ photos: [photo] }), "");
    expect(form.getAll("photos")).toEqual([photo]);
  });
});

describe("photo caps", () => {
  it("refuses non-images and oversized files, and caps at 6", () => {
    const { valid, problem } = validatePhotos(
      [file("a.jpg"), file("d.jpg"), file("b.txt", "text/plain"), file("c.jpg", "image/jpeg", 11 * 1024 * 1024)],
      5,
      "en"
    );
    expect(valid).toHaveLength(1);
    expect(problem).toMatch(/isn't an image/);
    expect(problem).toMatch(/larger than 10 MB/);
    expect(problem).toMatch(/extra weren't added/);
  });

  it("accepts clean files with no problem", () => {
    const { valid, problem } = validatePhotos([file("a.jpg"), file("b.jpg")], 0, "en");
    expect(valid).toHaveLength(2);
    expect(problem).toBeNull();
  });
});

describe("voice capability", () => {
  it("is unsupported with no SpeechRecognition", () => {
    expect(detectVoiceCapability({})).toBe("unsupported");
  });

  it("cannot verify on-device processing even when SpeechRecognition exists", () => {
    // No web API proves on-device processing, so the honest answer is
    // cant-verify — Talk stays off until the customer explicitly
    // chooses the labelled cloud fallback.
    expect(detectVoiceCapability({ SpeechRecognition: function () {} })).toBe("cant-verify");
    expect(detectVoiceCapability({ webkitSpeechRecognition: function () {} })).toBe("cant-verify");
  });
});
