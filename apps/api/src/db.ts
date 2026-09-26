import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL storage.");

  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const sslDisabled = process.env.DATABASE_SSL_MODE === "disable";

  return new Pool({
    connectionString,
    ssl: local || sslDisabled ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });
}
