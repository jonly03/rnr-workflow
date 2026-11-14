/**
 * Chat intake (/chat) — the Layer 1 talking intake.
 *
 * A plain-language conversation that collects exactly what the 3-step
 * form collects (PublicIntakePage) and submits the same FormData
 * through the same submitPublicIntake call — no server changes, no
 * new fields. Chat-only facts (channel, voice/typed, insurance vs
 * cash, when needed, damage verdict) ride in `note`, because the
 * server strips unknown FormData keys.
 *
 * Voice: on-device transcription first. No web API can prove speech
 * recognition runs on-device, so Talk stays OFF unless the platform
 * can prove it — the badge says so honestly — and the customer is
 * pointed at the mic key on their phone keyboard. A browser-cloud
 * fallback exists only as an explicit, clearly labelled choice. Only
 * transcribed text ever reaches the intake; no audio is recorded or
 * stored by us (SpeechRecognition hands us text, never audio).
 *
 * Prices: customer ranges come from the shared
 * apps/web/src/vin-brain-pricing.json (defaults Pedro sets) — never
 * hardcoded here. Ranges are shown as typical, staff confirm the
 * real price with the quote.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  submitPublicIntake,
  suggestAddresses,
  type AddressSuggestion
} from "./api";
import { IntakeLiveStatus } from "./IntakeLiveStatus";
import { VinStickerScanner } from "./VinStickerScan";
import { isValidVin, lookupVinCarInfo } from "./vin-scan";
import {
  CHAT_GLASS_OPTIONS,
  CHAT_MAX_DAMAGE_PHOTOS,
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
  phoneProblem,
  previousChatStep,
  recognitionLang,
  validatePhotos,
  verdictReason,
  type ChatIntakeData,
  type ChatLang,
  type ChatStep,
  type CustomerQuoteRanges,
  type VoiceCapability
} from "./chat-intake";
import pricing from "./vin-brain-pricing.json";

const QUOTE_RANGES = pricing.customer_quote_ranges as unknown as CustomerQuoteRanges;

interface ChatMessage {
  id: number;
  from: "bot" | "user";
  text: string;
}

type VehicleMode = "ask" | "scan" | "type" | "ymm";

/** Minimal SpeechRecognition shape — the DOM lib's is incomplete across browsers, and webkit's isn't typed at all. */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionResultLike extends ArrayLike<{ transcript: string }> {
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
  resultIndex: number;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const STRINGS: Record<ChatLang, Record<string, string>> = {
  en: {
    heroTitle: "Chat with us — start your auto glass request",
    heroSub: "Answer a few questions and we'll text you a quote link. No account, no payment due now.",
    greeting:
      "Hi, this is R&R's Finest Auto Glass — 118 Terrace St, Roxbury. I can start your request right here. What car is it for?",
    scanChip: "Scan the door sticker",
    typeVinChip: "Type the VIN",
    ymmChip: "Year, make, model",
    vinPrompt: "Type your 17-character VIN — it's on the dash by the windshield, or on your registration.",
    vinInvalid: "That doesn't look like a VIN — 17 characters, letters and numbers, no I, O or Q.",
    vinLookupFail:
      "We couldn't look this VIN up — we'll confirm the exact vehicle with you. That's fine, let's keep going.",
    carConfirm: "Is this your car?",
    yes: "Yes, that's my car",
    no: "No, that's not it",
    ymmPrompt: "What year, make and model is it?",
    yearPh: "Year (e.g. 2018)",
    makePh: "Make (e.g. Honda)",
    modelPh: "Model (e.g. HR-V)",
    ymmInvalid: "Add the year, make and model — for example, 2018 Honda HR-V.",
    ymmHint: "Or just type it in the chat, like “2018 Honda HR-V”.",
    glassPrompt: "Which glass needs service?",
    damagePrompt:
      "A photo helps us identify the right glass. If you can, take one of the damage — and a few quick questions:",
    photoLabel: "Damage photo (optional)",
    takePhoto: "📷 Take a photo",
    choosePhoto: "🖼️ Choose from library",
    photoCount: "photos added",
    qSmaller: "Is the crack smaller than a quarter?",
    qSight: "Is it in the driver's line of sight?",
    qEdge: "Is it at the edge of the glass?",
    verdictIntro: "Our first call — the shop confirms it before your quote:",
    verdictContinue: "Continue",
    verdictRange: "Typical range",
    verdictRecal:
      "If your car needs camera recalibration after a new windshield, that usually adds $275–$500 — the quote will say for sure.",
    verdictNoRange: "We'll text your exact quote — no price to guess at here.",
    payPrompt: "Insurance or paying yourself?",
    insuranceChip: "Insurance",
    cashChip: "Cash / paying myself",
    insurerPrompt: "Which insurance company?",
    insurerPh: "e.g. Progressive",
    addressPrompt: "Where will the car be? Start typing the address.",
    addressPh: "Street, city, state",
    addressUseTyped: "Use this address",
    addressInvalid: "Tell us where we'll find the car — type the address, or pick it from the list.",
    whenPrompt: "When do you need it done?",
    asapChip: "As soon as possible",
    whenPh: "e.g. Friday morning",
    namePrompt: "What's your name?",
    namePh: "Your full name",
    nameInvalid: "Please enter your full name.",
    phonePrompt: "What's your mobile number? We'll text your quote link here.",
    phonePh: "(617) 555-0123",
    reviewTitle: "Here's what I have — check it over:",
    sendChip: "Send request",
    startOver: "Start over",
    sending: "Sending…",
    inputPh: "Type your answer…",
    inputDisabled: "Tap an answer above",
    talkLabel: "🎙️ Talk",
    talkListening: "Listening… tap again to stop",
    talkOffNote:
      "Voice is off — your phone's keyboard has a mic key that types what you say. That keeps your voice on your phone.",
    talkCloudOffer: "Use browser voice instead",
    talkCloudNote:
      "Browser voice sends audio to your browser's speech service to turn it into text. Only the text comes to us — we never get or store audio.",
    talkUnsupported: "Voice isn't available in this browser — type instead, or use your keyboard's mic key.",
    talkError: "Voice didn't catch that — try again, or type instead.",
    submitError: "Something went wrong — please try again.",
    doneTitle: "✓ Request received",
    doneSave: "Save your reference — mention it if you call us. No payment is due now; you'll see your price in the quote we text you, and nothing moves forward until you approve it.",
    back: "‹ Back",
    shopLine: "R&R's Finest Auto Glass · 118 Terrace St, Roxbury MA · 857-266-1284"
  },
  es: {
    heroTitle: "Hable con nosotros — empiece su solicitud",
    heroSub: "Responda unas preguntas y le enviaremos un enlace con el precio por texto. Sin cuenta, sin pago ahora.",
    greeting:
      "Hola, somos R&R's Finest Auto Glass — 118 Terrace St, Roxbury. Puedo empezar su solicitud aquí mismo. ¿Para qué auto es?",
    scanChip: "Escanear la calcomanía de la puerta",
    typeVinChip: "Escribir el VIN",
    ymmChip: "Año, marca, modelo",
    vinPrompt: "Escriba su VIN de 17 caracteres — está en el tablero junto al parabrisas, o en su registro.",
    vinInvalid: "Eso no parece un VIN — 17 caracteres, letras y números, sin I, O ni Q.",
    vinLookupFail:
      "No pudimos buscar este VIN — confirmaremos el vehículo exacto con usted. No pasa nada, sigamos.",
    carConfirm: "¿Es este su auto?",
    yes: "Sí, es mi auto",
    no: "No, no es ese",
    ymmPrompt: "¿Qué año, marca y modelo es?",
    yearPh: "Año (ej. 2018)",
    makePh: "Marca (ej. Honda)",
    modelPh: "Modelo (ej. HR-V)",
    ymmInvalid: "Agregue el año, la marca y el modelo — por ejemplo, 2018 Honda HR-V.",
    ymmHint: "O escríbalo en el chat, como “2018 Honda HR-V”.",
    glassPrompt: "¿Qué vidrio necesita servicio?",
    damagePrompt:
      "Una foto nos ayuda a identificar el vidrio correcto. Si puede, tome una del daño — y unas preguntas rápidas:",
    photoLabel: "Foto del daño (opcional)",
    takePhoto: "📷 Tomar una foto",
    choosePhoto: "🖼️ Elegir de la galería",
    photoCount: "fotos agregadas",
    qSmaller: "¿La grieta es más pequeña que una moneda de 25 centavos?",
    qSight: "¿Está en la vista del conductor?",
    qEdge: "¿Está en el borde del vidrio?",
    verdictIntro: "Nuestra primera opinión — el taller la confirma antes de su precio:",
    verdictContinue: "Continuar",
    verdictRange: "Rango típico",
    verdictRecal:
      "Si su auto necesita recalibración de la cámara después de un parabrisas nuevo, eso suele agregar $275–$500 — el precio dirá con seguridad.",
    verdictNoRange: "Le enviaremos su precio exacto por texto — aquí no hay que adivinar.",
    payPrompt: "¿Seguro o paga usted mismo?",
    insuranceChip: "Seguro",
    cashChip: "Efectivo / pago yo mismo",
    insurerPrompt: "¿Qué compañía de seguro?",
    insurerPh: "ej. Progressive",
    addressPrompt: "¿Dónde estará el auto? Empiece a escribir la dirección.",
    addressPh: "Calle, ciudad, estado",
    addressUseTyped: "Usar esta dirección",
    addressInvalid: "Díganos dónde encontraremos el auto — escriba la dirección o elija una de la lista.",
    whenPrompt: "¿Cuándo lo necesita?",
    asapChip: "Lo antes posible",
    whenPh: "ej. viernes en la mañana",
    namePrompt: "¿Cuál es su nombre?",
    namePh: "Su nombre completo",
    nameInvalid: "Escriba su nombre completo.",
    phonePrompt: "¿Cuál es su número de móvil? Le enviaremos el enlace del precio aquí.",
    phonePh: "(617) 555-0123",
    reviewTitle: "Esto es lo que tengo — revíselo:",
    sendChip: "Enviar solicitud",
    startOver: "Empezar de nuevo",
    sending: "Enviando…",
    inputPh: "Escriba su respuesta…",
    inputDisabled: "Toque una respuesta arriba",
    talkLabel: "🎙️ Hablar",
    talkListening: "Escuchando… toque de nuevo para parar",
    talkOffNote:
      "La voz está apagada — el teclado de su teléfono tiene una tecla de micrófono que escribe lo que usted dice. Así su voz no sale de su teléfono.",
    talkCloudOffer: "Usar la voz del navegador",
    talkCloudNote:
      "La voz del navegador envía el audio al servicio de voz de su navegador para convertirlo en texto. Solo el texto llega a nosotros — nunca recibimos ni guardamos audio.",
    talkUnsupported: "La voz no está disponible en este navegador — escriba, o use la tecla de micrófono de su teclado.",
    talkError: "La voz no captó eso — intente de nuevo, o escriba.",
    submitError: "Algo salió mal — intente de nuevo.",
    doneTitle: "✓ Solicitud recibida",
    doneSave: "Guarde su referencia — menciónela si nos llama. No hay pago ahora; verá su precio en el enlace que le enviaremos por texto, y nada avanza hasta que usted lo apruebe.",
    back: "‹ Atrás",
    shopLine: "R&R's Finest Auto Glass · 118 Terrace St, Roxbury MA · 857-266-1284"
  }
};

function glassLabel(id: string, lang: ChatLang): string {
  const opt = CHAT_GLASS_OPTIONS.find(o => o.id === id);
  return opt ? (lang === "es" ? opt.labelEs : opt.labelEn) : id;
}

/** Short vehicle line for the review summary. */
function vehicleLine(data: ChatIntakeData): string {
  if (data.vin) {
    return data.carInfo ? `${data.carInfo} (VIN ····${data.vin.slice(-4)})` : `VIN ····${data.vin.slice(-4)}`;
  }
  return `${data.year} ${data.make} ${data.model}`.trim();
}

export function ChatIntakePage() {
  const [lang, setLang] = useState<ChatLang>("en");
  const t = STRINGS[lang];
  const [step, setStep] = useState<ChatStep>("vehicle");
  const [data, setData] = useState<ChatIntakeData>(createEmptyChatData());
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 0, from: "bot", text: STRINGS.en.greeting }
  ]);
  const msgId = useRef(1);
  const [input, setInput] = useState("");
  const [vehicleMode, setVehicleMode] = useState<VehicleMode>("ask");
  const [vinInput, setVinInput] = useState("");
  const [vinError, setVinError] = useState<string | null>(null);
  const [carConfirm, setCarConfirm] = useState<{ vin: string; carInfo: string | null } | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [ymm, setYmm] = useState({ year: "", make: "", model: "" });
  const [ymmError, setYmmError] = useState<string | null>(null);
  const [addressQuery, setAddressQuery] = useState("");
  const [address, setAddress] = useState<AddressSuggestion | null>(null);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<{ file: File; url: string | null }[]>([]);
  const photosRef = useRef<{ file: File; url: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    reference: string;
    message: string;
    statusToken: string | null;
  } | null>(null);
  const [contactStage, setContactStage] = useState<"name" | "phone">("name");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Voice state — see the header comment: on-device can't be proven,
  // so Talk starts OFF. The customer may explicitly opt into the
  // labelled browser-cloud fallback.
  const voiceCap: VoiceCapability = useMemo(
    () => (typeof window === "undefined" ? "unsupported" : detectVoiceCapability(window)),
    []
  );
  const [cloudVoiceOptIn, setCloudVoiceOptIn] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);

  const say = (text: string, from: "bot" | "user" = "bot") => {
    const id = msgId.current++;
    setMessages(prev => [...prev, { id, from, text }]);
  };

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, step]);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(
    () => () => {
      for (const p of photosRef.current) if (p.url) URL.revokeObjectURL(p.url);
    },
    []
  );

  // Stop any live recognition when the page goes away.
  useEffect(
    () => () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Already stopped.
      }
    },
    []
  );

  // Address autocomplete on the address step — same debounced lookup
  // as the form, and the same typed-or-picked rule.
  useEffect(() => {
    if (step !== "address") return;
    if (address && addressQuery === address.formatted) {
      setSuggestions([]);
      return;
    }
    const q = addressQuery.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      suggestAddresses(q)
        .then(r => {
          if (!cancelled) setSuggestions(r.suggestions ?? []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [addressQuery, address, step]);

  function goTo(next: ChatStep) {
    setError(null);
    setStep(next);
  }

  function goBack() {
    const prev = previousChatStep(step);
    if (prev) goTo(prev);
  }

  function setDataField(patch: Partial<ChatIntakeData>) {
    setData(prev => ({ ...prev, ...patch }));
  }

  // --- Vehicle ---------------------------------------------------------

  /** Free NHTSA vPIC decode, in the browser — same lookup the form's
   *  sticker scan runs. Null when it can't name the car; the caller
   *  falls back to "we'll confirm the exact vehicle". */
  async function confirmVin(vin: string) {
    setLookupBusy(true);
    setVinError(null);
    let info: string | null = null;
    try {
      info = await lookupVinCarInfo(vin);
    } catch {
      info = null;
    }
    setLookupBusy(false);
    setDataField({ vin, carInfo: info });
    if (info) {
      setCarConfirm({ vin, carInfo: info });
      say(`${t.carConfirm} ${info}`);
    } else {
      setCarConfirm(null);
      say(t.vinLookupFail);
      goTo("glass");
      say(t.glassPrompt);
    }
  }

  function acceptCarConfirm(yes: boolean) {
    if (!carConfirm) return;
    if (yes) {
      say(t.yes, "user");
      setCarConfirm(null);
      goTo("glass");
      say(t.glassPrompt);
    } else {
      say(t.no, "user");
      setCarConfirm(null);
      setDataField({ vin: "", carInfo: null });
      setVinInput("");
      setVehicleMode("ask");
    }
  }

  function submitYmm() {
    const yearOk = isValidChatYear(ymm.year);
    if (!yearOk || !ymm.make.trim() || !ymm.model.trim()) {
      setYmmError(t.ymmInvalid);
      return;
    }
    setYmmError(null);
    setDataField({ year: ymm.year.trim(), make: ymm.make.trim(), model: ymm.model.trim() });
    say(`${ymm.year.trim()} ${ymm.make.trim()} ${ymm.model.trim()}`, "user");
    goTo("glass");
    say(t.glassPrompt);
  }

  function pickGlass(id: ChatIntakeData["glassType"]) {
    setDataField({ glassType: id });
    say(glassLabel(id, lang), "user");
    goTo("damage");
    say(t.damagePrompt);
  }

  // --- Damage ----------------------------------------------------------

  function addPhotos(list: FileList | File[]) {
    const { valid, problem } = validatePhotos(Array.from(list), photos.length, lang);
    setPhotoError(problem);
    if (valid.length > 0) {
      setPhotos(prev => [
        ...prev,
        ...valid.map(file => {
          let url: string | null = null;
          try {
            url = URL.createObjectURL(file);
          } catch {
            url = null;
          }
          return { file, url };
        })
      ]);
      setDataField({ photos: [...data.photos, ...valid] });
    }
  }

  function removePhoto(index: number) {
    setPhotos(prev => {
      const target = prev[index];
      if (target?.url) URL.revokeObjectURL(target.url);
      return prev.filter((_, i) => i !== index);
    });
    setDataField({ photos: data.photos.filter((_, i) => i !== index) });
    setPhotoError(null);
  }

  function answerDamage(key: "smallerThanQuarter" | "inLineOfSight" | "atEdge", value: boolean) {
    const next = { ...data, [key]: value };
    setDataField({ [key]: value });
    const verdict = damageVerdict(next);
    setDataField({ verdict });
    if (verdict !== "unknown") {
      const reason = verdictReason(verdict, next, lang);
      goTo("verdict");
      say(
        `${t.verdictIntro} ${verdict === "chip_repair" ? (lang === "es" ? "Reparar el chip" : "Chip repair") : lang === "es" ? "Reemplazo" : "Replacement"} — ${reason}`
      );
    }
  }

  // --- Pay / address / when / contact ----------------------------------

  function pickPay(path: "insurance" | "cash") {
    setDataField({ payPath: path });
    say(path === "insurance" ? t.insuranceChip : t.cashChip, "user");
    if (path === "insurance") {
      say(t.insurerPrompt);
    } else {
      goTo("address");
      say(t.addressPrompt);
    }
  }

  function pickAddress(suggestion: AddressSuggestion) {
    setAddress(suggestion);
    setAddressQuery(suggestion.formatted);
    setInput("");
    setSuggestions([]);
    setAddressError(null);
    setDataField({ addressPicked: suggestion, addressText: suggestion.formatted });
    say(suggestion.formatted, "user");
    goTo("when");
    say(t.whenPrompt);
  }

  function submitAddress(typed?: string) {
    const q = (typed ?? addressQuery).trim();
    if (!address && !q) {
      setAddressError(t.addressInvalid);
      return;
    }
    setAddressError(null);
    setDataField({ addressPicked: address, addressText: address ? address.formatted : q });
    if (!address) say(q, "user");
    setInput("");
    goTo("when");
    say(t.whenPrompt);
  }

  function submitWhen(value: string) {
    const v = value.trim();
    setDataField({ whenNeeded: v });
    say(v, "user");
    setInput("");
    goTo("contact");
    say(t.namePrompt);
  }

  function submitName(value: string) {
    if (value.trim().length < 2) {
      setError(t.nameInvalid);
      return;
    }
    setError(null);
    setDataField({ name: value.trim() });
    say(value.trim(), "user");
    setContactStage("phone");
    say(t.phonePrompt);
  }

  function submitPhone(value: string) {
    const digits = parsePhoneNumber(value);
    if (!digits) {
      setPhoneError(phoneProblem(value, lang));
      return;
    }
    setPhoneError(null);
    setDataField({ phone: value.trim() });
    say(value.trim(), "user");
    goTo("review");
    // Pass the just-entered phone in: state hasn't re-rendered yet.
    say(reviewText({ phone: value.trim() }));
  }

  function reviewText(overrides?: Partial<ChatIntakeData>): string {
    const d = { ...data, ...overrides };
    const lines = [
      t.reviewTitle,
      `• ${vehicleLine(d)}`,
      `• ${glassLabel(d.glassType, lang)}`,
      `• ${d.verdict === "chip_repair" ? (lang === "es" ? "Reparar el chip" : "Chip repair") : d.verdict === "replacement" ? (lang === "es" ? "Reemplazo" : "Replacement") : "—"}`,
      `• ${d.payPath === "insurance" ? `${t.insuranceChip}${d.insurer.trim() ? `: ${d.insurer.trim()}` : ""}` : t.cashChip}`,
      `• ${d.addressText.trim()}`,
      `• ${d.whenNeeded.trim() || "—"}`,
      `• ${d.name.trim()} · ${d.phone.trim()}`
    ];
    return lines.join("\n");
  }

  // --- Submit ----------------------------------------------------------

  async function submit() {
    const note = buildChatNote({
      inputMode: data.inputMode,
      payPath: data.payPath,
      insurer: data.insurer,
      whenNeeded: data.whenNeeded,
      verdict: data.verdict,
      verdictReason: verdictReason(data.verdict, data, lang),
      lang
    });
    const form = buildIntakeFormData(data, note);
    setBusy(true);
    setError(null);
    try {
      const res = await submitPublicIntake(form);
      setConfirmation({
        reference: res.reference,
        message: res.message,
        statusToken: res.status_token ?? null
      });
      goTo("done");
    } catch (err) {
      if (err instanceof ApiError && err.field === "service_address") {
        setAddressError(err.message);
        goTo("address");
      } else {
        setError(err instanceof Error ? err.message : t.submitError);
      }
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    try {
      recognitionRef.current?.stop();
    } catch {
      // Already stopped.
    }
    setListening(false);
    setData(createEmptyChatData());
    setMessages([{ id: msgId.current++, from: "bot", text: STRINGS[lang].greeting }]);
    setStep("vehicle");
    setVehicleMode("ask");
    setVinInput("");
    setCarConfirm(null);
    setYmm({ year: "", make: "", model: "" });
    setAddressQuery("");
    setAddress(null);
    setSuggestions([]);
    setPhotos([]);
    setContactStage("name");
    setConfirmation(null);
    setError(null);
    setInput("");
  }

  // --- Chat input + voice ----------------------------------------------

  /** What the bottom text box does depends on the step. Null = chip-only step (input disabled). */
  function handleTextSend(value: string) {
    const v = value.trim();
    if (!v) return;
    if (step === "vehicle") {
      // A VIN or a "2018 Honda Civic" typed straight into the chat.
      const vin = normalizeVin(v);
      if (vin.length === 17 && isVinShape(vin)) {
        if (!isValidVin(vin)) {
          setVinError(t.vinInvalid);
          setError(t.vinInvalid);
          return;
        }
        say(vin, "user");
        void confirmVin(vin);
        return;
      }
      const parsed = parseYearMakeModel(v);
      if (parsed && parsed.model) {
        setDataField({ year: String(parsed.year), make: parsed.make, model: parsed.model });
        say(`${parsed.year} ${parsed.make} ${parsed.model}`, "user");
        goTo("glass");
        say(t.glassPrompt);
        return;
      }
      if (parsed) {
        // Year + make, no model yet — open the YMM fields with what we have.
        setYmm({ year: String(parsed.year), make: parsed.make, model: "" });
        setVehicleMode("ymm");
        say(v, "user");
        return;
      }
      // Anything else at this step is a nudge toward the three paths.
      say(v, "user");
      return;
    }
    if (step === "pay" && data.payPath === "insurance" && !data.insurer.trim()) {
      setDataField({ insurer: v });
      say(v, "user");
      goTo("address");
      say(t.addressPrompt);
      return;
    }
    if (step === "address") {
      submitAddress(v);
      return;
    }
    if (step === "when") {
      submitWhen(v);
      return;
    }
    if (step === "contact" && contactStage === "name") {
      submitName(v);
      return;
    }
    if (step === "contact" && contactStage === "phone") {
      submitPhone(v);
      return;
    }
  }

  const textInputEnabled =
    step === "vehicle" ||
    (step === "pay" && data.payPath === "insurance" && !data.insurer.trim()) ||
    step === "address" ||
    step === "when" ||
    step === "contact";

  function toggleTalk() {
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Already stopped.
      }
      setListening(false);
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = recognitionLang(lang);
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = event => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      const text = (finalText || interimText).trim();
      if (text) {
        setInput(text);
        if (finalText) {
          // Only transcribed text goes to the intake — the audio
          // itself is never ours to keep: SpeechRecognition returns
          // text, not a recording.
          setDataField({ inputMode: "voice" });
        }
      }
    };
    rec.onerror = () => {
      setListening(false);
      setError(t.talkError);
    };
    rec.onend = () => setListening(false);
    try {
      rec.start();
      setListening(true);
      setError(null);
    } catch {
      setListening(false);
    }
  }

  const talkEnabled = cloudVoiceOptIn && voiceCap !== "unsupported";
  const range = estimateRangeFor(data.glassType, data.verdict, QUOTE_RANGES);

  // --- Confirmation ----------------------------------------------------

  if (confirmation) {
    return (
      <div className="public-wrap">
        <section className="card intake-done">
          <p className="eyebrow">R&R Finest Auto Glass</p>
          <h1>{t.doneTitle}</h1>
          <p>
            Your case reference is <strong className="intake-ref">{confirmation.reference}</strong>
          </p>
          <p className="muted">{confirmation.message}</p>
          <p className="muted">{t.doneSave}</p>
          {confirmation.statusToken && <IntakeLiveStatus statusToken={confirmation.statusToken} />}
        </section>
      </div>
    );
  }

  return (
    <div className="public-wrap">
      <div className="intake-hero">
        <p className="eyebrow">R&R Finest Auto Glass</p>
        <h1>{t.heroTitle}</h1>
        <p>{t.heroSub}</p>
        <div className="chat-lang" role="group" aria-label="Language / Idioma">
          <button
            type="button"
            className={lang === "en" ? "selected" : ""}
            aria-pressed={lang === "en"}
            onClick={() => setLang("en")}
          >
            English
          </button>
          <button
            type="button"
            className={lang === "es" ? "selected" : ""}
            aria-pressed={lang === "es"}
            onClick={() => setLang("es")}
          >
            Español
          </button>
        </div>
      </div>

      <section className="card chat-card" aria-label="Chat intake">
        <div className="chat-messages" ref={listRef}>
          {messages.map(m => (
            <div key={m.id} className={`chat-msg ${m.from === "user" ? "user" : "bot"}`}>
              <p style={{ whiteSpace: "pre-line" }}>{m.text}</p>
            </div>
          ))}

          {step === "vehicle" && vehicleMode === "ask" && (
            <div className="chat-chips">
              <button type="button" className="chat-chip" onClick={() => setVehicleMode("scan")}>
                {t.scanChip}
              </button>
              <button type="button" className="chat-chip" onClick={() => setVehicleMode("type")}>
                {t.typeVinChip}
              </button>
              <button type="button" className="chat-chip" onClick={() => setVehicleMode("ymm")}>
                {t.ymmChip}
              </button>
            </div>
          )}

          {step === "vehicle" && vehicleMode === "scan" && (
            <div className="chat-panel">
              <VinStickerScanner
                embedded
                onUseVin={v => {
                  setVehicleMode("ask");
                  say(v, "user");
                  void confirmVin(v);
                }}
              />
              <button type="button" className="intake-toggle" onClick={() => setVehicleMode("ask")}>
                {t.back}
              </button>
            </div>
          )}

          {step === "vehicle" && vehicleMode === "type" && !carConfirm && (
            <div className="chat-panel">
              <p className="muted">{t.vinPrompt}</p>
              <input
                className="intake-vin"
                type="text"
                value={vinInput}
                onChange={e => {
                  setVinInput(e.target.value.toUpperCase());
                  setVinError(null);
                }}
                placeholder="17 characters"
                autoComplete="off"
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
              {vinError && (
                <p className="error" role="alert">
                  {vinError}
                </p>
              )}
              <div className="chat-chips">
                <button
                  type="button"
                  className="primary chat-chip"
                  disabled={lookupBusy || !vinInput.trim()}
                  onClick={() => {
                    const vin = normalizeVin(vinInput);
                    if (!isVinShape(vin) || !isValidVin(vin)) {
                      setVinError(t.vinInvalid);
                      return;
                    }
                    say(vin, "user");
                    void confirmVin(vin);
                  }}
                >
                  {lookupBusy ? "…" : lang === "es" ? "Buscar" : "Look up"}
                </button>
                <button type="button" className="chat-chip" onClick={() => setVehicleMode("ask")}>
                  {t.back}
                </button>
              </div>
            </div>
          )}

          {step === "vehicle" && carConfirm && (
            <div className="chat-chips">
              <button type="button" className="primary chat-chip" onClick={() => acceptCarConfirm(true)}>
                {t.yes}
              </button>
              <button type="button" className="chat-chip" onClick={() => acceptCarConfirm(false)}>
                {t.no}
              </button>
            </div>
          )}

          {step === "vehicle" && vehicleMode === "ymm" && (
            <div className="chat-panel">
              <p className="muted">{t.ymmPrompt}</p>
              <div className="intake-ymm">
                <label>
                  {lang === "es" ? "Año" : "Year"}
                  <input
                    type="text"
                    inputMode="numeric"
                    value={ymm.year}
                    onChange={e => setYmm(prev => ({ ...prev, year: e.target.value }))}
                    placeholder={t.yearPh}
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
                <label>
                  {lang === "es" ? "Marca" : "Make"}
                  <input
                    type="text"
                    value={ymm.make}
                    onChange={e => setYmm(prev => ({ ...prev, make: e.target.value }))}
                    placeholder={t.makePh}
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
                <label>
                  {lang === "es" ? "Modelo" : "Model"}
                  <input
                    type="text"
                    value={ymm.model}
                    onChange={e => setYmm(prev => ({ ...prev, model: e.target.value }))}
                    placeholder={t.modelPh}
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
              </div>
              {ymmError && (
                <p className="error" role="alert">
                  {ymmError}
                </p>
              )}
              <p className="muted">{t.ymmHint}</p>
              <div className="chat-chips">
                <button type="button" className="primary chat-chip" onClick={submitYmm}>
                  {lang === "es" ? "Continuar" : "Continue"}
                </button>
                <button type="button" className="chat-chip" onClick={() => setVehicleMode("ask")}>
                  {t.back}
                </button>
              </div>
            </div>
          )}

          {step === "glass" && (
            <div className="chat-chips">
              {CHAT_GLASS_OPTIONS.map(o => (
                <button
                  key={o.id}
                  type="button"
                  className={"chat-chip" + (data.glassType === o.id ? " selected" : "")}
                  onClick={() => pickGlass(o.id)}
                >
                  {lang === "es" ? o.labelEs : o.labelEn}
                </button>
              ))}
            </div>
          )}

          {step === "damage" && (
            <div className="chat-panel">
              <label>
                {t.photoLabel} — {photos.length}/{CHAT_MAX_DAMAGE_PHOTOS} {t.photoCount}
                <span style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                  <label className="intake-scan-btn">
                    {t.takePhoto}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      multiple
                      hidden
                      onChange={e => {
                        addPhotos(e.target.files ?? []);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <label className="intake-scan-btn">
                    {t.choosePhoto}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={e => {
                        addPhotos(e.target.files ?? []);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </span>
              </label>
              {photoError && (
                <p className="error" role="alert">
                  {photoError}
                </p>
              )}
              {photos.length > 0 && (
                <ul className="intake-photo-list">
                  {photos.map((p, i) => (
                    <li key={`${p.file.name}-${i}`} className="intake-photo-item">
                      {p.url && <img src={p.url} alt="" className="intake-photo-thumb" />}
                      <span className="intake-photo-name">{p.file.name}</span>
                      <button
                        type="button"
                        className="intake-photo-remove"
                        aria-label={`Remove photo ${p.file.name}`}
                        onClick={() => removePhoto(i)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {(
                [
                  ["smallerThanQuarter", t.qSmaller],
                  ["inLineOfSight", t.qSight],
                  ["atEdge", t.qEdge]
                ] as const
              ).map(([key, question]) => (
                <div key={key} className="chat-question">
                  <p>{question}</p>
                  <div className="chat-chips">
                    <button
                      type="button"
                      className={"chat-chip" + (data[key] === true ? " selected" : "")}
                      onClick={() => answerDamage(key, true)}
                    >
                      {lang === "es" ? "Sí" : "Yes"}
                    </button>
                    <button
                      type="button"
                      className={"chat-chip" + (data[key] === false ? " selected" : "")}
                      onClick={() => answerDamage(key, false)}
                    >
                      {lang === "es" ? "No" : "No"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === "verdict" && (
            <div className="chat-panel">
              {range && (
                <p className="intake-recap">
                  {t.verdictRange}: {formatPriceRange(range)}
                </p>
              )}
              {!range && <p className="muted">{t.verdictNoRange}</p>}
              {data.verdict === "replacement" && data.glassType === "WINDSHIELD" && (
                <p className="muted">{t.verdictRecal}</p>
              )}
              <div className="chat-chips">
                <button type="button" className="primary chat-chip" onClick={() => { goTo("pay"); say(t.payPrompt); }}>
                  {t.verdictContinue}
                </button>
              </div>
            </div>
          )}

          {step === "pay" && data.payPath === "" && (
            <div className="chat-chips">
              <button type="button" className="chat-chip" onClick={() => pickPay("insurance")}>
                {t.insuranceChip}
              </button>
              <button type="button" className="chat-chip" onClick={() => pickPay("cash")}>
                {t.cashChip}
              </button>
            </div>
          )}

          {step === "address" && (
            <div className="chat-panel">
              {suggestions.length > 0 && (
                <ul className="intake-address-list" role="listbox" aria-label="Address suggestions">
                  {suggestions.map(s => (
                    <li key={s.place_id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected="false"
                        className="intake-address-option"
                        onClick={() => pickAddress(s)}
                      >
                        {s.formatted}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {address && <p className="intake-address-picked">✓ {address.formatted}</p>}
              {addressError && (
                <p className="error" role="alert">
                  {addressError}
                </p>
              )}
              <div className="chat-chips">
                <button type="button" className="primary chat-chip" onClick={() => submitAddress()}>
                  {t.addressUseTyped}
                </button>
              </div>
            </div>
          )}

          {step === "when" && (
            <div className="chat-chips">
              <button
                type="button"
                className="chat-chip"
                onClick={() => submitWhen(lang === "es" ? "Lo antes posible" : "As soon as possible")}
              >
                {t.asapChip}
              </button>
            </div>
          )}

          {step === "review" && (
            <div className="chat-chips">
              <button type="button" className="primary chat-chip" disabled={busy} onClick={() => void submit()}>
                {busy ? t.sending : t.sendChip}
              </button>
              <button type="button" className="chat-chip" onClick={startOver}>
                {t.startOver}
              </button>
            </div>
          )}
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {phoneError && (
          <p className="error" role="alert">
            {phoneError}
          </p>
        )}

        <div className="chat-input-row">
          <input
            type="text"
            value={input}
            disabled={!textInputEnabled || busy}
            onChange={e => {
              const value = e.target.value;
              setInput(value);
              // The address step's suggestions run off addressQuery,
              // so keep it in step with the chat box (same rule as
              // the form: typing after a pick un-picks it).
              if (step === "address") {
                setAddressQuery(value);
                if (address && value !== address.formatted) setAddress(null);
              }
            }}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleTextSend(input);
                setInput("");
              }
            }}
            placeholder={
              step === "address"
                ? t.addressPh
                : step === "contact" && contactStage === "phone"
                  ? t.phonePh
                  : step === "contact" && contactStage === "name"
                    ? t.namePh
                    : step === "pay" && data.payPath === "insurance"
                      ? t.insurerPh
                      : step === "when"
                        ? t.whenPh
                        : textInputEnabled
                          ? t.inputPh
                          : t.inputDisabled
            }
            aria-label={t.inputPh}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="primary chat-send"
            disabled={!textInputEnabled || busy || !input.trim()}
            onClick={() => {
              handleTextSend(input);
              setInput("");
            }}
          >
            {lang === "es" ? "Enviar" : "Send"}
          </button>
          <button
            type="button"
            className={"chat-talk" + (listening ? " listening" : "")}
            disabled={!talkEnabled || busy}
            onClick={toggleTalk}
            aria-pressed={listening}
          >
            {listening ? t.talkListening : t.talkLabel}
          </button>
        </div>

        <p className="muted chat-voice-note" role="status">
          {voiceCap === "unsupported"
            ? t.talkUnsupported
            : !cloudVoiceOptIn
              ? t.talkOffNote
              : t.talkCloudNote}
          {voiceCap === "cant-verify" && !cloudVoiceOptIn && (
            <>
              {" "}
              <button type="button" className="intake-toggle" onClick={() => setCloudVoiceOptIn(true)}>
                {t.talkCloudOffer}
              </button>
            </>
          )}
        </p>

        <div className="intake-nav">
          {step !== "vehicle" && step !== "done" ? (
            <button type="button" className="intake-back" onClick={goBack}>
              {t.back}
            </button>
          ) : (
            <span />
          )}
          <small className="muted">{t.shopLine}</small>
        </div>
      </section>
    </div>
  );
}
