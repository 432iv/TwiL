"use strict";
/* Environment configuration — production desktop mode never needs a remote DB. */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const databaseMode = String(process.env.DB_MODE || "postgres").toLowerCase();
if (!(["postgres", "pglite"].includes(databaseMode))) {
  console.error(`[config] Unsupported DB_MODE: ${databaseMode} (use postgres or pglite)`);
  process.exit(1);
}

const config = {
  databaseMode,
  databaseUrl: databaseMode === "postgres" ? required("DATABASE_URL") : null,
  databaseDir: databaseMode === "pglite"
    ? path.resolve(process.env.DB_DATA_DIR || path.join(__dirname, "..", "data", "pglite"))
    : null,
  sessionSecret: required("SESSION_SECRET"),
  port: Number.parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "0.0.0.0",
  sessionTtlDays: Number.parseInt(process.env.SESSION_TTL_DAYS || "30", 10),
  bcryptRounds: Number.parseInt(process.env.BCRYPT_ROUNDS || "12", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  offlineMode: process.env.OFFLINE_MODE === "1" || databaseMode === "pglite",
  ssl: (process.env.PGSSLMODE || "disable") === "require" ? { rejectUnauthorized: false } : false
};

if (config.sessionSecret.length < 24) {
  console.error("[config] SESSION_SECRET is too short — use at least 24 random characters.");
  process.exit(1);
}
if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
  console.error("[config] PORT must be an integer between 0 and 65535.");
  process.exit(1);
}

module.exports = config;
