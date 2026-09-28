import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser-native speech recognition for VIN dictation (Web Speech API).
 * Free, no API keys — audio is processed by the browser vendor's service.
 * Feature-detect with isVoiceInputSupported(); when false (e.g. Firefox),
 * the UI should not offer the mic at all.
 */

interface SpeechRecognitionResultItem {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionResultItem;
  length: number;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike> & { length: number };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : null;
}

export function isVoiceInputSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export type VoiceStatus = "idle" | "listening";

function friendlyError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone is blocked. Allow microphone access for this site, or type the VIN instead.";
    case "no-speech":
      return "Didn't catch that — try speaking a little closer to the mic, one character at a time.";
    case "audio-capture":
      return "No microphone found on this device. You can type the VIN instead.";
    case "network":
      return "The speech service is unreachable. Check your connection, or type the VIN instead.";
    case "aborted":
      return "";
    default:
      return "Voice input didn't work this time — you can type the VIN instead.";
  }
}

export interface VinVoice {
  supported: boolean;
  status: VoiceStatus;
  /** Live interim transcript while listening. */
  interim: string;
  error: string;
  start: () => void;
  stop: () => void;
  clearError: () => void;
}

/**
 * Manages one dictation session. Calls onFinal with the final transcript;
 * the caller normalizes and validates it (see vin-voice.ts).
 */
export function useVinVoice(onFinal: (transcript: string) => void): VinVoice {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    // A previous session that hasn't fully ended yet must not linger.
    recRef.current?.abort();
    recRef.current = null;

    setError("");
    setInterim("");
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false; // one utterance per tap — the user controls pacing
    rec.maxAlternatives = 1;
    rec.onresult = event => {
      let interimText = "";
      let finalText = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += text;
        else interimText += text;
      }
      setInterim(interimText);
      if (finalText) onFinalRef.current(finalText);
    };
    rec.onerror = event => {
      const message = friendlyError(event.error);
      if (message) setError(message);
      setStatus("idle");
    };
    rec.onend = () => {
      setStatus("idle");
      recRef.current = null;
    };
    recRef.current = rec;
    setStatus("listening");
    try {
      rec.start();
    } catch {
      // start() throws if called without a user gesture or while starting;
      // the button click is the gesture, so this is a rare edge.
      setStatus("idle");
      recRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => setError(""), []);

  useEffect(
    () => () => {
      recRef.current?.abort();
      recRef.current = null;
    },
    []
  );

  return {
    supported: isVoiceInputSupported(),
    status,
    interim,
    error,
    start,
    stop,
    clearError
  };
}
