import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";
import { PgCaseStore } from "./pg-store.js";
import { JsonCaseStore, type CaseStore } from "./store.js";

export function createStore(): CaseStore {
  if (process.env.DATABASE_URL) {
    return new PgCaseStore(createPool());
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataFile = process.env.CASE_STORE_FILE || path.resolve(here, "../data/cases.json");
  return new JsonCaseStore(dataFile);
}
