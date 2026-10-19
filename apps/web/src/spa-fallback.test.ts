import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard (2026-10-19): customer links (/quote/<token>,
 * /track/<token>) are ALWAYS opened by direct navigation — a text message
 * tap, not an in-app click. Without SPA fallback rewrites in vercel.json,
 * Vercel returns its own 404 page and the app never loads. This test pins
 * the rewrites so the config can't silently lose them again.
 */
describe("vercel.json SPA fallback for customer links", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(
    fs.readFileSync(path.resolve(here, "../vercel.json"), "utf8")
  ) as { rewrites: { source: string; destination: string }[] };

  it("rewrites /quote/* and /track/* to the SPA entry", () => {
    expect(config.rewrites).toContainEqual({
      source: "/quote/:path*",
      destination: "/index.html"
    });
    expect(config.rewrites).toContainEqual({
      source: "/track/:path*",
      destination: "/index.html"
    });
  });

  it("keeps the API proxy rewrite first", () => {
    expect(config.rewrites[0]).toEqual({
      source: "/api/v1/:path*",
      destination: "/api/proxy?path=:path*"
    });
  });
});
