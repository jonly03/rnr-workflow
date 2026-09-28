/**
 * Voice VIN intake — transcript normalization and VIN validation.
 *
 * Pure functions (unit-tested in vin-voice.test.ts). The browser
 * SpeechRecognition wiring lives in useVinVoice.ts; the UI lives in App.tsx.
 *
 * Design note: spelled-out characters are the weak spot of every speech
 * engine, so the transcript is treated as a *proposal* that must survive
 * three gates before it can reach the decode flow:
 *   1. normalization (NATO phonetics, spoken letter/digit names, filler words)
 *   2. VIN alphabet + length (17 chars, no I/O/Q)
 *   3. ISO 3779 check digit (position 9 is computed from the other 16)
 */

/** NATO phonetic alphabet → letter. */
const NATO: Record<string, string> = {
  alpha: "A",
  bravo: "B",
  charlie: "C",
  delta: "D",
  echo: "E",
  foxtrot: "F",
  golf: "G",
  hotel: "H",
  india: "I",
  juliet: "J",
  juliett: "J",
  kilo: "K",
  lima: "L",
  mike: "M",
  november: "N",
  oscar: "O",
  papa: "P",
  quebec: "Q",
  romeo: "R",
  sierra: "S",
  tango: "T",
  uniform: "U",
  victor: "V",
  whiskey: "W",
  whisky: "W",
  xray: "X",
  "x-ray": "X",
  yankee: "Y",
  zulu: "Z"
};

/**
 * How single letters and digits come out of a transcript when spoken
 * plainly ("be" for B, "oh" for 0, "double-u" for W, ...).
 * Note: "oh"/"o" map to 0, never O — O is not a valid VIN character.
 */
const SPOKEN_TOKENS: Record<string, string> = {
  ay: "A",
  aye: "A",
  be: "B",
  bee: "B",
  cee: "C",
  see: "C",
  sea: "C",
  dee: "D",
  de: "D",
  e: "E",
  ee: "E",
  ef: "F",
  gee: "G",
  aitch: "H",
  aych: "H",
  eye: "I",
  jay: "J",
  kay: "K",
  el: "L",
  ell: "L",
  em: "M",
  en: "N",
  oh: "0",
  o: "0",
  pee: "P",
  pea: "P",
  cue: "Q",
  queue: "Q",
  ar: "R",
  are: "R",
  ess: "S",
  tee: "T",
  tea: "T",
  you: "U",
  u: "U",
  vee: "V",
  doubleyou: "W",
  "double-you": "W",
  "double-u": "W",
  ex: "X",
  why: "Y",
  zed: "Z",
  zee: "Z",
  zero: "0",
  one: "1",
  won: "1",
  two: "2",
  to: "2",
  too: "2",
  three: "3",
  four: "4",
  for: "4",
  fore: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  ate: "8",
  nine: "9",
  nein: "9"
};

/** Filler words that carry no VIN content ("B as in Bravo", "dash", ...). */
const FILLER = new Set([
  "as",
  "like",
  "dash",
  "hyphen",
  "minus",
  "space",
  "next",
  "then",
  "and",
  "um",
  "uh",
  "er"
]);

/**
 * Turns a raw speech transcript into a VIN candidate.
 * Handles NATO phonetics ("bravo" → B), spoken names ("bee" → B, "oh" → 0),
 * clarifications ("B as in Bravo" → B — the clarifying word is redundant),
 * and filler words. Unknown tokens are dropped; the length gate in
 * validateSpokenVin catches anything that went missing.
 */
export function normalizeSpokenVin(transcript: string): string {
  const tokens = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // "double oh seven" → "007": repeat the next character's value.
    if (t === "double" || t === "triple") {
      const next = tokens[i + 1];
      // "double-you" is the spoken name of the letter W, not "UU".
      if (t === "double" && (next === "you" || next === "u")) {
        out.push("W");
        i += 1;
        continue;
      }
      const mappedNext =
        next !== undefined
          ? (NATO[next] ?? SPOKEN_TOKENS[next] ?? (/^[a-z0-9]$/.test(next) ? next.toUpperCase() : undefined))
          : undefined;
      if (mappedNext && mappedNext.length === 1) {
        const times = t === "double" ? 2 : 3;
        for (let k = 0; k < times; k++) out.push(mappedNext);
        i += 1;
      }
      continue;
    }
    // "X as in <word>": the word after "as in" only clarifies the
    // character we already have — drop the whole clarification.
    if (t === "as" && tokens[i + 1] === "in") {
      i += 2;
      continue;
    }
    if (FILLER.has(t)) continue;
    const mapped = NATO[t] ?? SPOKEN_TOKENS[t];
    if (mapped) {
      out.push(mapped);
      continue;
    }
    // A clean alphanumeric run passes through ("1c4", "jw224862").
    if (/^[a-z0-9]+$/.test(t)) {
      out.push(t.toUpperCase());
    }
    // Anything else is unrecognizable speech noise — drop it.
  }
  return out.join("");
}

/** ISO 3779 / FMVSS 115 transliteration values. */
const TRANSLITERATION: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9
};

const CHECK_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * Computes the ISO 3779 check digit for a 17-character VIN.
 * Returns null when the input is not a 17-char alphanumeric string.
 */
export function vinCheckDigit(vin: string): string | null {
  const upper = vin.toUpperCase();
  if (!/^[A-Z0-9]{17}$/.test(upper)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const value = TRANSLITERATION[upper[i]];
    if (value === undefined) return null;
    sum += value * CHECK_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

export type VinValidation = { ok: true; vin: string } | { ok: false; reason: string };

const VIN_ALPHABET = /^[A-HJ-NPR-Z0-9]$/;

/**
 * Validates a normalized VIN candidate. A real VIN always has 17 characters
 * from the VIN alphabet and a correct check digit, so anything failing here
 * was misheard — the caller should ask the user to speak it again.
 */
export function validateSpokenVin(candidate: string): VinValidation {
  const vin = candidate.toUpperCase();
  if (vin.length !== 17) {
    return {
      ok: false,
      reason: `I heard ${vin.length} of 17 characters. Try speaking a little slower, one character at a time.`
    };
  }
  for (let i = 0; i < vin.length; i++) {
    if (!VIN_ALPHABET.test(vin[i])) {
      return {
        ok: false,
        reason:
          `Character ${i + 1} came out as "${vin[i]}" — VINs never use I, O, or Q. ` +
          `Say that character again, or tap it to fix it below.`
      };
    }
  }
  const expected = vinCheckDigit(vin);
  if (expected !== vin[8]) {
    return {
      ok: false,
      reason:
        `That VIN fails its check digit — position 9 should be "${expected}", not "${vin[8]}". ` +
        `At least one character was misheard. Try the VIN again, or tap a character to fix it.`
    };
  }
  return { ok: true, vin };
}
