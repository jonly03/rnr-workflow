import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { JsonCaseStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.CASE_STORE_FILE || path.resolve(here, "../data/cases.json");
const port = Number(process.env.PORT || 3001);

const store = new JsonCaseStore(dataFile);
createApp(store).listen(port, () => {
  console.log(`R&R Case Core API listening on http://localhost:${port}`);
});
