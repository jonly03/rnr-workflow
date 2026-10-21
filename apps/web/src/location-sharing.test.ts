import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCATION_PING_INTERVAL_MS,
  startLocationSharing
} from "./location-sharing";

const COORDS = { latitude: 42.373611, longitude: -71.109722, accuracy: 12 };

function fakeGeoSuccess() {
  return {
    getCurrentPosition: vi.fn((success: PositionCallback) => {
      success({
        coords: {
          ...COORDS,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null
        },
        timestamp: Date.now()
      } as unknown as GeolocationPosition);
    })
  } as unknown as Geolocation;
}

function fakeGeoDenied() {
  return {
    getCurrentPosition: vi.fn(
      (_success: PositionCallback, error?: PositionErrorCallback) => {
        error?.({
          code: 1,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
          message: "denied"
        } as unknown as GeolocationPositionError);
      }
    )
  } as unknown as Geolocation;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startLocationSharing (Slice C)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports immediately, then on the interval, until stopped", async () => {
    const post = vi.fn(async () => ({}));
    const handle = startLocationSharing({
      jobId: "job-1",
      post,
      geolocation: fakeGeoSuccess(),
      intervalMs: 1000
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("job-1", {
      lat: COORDS.latitude,
      lon: COORDS.longitude,
      accuracy_m: COORDS.accuracy
    });

    vi.advanceTimersByTime(3000);
    expect(post).toHaveBeenCalledTimes(4);

    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("uses the brief's 30–60s cadence by default", () => {
    expect(LOCATION_PING_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(LOCATION_PING_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it("reports a terminal error and never posts when geolocation is unavailable", () => {
    const post = vi.fn(async () => ({}));
    const onError = vi.fn();
    startLocationSharing({ jobId: "job-1", post, geolocation: null, onError });
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/not available/i), true);
    expect(post).not.toHaveBeenCalled();
  });

  it("stops for good when the device denies location permission", () => {
    const post = vi.fn(async () => ({}));
    const onError = vi.fn();
    startLocationSharing({
      jobId: "job-1",
      post,
      geolocation: fakeGeoDenied(),
      onError,
      intervalMs: 1000
    });
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/permission/i), true);
    vi.advanceTimersByTime(5000);
    expect(post).not.toHaveBeenCalled();
  });

  it("stops when the server refuses for consent — and not for a transient failure", async () => {
    // Consent refusal: permanent, so sharing stops after one attempt.
    const consentPost = vi.fn(async () => {
      throw new Error("Location sharing is off for this technician (consent required).");
    });
    const onError = vi.fn();
    startLocationSharing({
      jobId: "job-1",
      post: consentPost,
      geolocation: fakeGeoSuccess(),
      onError,
      intervalMs: 1000
    });
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/consent/i), true);
    vi.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(consentPost).toHaveBeenCalledTimes(1);

    // A transient failure is reported as non-terminal; sharing continues.
    let calls = 0;
    const flakyPost = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Network hiccup");
      return {};
    });
    const onError2 = vi.fn();
    const handle = startLocationSharing({
      jobId: "job-2",
      post: flakyPost,
      geolocation: fakeGeoSuccess(),
      onError: onError2,
      intervalMs: 1000
    });
    await flushMicrotasks();
    expect(onError2).toHaveBeenCalledWith("Network hiccup", false);
    vi.advanceTimersByTime(2000);
    expect(flakyPost.mock.calls.length).toBeGreaterThanOrEqual(3);
    handle.stop();
  });
});
