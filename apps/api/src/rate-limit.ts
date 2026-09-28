import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  /** Sliding window size in milliseconds. */
  windowMs: number;
  /** Max allowed attempts per key within the window. */
  max: number;
  /** Derives the bucket key from the request. Defaults to client IP. */
  key?: (req: Request) => string;
}

/**
 * Dependency-free sliding-window rate limiter.
 *
 * This is a per-process speed bump, not a distributed guarantee: on serverless
 * each instance tracks its own counters. Proportionate for a staff login
 * endpoint; revisit with a shared store if brute force becomes a real threat.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  const keyOf = options.key ?? ((req: Request) => req.ip ?? "unknown");

  // Prune idle buckets opportunistically so the map cannot grow without bound.
  let lastPrune = Date.now();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - lastPrune > options.windowMs) {
      lastPrune = now;
      const cutoff = now - options.windowMs;
      for (const [k, timestamps] of hits) {
        const fresh = timestamps.filter((t) => t > cutoff);
        if (fresh.length === 0) hits.delete(k);
        else hits.set(k, fresh);
      }
    }

    const key = keyOf(req);
    const cutoff = now - options.windowMs;
    const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= options.max) {
      const retryAfterMs = timestamps[0] + options.windowMs - now;
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many attempts. Please wait and try again."
        }
      });
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    return next();
  };
}
