/**
 * mygrant-browser: headless Chromium service for MyGrant web automation.
 *
 * The Case Core API (Vercel) calls this service over HTTP instead of making
 * raw fetch() calls to MyGrant — MyGrant serves empty results to datacenter
 * HTTP clients but works fine in a real browser.
 *
 * Design: this service is DUMB. It drives a real Chromium page as the
 * logged-in user and returns raw rendered HTML. All parsing (vehicles,
 * parts, pricing) and all business logic (cheapest-in-stock-wins, spend
 * caps, audit) stays in the Case Core API.
 *
 * Auth: callers must present `Authorization: Bearer <SERVICE_SECRET>`.
 * MyGrant credentials come from MYGRANT_USERNAME / MYGRANT_PASSWORD env
 * (Fly.io secrets, set by the shop owner).
 */
import express from "express";
import { MyGrantBrowser } from "./browser";

const PORT = Number(process.env.PORT ?? 8080);
const SERVICE_SECRET = process.env.SERVICE_SECRET ?? "";

if (!SERVICE_SECRET) {
  console.warn(
    "WARNING: SERVICE_SECRET is not set — the service will reject all requests."
  );
}

const mg = new MyGrantBrowser();
const app = express();
app.use(express.json({ limit: "256kb" }));

// Simple bearer-token auth for service-to-service calls.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.header("authorization") ?? "";
  if (!SERVICE_SECRET || auth !== `Bearer ${SERVICE_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

app.get("/health", async (_req, res) => {
  res.json({ ok: true, service: "mygrant-browser" });
});

/**
 * POST /v1/fetch { url }
 * Navigate to a MyGrant URL as the logged-in user; return rendered HTML.
 * The URL must be on www.mygrantglass.com (SSRF guard).
 */
app.post("/v1/fetch", async (req, res) => {
  try {
    const { url } = req.body ?? {};
    if (typeof url !== "string" || !url.startsWith("https://www.mygrantglass.com/")) {
      res.status(400).json({ error: "url must be an https://www.mygrantglass.com/ URL" });
      return;
    }
    const { html, finalUrl } = await mg.fetchPage(url);
    res.json({ html, finalUrl, bytes: html.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fetch failed:", message);
    res.status(502).json({ error: message });
  }
});

async function main() {
  await mg.launch();
  console.log("Chromium launched");
  // Warm the login at startup so the first real request is fast.
  try {
    await mg.ensureLoggedIn();
    console.log("MyGrant login OK at startup");
  } catch (err) {
    console.error(
      "Startup MyGrant login failed (will retry on first request):",
      err instanceof Error ? err.message : err
    );
  }
  app.listen(PORT, () => console.log(`mygrant-browser listening on :${PORT}`));
}

process.on("SIGTERM", async () => {
  await mg.close();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
