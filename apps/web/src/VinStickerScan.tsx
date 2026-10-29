import { useEffect, useRef, useState } from "react";
import { decodeStickerCode, extractVinFromStickerText, isValidVin } from "./vin-scan";
import { DoorJambGraphic, StickerGraphic } from "./vin-scan-graphics";

/**
 * "Scan the door sticker" — client-facing VIN capture on intake card 1,
 * ported from the standalone prototype Nelly approved (2026-10-29,
 * including its two instruction graphics).
 *
 * The flow mirrors the staff photo-OCR candidate exactly: a decode only
 * PROPOSES a VIN; the customer checks it against the sticker and taps
 * "Use this VIN" before anything fills the form — a scan never submits
 * or auto-advances the intake. Decoding is fully on-device (see
 * vin-scan.ts): camera frames and the sticker photo are decoded in
 * memory and discarded, never uploaded or attached to the request.
 * A decoded candidate whose ISO 3779 check digit fails is rejected
 * with an explanation instead of being offered — a misread character
 * must not sail into the form dressed as a successful scan.
 */
export function VinStickerScanner({
  onUseVin
}: {
  /** Fill the intake's VIN field with a confirmed decode (vin-scan's isValidVin is the same gate typed VINs play by). */
  onUseVin: (vin: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(false);

  function stopCamera() {
    scanningRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setCameraOn(false);
  }

  // Never leave the camera running after the panel or page goes away.
  useEffect(() => {
    const stream = streamRef;
    const scanning = scanningRef;
    return () => {
      scanning.current = false;
      if (stream.current) {
        stream.current.getTracks().forEach(t => t.stop());
        stream.current = null;
      }
    };
  }, []);

  function handleDecodedText(text: string, format: string) {
    const vin = extractVinFromStickerText(text);
    if (!vin) {
      setCandidate(null);
      setStatus(
        `That ${format || "code"} doesn't contain a VIN. Point the camera at the barcode or QR code on the door sticker.`
      );
      return;
    }
    if (!isValidVin(vin)) {
      // The extract guarantees the shape, so a failure here is the
      // check digit: a character was misread. Say so, offer no
      // candidate — retry or typing beats a quietly wrong VIN.
      setCandidate(null);
      setStatus(
        `We read ${vin}, but it didn't pass the VIN check — a character was probably misread. Try scanning again, or type the VIN in the box above.`
      );
      return;
    }
    setStatus(null);
    setCandidate(vin);
    try {
      navigator.vibrate?.(120);
    } catch {
      // Vibration is a nicety, never a blocker.
    }
  }

  async function startCamera() {
    setStatus(null);
    setCandidate(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera isn't available here — use a photo of the sticker instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });
    } catch {
      setStatus("Camera isn't available here — use a photo of the sticker instead.");
      return;
    }
    streamRef.current = stream;
    scanningRef.current = true;
    setCameraOn(true);
    setStatus("Scanning… point at the door-sticker barcode or QR code.");
  }

  // Frame loop while the camera is live: grab a frame every ~250ms and
  // try a quiet decode; the first hit stops the camera and proposes.
  useEffect(() => {
    if (!cameraOn) return;
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    void video.play().catch(() => {});
    let cancelled = false;
    let timer = 0;
    const canvas = document.createElement("canvas");
    const tick = async () => {
      if (cancelled || !scanningRef.current) return;
      if (video.readyState === 4 && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          const blob = await new Promise<Blob | null>(res =>
            canvas.toBlob(res, "image/jpeg", 0.85)
          );
          if (blob && !cancelled && scanningRef.current) {
            let hit: { text: string; format: string } | null = null;
            try {
              hit = await decodeStickerCode(blob);
            } catch {
              // A failed frame is expected while aiming — keep trying.
            }
            if (hit && !cancelled && scanningRef.current) {
              stopCamera();
              handleDecodedText(hit.text, hit.format);
              return;
            }
          }
        }
      }
      if (!cancelled && scanningRef.current) {
        timer = window.setTimeout(tick, 250);
      }
    };
    timer = window.setTimeout(tick, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // handleDecodedText/stopCamera are stable enough across renders for
    // a camera loop keyed on cameraOn alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same photo again re-fires change.
    e.target.value = "";
    if (!file) return;
    setDecoding(true);
    setCandidate(null);
    setStatus("Reading the sticker photo…");
    try {
      const hit = await decodeStickerCode(file);
      if (!hit) {
        setStatus(
          "No barcode or QR code found in that photo. Get closer, fill the frame with just the code, and avoid glare — or type the VIN above."
        );
      } else {
        handleDecodedText(hit.text, hit.format);
      }
    } catch {
      setStatus("Couldn't read that photo. Try again, or type the VIN in the box above.");
    } finally {
      setDecoding(false);
    }
  }

  function closePanel() {
    stopCamera();
    setOpen(false);
    setCandidate(null);
    setStatus(null);
  }

  if (!open) {
    return (
      <div className="vin-scan-entry">
        <button type="button" className="intake-scan-btn" onClick={() => setOpen(true)}>
          🚗 Scan the door sticker
        </button>
        <p className="muted" style={{ marginTop: 6 }}>
          Newer cars print the VIN as a barcode or QR code on the driver&rsquo;s
          door sticker — scan it instead of typing.
        </p>
      </div>
    );
  }

  return (
    <div className="vin-scan-panel">
      <div className="vin-scan-head">
        <strong>Scan the door sticker</strong>
        <button type="button" className="vin-scan-close" onClick={closePanel}>
          Type it instead
        </button>
      </div>

      <div className="vin-scan-steps">
        <div className="vin-scan-step">
          <h3>1 · Open the driver&rsquo;s door</h3>
          <DoorJambGraphic />
          <p>
            The sticker is on the <b>frame the door closes against</b> — the
            door jamb. You can only see it with the door open, roughly where
            the door latch is.
          </p>
        </div>
        <div className="vin-scan-step">
          <h3>2 · Find the VIN sticker</h3>
          <StickerGraphic />
          <p>
            Look for the VIN line. Most cars print a <b>barcode</b> under it;
            newer cars add a <b>QR code</b>. Either one scans.
          </p>
        </div>
      </div>

      <video
        ref={videoRef}
        className="vin-scan-video"
        playsInline
        muted
        style={{ display: cameraOn ? "block" : "none" }}
      />
      {cameraOn && (
        <p className="vin-scan-hint">
          Hold the barcode or QR code inside the frame, about 6–10 inches
          away. Give it a second to focus.
        </p>
      )}

      <div className="vin-scan-actions">
        {cameraOn ? (
          <button type="button" onClick={stopCamera}>
            Stop camera
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void startCamera()}>
            📷 Start camera scan
          </button>
        )}
        <label className="intake-scan-btn vin-scan-photo">
          🖼️ Use a photo of the sticker
          <input type="file" accept="image/*" hidden onChange={e => void handlePhoto(e)} />
        </label>
      </div>

      {status && (
        <p className="vin-scan-status" role="status" aria-live="polite">
          {decoding ? "Reading… " : ""}
          {status}
        </p>
      )}

      {candidate && (
        <div className="card vin-scan-candidate">
          <p style={{ margin: "0 0 0.5rem" }}>
            Found VIN:{" "}
            <strong style={{ fontFamily: "ui-monospace, monospace" }}>{candidate}</strong>
          </p>
          <p className="muted" style={{ margin: "0 0 0.5rem" }}>
            Check it matches the sticker before continuing.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setCandidate(null)}>
              Retake
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                stopCamera();
                setCandidate(null);
                setOpen(false);
                onUseVin(candidate);
              }}
            >
              Use this VIN
            </button>
          </div>
        </div>
      )}

      <p className="vin-scan-fine">
        The scan happens on your phone — no photo is uploaded or saved.
      </p>
    </div>
  );
}
