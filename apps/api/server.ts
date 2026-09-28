import express from "express";
import { createApp } from "./src/app.js";
import { ensureSeedAdmin } from "./src/auth.js";
import { createStore } from "./src/store-factory.js";

// Keep the framework import in the Vercel entrypoint so Express is detected
// as the app runtime. The app factory owns middleware and routes.
void express;

let authSecret = process.env.AUTH_SECRET;
if (!authSecret) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production.");
  }
  authSecret = "dev-secret-change-me";
  console.warn(
    "WARNING: AUTH_SECRET is not set; using an insecure development default. " +
      "Set AUTH_SECRET before deploying anywhere shared."
  );
}

const store = createStore();
const app = createApp(store, { authSecret });

// Seed the staff admin on cold start. No-op when already seeded or when the
// seed credentials are not configured.
void ensureSeedAdmin(store).catch(error => {
  console.error("Staff admin seed failed (will retry on next cold start):", error);
});

export default app;
