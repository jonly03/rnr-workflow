import { createApp } from "./app.js";
import { ensureSeedAdmin } from "./auth.js";
import { createStore } from "./store-factory.js";

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
const app = createApp(store, { authSecret });

async function boot() {
  try {
    await ensureSeedAdmin(store);
  } catch (error) {
    console.error("Staff admin seed failed (will retry on next boot):", error);
  }
  app.listen(port, () => {
    console.log(`R&R Case Core API listening on http://localhost:${port}`);
  });
}

void boot();
