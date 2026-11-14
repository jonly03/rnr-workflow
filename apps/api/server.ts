import express from "express";
import { createApp } from "./src/app.js";
import { createStore } from "./src/store-factory.js";
import { mountBrainGateway } from "./src/gateway.js";
import { createGlassCatalogProvider, createSourcingProvider } from "./src/mygrant.js";
import { loadPricingConfig } from "./src/pricing.js";
import { loadQuotingConfig } from "./src/quoting.js";

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
// One set of providers/configs shared by the API and the Brain Gateway,
// so the door and the app see the same store, catalog, sourcing, and pricing.
const glassCatalog = createGlassCatalogProvider();
const sourcingProvider = createSourcingProvider();
const pricingConfig = loadPricingConfig();
const quotingConfig = loadQuotingConfig();
const app = createApp(
  store,
  { authSecret },
  {},
  { glassCatalog, sourcingProvider, pricingConfig, quotingConfig }
);
mountBrainGateway(app, { store, glassCatalog, sourcingProvider, pricingConfig, quotingConfig });


export default app;
