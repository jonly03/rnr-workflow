/**
 * Chat intake — pure logic for the Layer 1 talking intake (/chat).
 *
 * Everything in this file is framework-free and unit-testable: the
 * conversation step machine, free-text parsing, the chip-vs-replacement
 * verdict, the note builder, and the FormData builder. The React UI in
 * ./ChatIntake.tsx owns rendering, network, camera and microphone;
 * it calls into here for every decision.
 *
 * Field mapping to the 3-step form (apps/web/src/App.tsx
 * PublicIntakePage) and the server contract
 * (apps/api/src/app.ts publicIntakeSchema, read-only):
 *   form customer_name   <- chat contact step (name)
 *   form customer_phone  <- chat contact step (10-digit mobile)
 *   form glass_type      <- chat glass step (the same 5 options)
 *   form vin             <- chat vehicle step (scan or type), or
 *   form year/make/model <- chat vehicle step (YMM fallback)
 *   form service_address <- chat address step (picked suggestion, or
 *                           typed text — same demo relaxation as the form)
 *   form photos          <- chat damage step (same 6-photo / 10 MB caps)
 *   form note            <- everything the server has no field for:
 *                           channel "chat", voice/typed input mode,
 *                           insurance vs cash (+ insurer), when needed,
 *                           and the damage verdict + reasoning.
 * Unknown keys are stripped server-side, so nothing else may be added
 * to the FormData — the note is the only extra channel.
 */

import type { GlassType } from "./types";

export type ChatLang = "en" | "es";
export type InputMode = "voice" | "typed";
export type PayPath = "insurance" | "cash" | "";
export type DamageVerdict = "chip_repair" | "replacement" | "unknown";

/** Conversation steps, in order. Greeting is the first bot message, not a step. */
export type ChatStep =
  | "vehicle"
  | "glass"
  | "damage"
  | "verdict"
  | "pay"
  | "address"
  | "when"
  | "contact"
  | "review"
  | "done";

export const CHAT_STEP_ORDER: ChatStep[] = [
  "vehicle",
  "glass",
  "damage",
  "verdict",
  "pay",
  "address",
  "when",
  "contact",
  "review",
  "done"
];

export function nextChatStep(step: ChatStep): ChatStep | null {
  const i = CHAT_STEP_ORDER.indexOf(step);
  return i >= 0 && i < CHAT_STEP_ORDER.length - 1 ? CHAT_STEP_ORDER[i + 1] : null;
}

export function previousChatStep(step: ChatStep): ChatStep | null {
  const i = CHAT_STEP_ORDER.indexOf(step);
  return i > 0 ? CHAT_STEP_ORDER[i - 1] : null;
}

/** Vehicle-year bounds — mirrors the server (1950 .. next year) and the form's INTAKE_MIN_VEHICLE_YEAR. */
export const CHAT_MIN_VEHICLE_YEAR = 1950;

/** The 5 glass options, same ids and order as the form's INTAKE_GLASS_OPTIONS. */
export const CHAT_GLASS_OPTIONS: { id: GlassType; labelEn: string; labelEs: string }[] = [
  { id: "WINDSHIELD", labelEn: "Windshield", labelEs: "Parabrisas" },
  { id: "BACK_GLASS", labelEn: "Back glass", labelEs: "Vidrio trasero" },
  { id: "DOOR_GLASS", labelEn: "Door glass", labelEs: "Vidrio de puerta" },
  { id: "QUARTER_GLASS", labelEn: "Quarter glass", labelEs: "Vidrio lateral" },
  { id: "VENT_GLASS", labelEn: "Vent glass", labelEs: "Ventana pequeña" }
];

/** Photo caps — identical to the form (INTAKE_MAX_DAMAGE_PHOTOS / INTAKE_MAX_PHOTO_BYTES). */
export const CHAT_MAX_DAMAGE_PHOTOS = 6;
export const CHAT_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Server note ceiling (publicIntakeSchema: note max 1000). */
export const CHAT_NOTE_MAX_CHARS = 1000;

/** Everything the chat has collected, in one place. */
export interface ChatIntakeData {
  /** Vehicle id, exactly one of these two paths. */
  vin: string;
  /** Free NHTSA vPIC decode of the VIN, display-only ("2018 Honda HR-V"). Null when the lookup failed. */
  carInfo: string | null;
  year: string;
  make: string;
  model: string;
  glassType: GlassType | "";
  photos: File[];
  /** Damage questions — null until answered. */
  smallerThanQuarter: boolean | null;
  inLineOfSight: boolean | null;
  atEdge: boolean | null;
  verdict: DamageVerdict;
  payPath: PayPath;
  insurer: string;
  /** Picked suggestion, or null when the address was typed (demo relaxation, same as the form). */
  addressPicked: {
    place_id?: string;
    formatted: string;
    street?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    lat?: number;
    lon?: number;
  } | null;
  addressText: string;
  whenNeeded: string;
  name: string;
  phone: string;
  inputMode: InputMode;
}

export function createEmptyChatData(): ChatIntakeData {
  return {
    vin: "",
    carInfo: null,
    year: "",
    make: "",
    model: "",
    glassType: "",
    photos: [],
    smallerThanQuarter: null,
    inLineOfSight: null,
    atEdge: null,
    verdict: "unknown",
    payPath: "",
    insurer: "",
    addressPicked: null,
    addressText: "",
    whenNeeded: "",
    name: "",
    phone: "",
    inputMode: "typed"
  };
}

/** Uppercase, strip everything but letters/digits — the typed-VIN pre-clean. */
export function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Shape only (17 VIN-alphabet chars). The ISO 3779 check digit is the component's job (isValidVin, same gate as the form). */
export function isVinShape(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

/**
 * Parse a free-text year/make/model line, e.g. "2018 Honda Civic" or
 * "2020 Toyota Tacoma". Returns null when no 4-digit year leads the
 * line; model may be "" (the caller then asks for it). Year must be
 * in range — a leading number that isn't a plausible year is not a
 * vehicle line at all.
 */
export function parseYearMakeModel(text: string): { year: number; make: string; model: string } | null {
  const m = text.trim().match(/^(\d{4})\s+([A-Za-z][A-Za-z'’. -]*?)(?:\s+(.+))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const maxYear = new Date().getFullYear() + 1;
  if (year < CHAT_MIN_VEHICLE_YEAR || year > maxYear) return null;
  const make = m[2].trim();
  if (!make) return null;
  return { year, make, model: (m[3] ?? "").trim() };
}

export function isValidChatYear(raw: string): boolean {
  const t = raw.trim();
  if (!/^\d{4}$/.test(t)) return false;
  const y = Number(t);
  return y >= CHAT_MIN_VEHICLE_YEAR && y <= new Date().getFullYear() + 1;
}

/** US phone pre-check — mirrors the form's normalizeUsPhoneClient. Returns the 10 digits, or null. */
export function parsePhoneNumber(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (!/^[2-9]/.test(digits)) return null;
  return digits;
}

export function phoneProblem(raw: string, lang: ChatLang): string | null {
  if (parsePhoneNumber(raw) !== null) return null;
  const digits = raw.replace(/\D/g, "");
  if (lang === "es") {
    if (digits.length > 0 && digits.length < 10)
      return `Escriba un número de móvil válido de 10 dígitos — este tiene ${digits.length} dígitos.`;
    if (digits.length > 10) return "Escriba un número de móvil válido de 10 dígitos — este tiene demasiados dígitos.";
    if (digits.length === 10)
      return "Escriba un número de móvil válido de 10 dígitos — los códigos de área no empiezan con 0 ni 1.";
    return "Escriba un número de móvil válido de 10 dígitos.";
  }
  if (digits.length > 0 && digits.length < 10)
    return `Enter a valid 10-digit US mobile number — this one has ${digits.length} digits.`;
  if (digits.length > 10)
    return "Enter a valid 10-digit US mobile number — this one has too many digits.";
  if (digits.length === 10)
    return "Enter a valid 10-digit US mobile number — US area codes don't start with 0 or 1.";
  return "Enter a valid 10-digit US mobile number.";
}

// ---------------------------------------------------------------------
// Chip vs replacement
// ---------------------------------------------------------------------

export interface DamageAnswers {
  smallerThanQuarter: boolean | null;
  inLineOfSight: boolean | null;
  atEdge: boolean | null;
}

/**
 * The shop's first call on chip vs replacement. Repair only when the
 * damage is small AND out of the driver's view AND away from the edge:
 * a repair in the line of sight distorts what the driver sees, an
 * edge crack spreads, and anything bigger than a quarter is past what
 * a repair holds. Anything else is a replacement. Unanswered
 * questions mean no call yet. Labelled as a first call in the UI —
 * staff confirm it before the quote.
 */
export function damageVerdict(answers: DamageAnswers): DamageVerdict {
  const { smallerThanQuarter, inLineOfSight, atEdge } = answers;
  if (smallerThanQuarter === null || inLineOfSight === null || atEdge === null) {
    return "unknown";
  }
  return smallerThanQuarter && !inLineOfSight && !atEdge ? "chip_repair" : "replacement";
}

/** Plain-language reason for the verdict, one line, in the chat language. */
export function verdictReason(verdict: DamageVerdict, answers: DamageAnswers, lang: ChatLang): string {
  const es = lang === "es";
  if (verdict === "unknown") {
    return es ? "Aún faltan respuestas." : "Still missing answers.";
  }
  if (verdict === "chip_repair") {
    return es
      ? "Es más pequeño que una moneda de 25 centavos, no está en la vista del conductor y no está en el borde — se puede reparar."
      : "Smaller than a quarter, out of the driver's view, and away from the edge — it can be repaired.";
  }
  const parts: string[] = [];
  if (answers.smallerThanQuarter === false)
    parts.push(es ? "más grande que una moneda de 25 centavos" : "bigger than a quarter");
  if (answers.inLineOfSight)
    parts.push(es ? "está en la vista del conductor" : "in the driver's line of sight");
  if (answers.atEdge) parts.push(es ? "está en el borde del vidrio" : "at the edge of the glass");
  const why = parts.length > 0 ? parts.join(", ") : es ? "el daño es mayor" : "the damage is larger";
  return es
    ? `Parece un reemplazo — ${why}. Una reparación no lo aguantaría.`
    : `Looks like a replacement — ${why}. A repair wouldn't hold.`;
}

// ---------------------------------------------------------------------
// Pricing ranges (from apps/web/src/vin-brain-pricing.json — defaults Pedro sets)
// ---------------------------------------------------------------------

export interface CustomerQuoteRanges {
  chip_repair_usd: [number, number];
  windshield_usd: [number, number];
  recalibration_usd: [number, number];
}

export function formatPriceRange(range: [number, number]): string {
  return `$${range[0]}–$${range[1]}`;
}

/**
 * Typical price range to show with the verdict. Chip repair uses the
 * chip range for any glass. Windshield replacement uses the windshield
 * range (and the UI adds the recalibration range note). Any other
 * glass replacement has no range in the config — null means show no
 * number, just "we'll text your exact quote". All ranges are
 * estimates; staff confirm the real price.
 */
export function estimateRangeFor(
  glassType: GlassType | "",
  verdict: DamageVerdict,
  ranges: CustomerQuoteRanges
): [number, number] | null {
  if (verdict === "chip_repair") return ranges.chip_repair_usd;
  if (verdict === "replacement" && glassType === "WINDSHIELD") return ranges.windshield_usd;
  return null;
}

// ---------------------------------------------------------------------
// Note builder — the only place chat-only facts go (server strips
// unknown FormData keys, so these MUST live in `note`, ≤1000 chars)
// ---------------------------------------------------------------------

export interface ChatNoteInput {
  inputMode: InputMode;
  payPath: PayPath;
  insurer: string;
  whenNeeded: string;
  verdict: DamageVerdict;
  verdictReason: string;
  lang: ChatLang;
}

export function buildChatNote(input: ChatNoteInput): string {
  const es = input.lang === "es";
  const parts: string[] = [es ? "Chat intake" : "Chat intake"];
  parts.push(input.inputMode === "voice" ? (es ? "por voz" : "by voice") : (es ? "escrito" : "typed"));
  if (input.payPath === "insurance") {
    parts.push(
      input.insurer.trim()
        ? es
          ? `Seguro: ${input.insurer.trim()}`
          : `Insurance: ${input.insurer.trim()}`
        : es
          ? "Seguro"
          : "Insurance"
    );
  } else if (input.payPath === "cash") {
    parts.push(es ? "Pago en efectivo" : "Cash");
  }
  if (input.whenNeeded.trim()) {
    parts.push(es ? `Cuándo: ${input.whenNeeded.trim()}` : `When: ${input.whenNeeded.trim()}`);
  }
  if (input.verdict !== "unknown") {
    const label =
      input.verdict === "chip_repair"
        ? es
          ? "Primera opinión: reparar el chip"
          : "First call: chip repair"
        : es
          ? "Primera opinión: reemplazo"
          : "First call: replacement";
    parts.push(`${label} — ${input.verdictReason}`);
  }
  let note = parts.join(" · ");
  if (note.length > CHAT_NOTE_MAX_CHARS) {
    note = `${note.slice(0, CHAT_NOTE_MAX_CHARS - 1)}…`;
  }
  return note;
}

// ---------------------------------------------------------------------
// FormData builder — EXACTLY the form's fields, same order, same names
// ---------------------------------------------------------------------

export function buildIntakeFormData(data: ChatIntakeData, note: string): FormData {
  const form = new FormData();
  form.append("customer_name", data.name.trim());
  form.append("customer_phone", parsePhoneNumber(data.phone) ?? data.phone.trim());
  form.append("glass_type", data.glassType);
  form.append(
    "service_address",
    JSON.stringify(data.addressPicked ?? { formatted: data.addressText.trim() })
  );
  const vin = normalizeVin(data.vin);
  if (vin) {
    form.append("vin", vin);
  } else {
    if (data.year.trim()) form.append("year", data.year.trim());
    if (data.make.trim()) form.append("make", data.make.trim());
    if (data.model.trim()) form.append("model", data.model.trim());
  }
  if (note) form.append("note", note);
  for (const p of data.photos) form.append("photos", p);
  return form;
}

/** Photo-cap check shared with the UI — returns the files to add and a plain-language problem, if any. */
export function validatePhotos(
  incoming: File[],
  alreadyAdded: number,
  lang: ChatLang
): { valid: File[]; problem: string | null } {
  const es = lang === "es";
  const problems: string[] = [];
  const valid: File[] = [];
  for (const f of incoming) {
    if (!f.type.startsWith("image/")) {
      problems.push(es ? `“${f.name}” no es una imagen.` : `“${f.name}” isn't an image.`);
    } else if (f.size > CHAT_MAX_PHOTO_BYTES) {
      problems.push(es ? `“${f.name}” pesa más de 10 MB.` : `“${f.name}” is larger than 10 MB.`);
    } else {
      valid.push(f);
    }
  }
  const room = Math.max(CHAT_MAX_DAMAGE_PHOTOS - alreadyAdded, 0);
  const toAdd = valid.slice(0, room);
  if (valid.length > toAdd.length) {
    problems.push(
      es
        ? `Hasta ${CHAT_MAX_DAMAGE_PHOTOS} fotos — ${valid.length - toAdd.length} no se agregaron.`
        : `Up to ${CHAT_MAX_DAMAGE_PHOTOS} photos — ${valid.length - toAdd.length} extra weren't added.`
    );
  }
  return { valid: toAdd, problem: problems.length > 0 ? problems.join(" ") : null };
}

// ---------------------------------------------------------------------
// Voice capability — what the browser can actually prove
// ---------------------------------------------------------------------

export type VoiceCapability = "on-device-ready" | "downloading" | "cant-verify" | "unsupported";

/**
 * What the Talk button can honestly claim. There is no web API that
 * proves speech recognition runs on-device: the platform SpeechRecognition
 * (webkit prefix where needed) exists in some browsers and not others,
 * and it never says where the audio is processed. So:
 *   - no SpeechRecognition at all -> "unsupported" (Talk stays off)
 *   - present -> "cant-verify" (Talk stays off; the customer is pointed
 *     at the mic key on their phone keyboard, and may explicitly choose
 *     the clearly labelled browser-cloud fallback instead)
 * "on-device-ready" / "downloading" are the badge vocabulary for a
 * platform that can one day prove on-device processing — no browser
 * today does, so detection never returns them, and the UI never claims
 * on-device when it can't prove it.
 */
export function detectVoiceCapability(win: unknown): VoiceCapability {
  const w = (win ?? {}) as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  if (w.SpeechRecognition || w.webkitSpeechRecognition) return "cant-verify";
  return "unsupported";
}

/** Recognition language for the EN/ES toggle. */
export function recognitionLang(lang: ChatLang): string {
  return lang === "es" ? "es-US" : "en-US";
}
