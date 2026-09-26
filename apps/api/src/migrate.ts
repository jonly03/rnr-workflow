import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../migrations");
const pool = createPool();

await pool.query(`
  create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )
`);

for (const name of fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()) {
  const prior = await pool.query("select 1 from schema_migrations where name = $1", [name]);
  if (prior.rowCount) continue;

  const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into schema_migrations(name) values ($1)", [name]);
    await client.query("commit");
    console.log(`Applied migration: ${name}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();
