import { createApp } from "./app.js";
import { ensureSeedAdmin } from "./auth.js";
import { createRealtimeServer } from "./realtime.js";
import { createStore } from "./store-factory.js";
import { mountBrainGateway } from "./gateway.js";
import { createGlassCatalogProvider, createSourcingProvider } from "./mygrant.js";
import { loadPricingConfig } from "./pricing.js";
import { loadQuotingConfig } from "./quoting.js";

const port = Number(process.env.PORT || 3001);

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
const server = createRealtimeServer(app, store, authSecret);

async function boot() {
  try {
    await ensureSeedAdmin(store);
  } catch (error) {
    console.error("Staff admin seed failed (will retry on next boot):", error);
  }
  server.listen(port, () => {
    console.log(`R&R Case Core API listening on http://localhost:${port}`);
  });
}

void boot();
