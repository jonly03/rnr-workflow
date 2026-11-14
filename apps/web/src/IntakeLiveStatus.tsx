/**
 * Live progress on the intake confirmation page: polls the client-safe
 * status projection behind the customer's status token and narrates
 * what's happening behind the scenes (identifying → pricing → quote).
 * The page is COMPLETE when the quote exists: it mints the sign link
 * itself and hands it over as a button — the customer never has to wait
 * for a text or a staff click. Signing is what books the job in (the
 * staff flow then starts at Order parts).
 *
 * Moved here verbatim from App.tsx (Layer 1, 2026-11-14) so the
 * talking intake (/chat) can reuse the same component without a
 * circular import back into the staff app — behavior unchanged.
 */

import { useEffect, useRef, useState } from "react";
import {
  createIntakeQuoteLink,
  getPublicIntakeStatus,
  type PublicIntakeStatus
} from "./api";

const INTAKE_STATUS_POLL_MS = 4000;
const INTAKE_TERMINAL_PHASES = ["approved", "declined", "expired"];

export function IntakeLiveStatus({ statusToken }: { statusToken: string }) {
  const [status, setStatus] = useState<PublicIntakeStatus | null>(null);
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const mintingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      let terminal = false;
      try {
        const s = await getPublicIntakeStatus(statusToken);
        if (!cancelled && s && typeof s.phase === "string" && Array.isArray(s.steps)) {
          setStatus(s);
          terminal = INTAKE_TERMINAL_PHASES.includes(s.phase);
        }
      } catch {
        // A failed poll is never the customer's problem: keep waiting.
      }
      if (!cancelled && !terminal) {
        timer = window.setTimeout(poll, INTAKE_STATUS_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [statusToken]);

  // Once the quote is ready, mint its sign link (once) and show it.
  useEffect(() => {
    if (status?.quote_ready && !signUrl && !mintingRef.current) {
      mintingRef.current = true;
      createIntakeQuoteLink(statusToken)
        .then(link => setSignUrl(`${window.location.origin}${link.path}`))
        .catch(() => {
          // Let a later poll retry the mint.
          mintingRef.current = false;
        });
    }
  }, [status?.quote_ready, signUrl, statusToken]);

  const steps: PublicIntakeStatus["steps"] = status?.steps ?? [
    { key: "received", label: "Request received", done: true },
    { key: "glass", label: "Identifying your glass", done: false },
    { key: "pricing", label: "Pricing your job", done: false },
    { key: "quote", label: "Quote ready to sign", done: false }
  ];

  return (
    <div className="intake-live">
      <h2>What&rsquo;s happening with your request</h2>
      {status?.headline && <p aria-live="polite">{status.headline}</p>}
      <ul className="intake-steps">
        {steps.map(s => (
          <li key={s.key} className={s.done ? "done" : "pending"}>
            <span aria-hidden="true">{s.done ? "✓" : "•"}</span> {s.label}
          </li>
        ))}
      </ul>
      {signUrl && status?.phase === "quote_ready" && (
        <>
          <p>
            <a className="primary intake-sign-btn" href={signUrl}>
              Review &amp; sign your quote
            </a>
          </p>
          <small>
            Signing approves your quote — that&rsquo;s what books your job
            in. No payment is due when you sign.
          </small>
        </>
      )}
      {status?.phase === "approved" && (
        <p>✓ Approved — thank you! We&rsquo;ll text you to schedule your service.</p>
      )}
    </div>
  );
}
