import { useEffect, useState } from "react";
import { postJobLocation } from "./api";

/**
 * Tech location sharing — Slice C (brief §3.4).
 *
 * While a job is IN_PROGRESS, the tech's device reports its position
 * to the API every LOCATION_PING_INTERVAL_MS. Sharing exists ONLY
 * inside that window: the sharer starts when the job goes active and
 * stops the moment it finishes (or the view unmounts). The server is
 * the real gate — it rejects pings for inactive jobs and for techs
 * whose location-sharing consent is off — but the client stops
 * promptly on its own when the server reports a permanent refusal
 * (consent) or the device denies permission, rather than retrying a
 * hopeless report every interval.
 *
 * 45s is the battery-sane middle of the brief's 30–60s window: fresh
 * enough for a useful ops map and client ETA, light enough to run a
 * whole shift.
 */
export const LOCATION_PING_INTERVAL_MS = 45_000;

export interface LocationSharerHandle {
  stop: () => void;
}

interface LocationSharerOptions {
  jobId: string;
  /** Injectable for tests; defaults to the real API call. */
  post?: (
    jobId: string,
    input: { lat: number; lon: number; accuracy_m?: number }
  ) => Promise<unknown>;
  /** Injectable for tests; defaults to navigator.geolocation. */
  geolocation?: Geolocation | null;
  intervalMs?: number;
  /** Fires on each successful report (and clears transient errors). */
  onPing?: () => void;
  /**
   * Fires when a report fails. `terminal` means sharing has stopped
   * (no geolocation, permission denied, consent refused server-side);
   * non-terminal errors are informational and sharing continues.
   */
  onError?: (message: string, terminal: boolean) => void;
}

export function startLocationSharing(
  options: LocationSharerOptions
): LocationSharerHandle {
  const post = options.post ?? postJobLocation;
  const geo =
    options.geolocation !== undefined
      ? options.geolocation
      : typeof navigator !== "undefined"
        ? (navigator.geolocation ?? null)
        : null;
  const intervalMs = options.intervalMs ?? LOCATION_PING_INTERVAL_MS;

  if (!geo) {
    options.onError?.("Location is not available on this device.", true);
    return { stop: () => undefined };
  }

  let stopped = false;
  // Declared before `report` runs: a terminal error can stop the
  // sharer synchronously inside the very first report, before the
  // interval exists.
  let timer: number | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) window.clearInterval(timer);
  };

  const report = () => {
    if (stopped) return;
    geo.getCurrentPosition(
      position => {
        if (stopped) return;
        const { latitude, longitude, accuracy } = position.coords;
        post(options.jobId, {
          lat: latitude,
          lon: longitude,
          accuracy_m: accuracy ?? undefined
        }).then(
          () => {
            if (!stopped) options.onPing?.();
          },
          (error: unknown) => {
            if (stopped) return;
            const message =
              error instanceof Error ? error.message : "Location report failed.";
            // A consent refusal is permanent until the tech changes
            // their profile — stop instead of hammering the API.
            if (/consent/i.test(message)) {
              options.onError?.(message, true);
              stop();
            } else {
              options.onError?.(message, false);
            }
          }
        );
      },
      error => {
        if (stopped) return;
        if (error.code === error.PERMISSION_DENIED) {
          options.onError?.(
            "Location permission is off — R&R can't follow this job's progress until it's allowed.",
            true
          );
          stop();
        } else {
          options.onError?.("Couldn't get your location just now.", false);
        }
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 }
    );
  };

  report();
  timer = window.setInterval(report, intervalMs);
  return { stop };
}

/**
 * React binding: sharing runs exactly while `active` (the job is
 * IN_PROGRESS) and a jobId is present. Returns what the tech sees —
 * whether sharing is live, and the latest problem if there is one.
 */
export function useJobLocationSharing(
  jobId: string | null,
  active: boolean
): { sharing: boolean; error: string | null } {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId || !active) {
      setSharing(false);
      return;
    }
    setError(null);
    setSharing(true);
    const handle = startLocationSharing({
      jobId,
      onPing: () => setError(null),
      onError: (message, terminal) => {
        setError(message);
        if (terminal) setSharing(false);
      }
    });
    return () => {
      handle.stop();
      setSharing(false);
    };
  }, [jobId, active]);

  return { sharing, error };
}
