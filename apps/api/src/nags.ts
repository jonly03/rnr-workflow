/**
 * NAGS part-number decoder + auto-glass description glossary.
 *
 * Why this exists (Nelly, 2026-10-29): without a VIN lookup, glass
 * identification is a YMM search that returns a LIST of candidate
 * parts whose differences are written in shorthand — NAGS suffix
 * codes on the part number itself (FW04108 GTY on a Safelite order)
 * and abbreviations in catalog descriptions (Slr, 3VF, LDWS, w/o Vin
 * Notch on MyGrant). Quoting the right glass means reading both.
 * This module turns both into plain language, deterministically:
 * lookup tables and token rules only, no external data, no AI.
 *
 * The NAGS tables are transcribed from the NAGS part-number format
 * sheet (National Auto Glass Specifications) photographed at the
 * shop on 2026-10-29: five sections — part-type prefix (positions
 * 1-2), numeric code (3-7, zero-filled), color code (8-9),
 * attachment code (10), premium indicator (11). Part numbers appear
 * with or without zero-fill and with or without spaces; all forms
 * parse to the same decode.
 */

// ---------------------------------------------------------------------
// Section I — part type prefix (positions 1-2)
// ---------------------------------------------------------------------

export interface NagsPrefix {
  origin: "Domestic" | "Foreign" | "Special";
  partType: string;
  category: string;
}

const PREFIXES: Record<string, NagsPrefix> = {
  DW: { origin: "Domestic", partType: "Windshield", category: "Windshield" },
  DL: { origin: "Domestic", partType: "Flat windshield", category: "Laminated" },
  DT: { origin: "Domestic", partType: "Flat non-windshield glass", category: "Flat tempered" },
  DB: { origin: "Domestic", partType: "Backlite / OE slider", category: "Tempered" },
  DD: { origin: "Domestic", partType: "Door glass", category: "Tempered" },
  DQ: { origin: "Domestic", partType: "Quarter glass", category: "Tempered" },
  DR: { origin: "Domestic", partType: "Roof glass", category: "Tempered" },
  DS: { origin: "Domestic", partType: "Side glass", category: "Tempered" },
  DP: { origin: "Domestic", partType: "Partition glass", category: "Tempered" },
  DV: { origin: "Domestic", partType: "Vent glass", category: "Tempered" },
  DY: { origin: "Domestic", partType: "Aftermarket back slider", category: "Tempered" },
  FW: { origin: "Foreign", partType: "Windshield", category: "Windshield" },
  FL: { origin: "Foreign", partType: "Flat windshield", category: "Laminated" },
  FT: { origin: "Foreign", partType: "Flat non-windshield glass", category: "Flat tempered" },
  FB: { origin: "Foreign", partType: "Backlite / OE slider", category: "Tempered" },
  FD: { origin: "Foreign", partType: "Door glass", category: "Tempered" },
  FQ: { origin: "Foreign", partType: "Quarter glass", category: "Tempered" },
  FR: { origin: "Foreign", partType: "Roof glass", category: "Tempered" },
  FS: { origin: "Foreign", partType: "Side glass", category: "Tempered" },
  FP: { origin: "Foreign", partType: "Partition glass", category: "Tempered" },
  FV: { origin: "Foreign", partType: "Vent glass", category: "Tempered" },
  FY: { origin: "Foreign", partType: "Aftermarket back slider", category: "Tempered" },
  SP: { origin: "Special", partType: '"S" flat glass part', category: "Special" }
};

// ---------------------------------------------------------------------
// Section III — color code (positions 8-9): tint color / shade color
// ---------------------------------------------------------------------

const COLORS: Record<string, string> = {
  BB: "Blue tint / blue shade",
  BG: "Blue tint / green shade",
  BK: "Blue tint / black frame",
  BP: "Blue tint privacy",
  BT: "Blue tint",
  BY: "Blue tint / gray shade",
  BZ: "Blue tint / bronze shade",
  CA: "Clear / aluminum frame",
  CB: "Clear / blue shade",
  CK: "Clear / black frame",
  CL: "Clear",
  GA: "Green tint / aluminum frame",
  GB: "Green tint / blue shade",
  GG: "Green tint / green shade",
  GK: "Green tint / black frame",
  GP: "Green tint privacy",
  GT: "Green tint",
  GY: "Green tint / gray shade",
  GZ: "Green tint / bronze shade",
  KP: "Black privacy",
  PA: "Privacy / aluminum frame",
  PK: "Privacy / black frame",
  YA: "Gray tint / aluminum frame",
  YB: "Gray tint / blue shade",
  YK: "Gray tint / black frame",
  YP: "Gray tint privacy",
  YT: "Gray tint",
  YY: "Gray tint / gray shade",
  ZB: "Bronze tint / blue shade",
  ZG: "Bronze tint / green shade",
  ZP: "Bronze tint privacy",
  ZT: "Bronze tint",
  ZY: "Bronze tint / gray shade",
  ZZ: "Bronze tint / bronze shade"
};

// ---------------------------------------------------------------------
// Section IV — attachment code (position 10): hardware provided with
// the glass (beyond a mirror bracket, antenna or connectors), or the
// slider construction.
// ---------------------------------------------------------------------

const ATTACHMENTS: Record<string, string> = {
  Y: "Hardware included",
  N: "No hardware included",
  "1": "Slider: 4-panel, full frame",
  "2": "Slider: 4-panel, encapsulated",
  "3": "Slider: 4-panel, partial frame",
  "4": "Slider: 3-panel, full frame",
  "5": "Slider: 3-panel, encapsulated",
  "6": "Slider: 3-panel, partial frame",
  "7": "Slider: 2-panel, flush fit"
};

// ---------------------------------------------------------------------
// Section V — premium indicator (position 11): the part is provided by
// the vehicle manufacturer and carries a designer trademark stamp.
// ---------------------------------------------------------------------

const PREMIUMS: Record<string, string> = {
  Y: "Manufacturer part (designer stamp)",
  N: "Not a manufacturer-stamped part",
  P: "Premium"
};

// ---------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------

export interface NagsDecode {
  input: string;
  /** Canonical form: prefix + zero-filled numeric code + suffix, no spaces. */
  normalized: string;
  prefix: string;
  origin: "Domestic" | "Foreign" | "Special";
  partType: string;
  category: string;
  /** Section II: the five-character numeric code, zero-filled. */
  numericCode: string;
  colorCode: string | null;
  color: string | null;
  attachmentCode: string | null;
  attachment: string | null;
  premiumCode: string | null;
  premium: string | null;
  /** Suffix material the tables couldn't interpret, named plainly. */
  warnings: string[];
  /** One-line plain-language reading of the whole number. */
  summary: string;
}

/**
 * Decode a NAGS part number in any of its written forms
 * ("FW00817GTNY", "FW817GTN", "FW00817 GTN P", "FW04108 GTY").
 * Returns null when the input isn't a NAGS-shaped number at all
 * (unknown prefix or no numeric code).
 */
export function decodeNagsPartNumber(raw: string): NagsDecode | null {
  if (typeof raw !== "string") return null;
  const compact = raw.toUpperCase().replace(/[\s-]/g, "");
  const m = /^([A-Z]{2})(\d{1,5})([A-Z0-9]*)$/.exec(compact);
  if (!m) return null;
  const [, prefix, digits, tailRaw] = m;
  const prefixInfo = PREFIXES[prefix];
  if (!prefixInfo) return null;

  const numericCode = digits.padStart(5, "0");
  let tail = tailRaw;
  const warnings: string[] = [];

  let colorCode: string | null = null;
  if (tail.length >= 2 && COLORS[tail.slice(0, 2)]) {
    colorCode = tail.slice(0, 2);
    tail = tail.slice(2);
  }
  let attachmentCode: string | null = null;
  if (tail.length >= 1 && ATTACHMENTS[tail[0]]) {
    attachmentCode = tail[0];
    tail = tail.slice(1);
  }
  let premiumCode: string | null = null;
  if (tail.length >= 1 && PREMIUMS[tail[0]]) {
    premiumCode = tail[0];
    tail = tail.slice(1);
  }
  if (tail.length > 0) {
    warnings.push(`Suffix "${tail}" isn't in the NAGS tables — check the number.`);
  }

  const color = colorCode ? COLORS[colorCode] : null;
  const attachment = attachmentCode ? ATTACHMENTS[attachmentCode] : null;
  const premium = premiumCode ? PREMIUMS[premiumCode] : null;
  const normalized =
    prefix + numericCode + (colorCode ?? "") + (attachmentCode ?? "") + (premiumCode ?? "");
  const summary = [
    `${prefixInfo.origin} ${prefixInfo.partType.toLowerCase()}`,
    color,
    attachment,
    premium
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    input: raw,
    normalized,
    prefix,
    origin: prefixInfo.origin,
    partType: prefixInfo.partType,
    category: prefixInfo.category,
    numericCode,
    colorCode,
    color,
    attachmentCode,
    attachment,
    premiumCode,
    premium,
    warnings,
    summary
  };
}

/** The glass family a NAGS prefix belongs to, for prefix-level filters. */
export function nagsPrefixInfo(prefix: string): NagsPrefix | null {
  return PREFIXES[prefix.toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------
// Catalog description glossary — the abbreviations MyGrant (and other
// catalogs) pack into part descriptions, e.g. the YMM result list for
// a 2021 Nissan Sentra: "(Slr, 3VF, LDWS, w/o Vin Notch, FCA w/Ped
// Detect)". Each entry also carries the yes/no question that settles
// it on a real car, because telling two candidate parts apart IS
// answering those questions (from the VIN/trim, the auction sticker
// photo, or the customer).
//
// Seeded 2026-10-29 from the shop's MyGrant screenshots and the
// windshield-feature diagram Nelly photographed. Entries marked
// CONFIRM are the standard industry reading but still want Lou's
// sign-off before staff rely on them.
// ---------------------------------------------------------------------

export interface GlossaryEntry {
  key: string;
  /** Plain-language name of the feature. */
  label: string;
  /** The question that tells a car WITH this apart from one without. */
  question?: string;
  match: RegExp;
}

export const GLASS_FEATURE_GLOSSARY: GlossaryEntry[] = [
  { key: "solar", label: "Solar glass", match: /\bSlr\b/ },
  {
    // CONFIRM (Lou): standard reading is third-visor frit.
    key: "third-visor-frit",
    label: "Third visor frit",
    match: /\b3VF\b/
  },
  {
    key: "ldws",
    label: "Lane departure warning (camera)",
    question: "Does the car have a lane-departure camera at the top center of the windshield?",
    match: /\bLDWS\b|Lane Departure/i
  },
  {
    key: "forward-collision",
    label: "Forward collision system",
    question: "Does the car have forward-collision braking/alert (a camera or sensor for the car ahead)?",
    match: /\bFCA\b|Fwd Coll|Forward Collision/i
  },
  { key: "ped-detect", label: "Pedestrian detection", match: /Ped Detect/i },
  {
    key: "heated",
    label: "Heated glass",
    question: "Is the glass heated (heating elements, e.g. a heated wiper park area)?",
    match: /\bHtd\b|Heated/i
  },
  {
    key: "electrochromic-mirror",
    label: "Electrochromic (auto-dimming) mirror",
    question: "Does the rear-view mirror auto-dim at night?",
    match: /Electrochromic/i
  },
  {
    key: "no-vin-notch",
    label: "No VIN notch",
    question: "Is there NO window/notch at the base of the windshield showing the VIN plate?",
    match: /w\/o Vin Notch/i
  },
  {
    key: "vin-notch",
    label: "VIN notch",
    question: "Can you see the VIN plate through a notch at the base of the windshield?",
    match: /(?<!w\/o )Vin Notch/i
  },
  {
    key: "mexico-market",
    label: "Mexico-market build only",
    question: "Was this car built for the Mexican market? (Mexican-BUILT is not the same — most Sentras are built in Mexico.)",
    match: /MEXICO Only/i
  },
  {
    key: "rain-sensor",
    label: "Rain sensor",
    question: "Does the car have automatic wipers (a rain sensor behind the mirror)?",
    match: /Rain Sensor/i
  },
  {
    key: "hud",
    label: "Head-up display (HUD)",
    question: "Does the car project a head-up display onto the windshield?",
    match: /\bHUD\b|Heads?-up/i
  },
  { key: "antenna", label: "Antenna in glass", match: /Antenna/i },
  { key: "shade-band", label: "Shade band", match: /Shade Band/i },
  { key: "third-visor", label: "Third visor", match: /Third Visor/i },
  { key: "encapsulated", label: "Encapsulated molding", match: /Encapsulated/i },
  { key: "front-right", label: "Front right position", match: /\bF\/R\b/ },
  { key: "front-left", label: "Front left position", match: /\bF\/L\b/ },
  { key: "rear-right", label: "Rear right position", match: /\bR\/R\b/ },
  { key: "rear-left", label: "Rear left position", match: /\bR\/L\b/ },
  { key: "four-door", label: "4-door", match: /\b4D\b/ },
  { key: "two-door", label: "2-door", match: /\b2D\b/ }
];

/** One-letter windshield feature codes from the shop's feature diagram. */
export const WINDSHIELD_FEATURE_LETTERS: Record<string, string> = {
  A: "Antenna",
  C: "Third visor (sun visor)",
  H: "Heater",
  P: "Mirror base",
  S: "Rain sensor",
  V: "VIN notch",
  X: "Ceramic band"
};

export interface ExpandedDescription {
  original: string;
  /** Feature keys found, in glossary order. */
  featureKeys: string[];
  /** Plain-language feature labels, ready to show staff. */
  features: string[];
}

/** Expand one catalog description into its plain-language features. */
export function expandGlassDescription(description: string): ExpandedDescription {
  const features: string[] = [];
  const featureKeys: string[] = [];
  for (const entry of GLASS_FEATURE_GLOSSARY) {
    if (entry.match.test(description)) {
      featureKeys.push(entry.key);
      features.push(entry.label);
    }
  }
  // Model-year range is a distinguisher too ("20-25" vs "21-25").
  const years = /(\d{2})-(\d{2})\b/.exec(description);
  if (years) {
    featureKeys.push(`years:${years[1]}-${years[2]}`);
    features.push(`Model years ${years[1]}–${years[2]}`);
  }
  return { original: description, featureKeys, features };
}

export interface DistinguishingFeature {
  key: string;
  label: string;
  question?: string;
  /** Indexes (into the input list) of candidates WITH the feature. */
  presentIn: number[];
  /** Indexes of candidates WITHOUT it. */
  absentFrom: number[];
}

/**
 * The filtering game, mechanized: given the candidate descriptions a
 * YMM search returned, return only the features that DIFFER between
 * them — each one is a question that eliminates some candidates.
 */
export function distinguishingFeatures(descriptions: string[]): DistinguishingFeature[] {
  const expanded = descriptions.map(expandGlassDescription);
  const allKeys = new Set<string>();
  for (const e of expanded) for (const k of e.featureKeys) allKeys.add(k);
  const byKey = new Map(GLASS_FEATURE_GLOSSARY.map(g => [g.key, g]));
  const out: DistinguishingFeature[] = [];
  for (const key of allKeys) {
    const presentIn: number[] = [];
    const absentFrom: number[] = [];
    expanded.forEach((e, i) => (e.featureKeys.includes(key) ? presentIn : absentFrom).push(i));
    if (presentIn.length === 0 || absentFrom.length === 0) continue;
    const entry = byKey.get(key);
    const label = entry?.label ?? expanded[presentIn[0]].features[expanded[presentIn[0]].featureKeys.indexOf(key)];
    out.push({ key, label, question: entry?.question, presentIn, absentFrom });
  }
  return out;
}
