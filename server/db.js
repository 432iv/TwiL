"use strict";
/*
 * Database adapter. The hosted/web mode retains the existing pg pool.
 * Desktop mode embeds PostgreSQL through PGlite and writes its data directory
 * on the local disk; all routes continue to use the same query()/tx() API.
 */
const pg = require("pg");
const config = require("./config");

// Preserve the historical pg type conversions in server mode.
pg.types.setTypeParser(1700, value => (value === null ? null : parseFloat(value))); // numeric
pg.types.setTypeParser(20, value => (value === null ? null : parseInt(value, 10))); // int8
pg.types.setTypeParser(1082, value => value); // date -> YYYY-MM-DD

let pool = null;
let embedded = null;
let embeddedOpening = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.ssl,
      max: 10,
      idleTimeoutMillis: 30000
    });
    pool.on("error", err => console.error("[db] idle client error:", err.message));
  }
  return pool;
}

async function getEmbedded() {
  if (embedded) return embedded;
  if (!embeddedOpening) {
    embeddedOpening = (async () => {
      const fs = require("fs");
      fs.mkdirSync(config.databaseDir, { recursive: true });
      const { PGlite } = require("@electric-sql/pglite");
      const instance = await PGlite.create(config.databaseDir);
      embedded = instance;
      return instance;
    })().catch(err => {
      embeddedOpening = null;
      throw err;
    });
  }
  return embeddedOpening;
}

function normalizeEmbeddedResult(result) {
  // PGlite.exec() returns one result per statement; pg.query() returns one.
  const value = Array.isArray(result) ? result[result.length - 1] : result;
  if (!value) return { rows: [], rowCount: 0, affectedRows: 0 };
  if (value.rowCount == null) {
    value.rowCount = Number(value.affectedRows == null ? (value.rows || []).length : value.affectedRows);
  }
  return value;
}

async function embeddedQuery(client, text, params) {
  if (Array.isArray(params) && params.length) {
    return normalizeEmbeddedResult(await client.query(text, params));
  }
  // exec supports both a single unparameterized statement and migration batches.
  return normalizeEmbeddedResult(await client.exec(text));
}

async function initialize() {
  if (config.databaseMode === "pglite") {
    await getEmbedded();
    return;
  }
  // Creating the Pool is synchronous; SELECT 1 in the caller verifies connectivity.
  getPool();
}

async function query(text, params) {
  if (config.databaseMode === "pglite") {
    const instance = await getEmbedded();
    return embeddedQuery(instance, text, params);
  }
  return getPool().query(text, params);
}

async function exec(text) {
  if (config.databaseMode === "pglite") {
    const instance = await getEmbedded();
    return instance.exec(text);
  }
  return getPool().query(text);
}

/* Run a set of statements inside one transaction. */
async function tx(fn) {
  if (config.databaseMode === "pglite") {
    const instance = await getEmbedded();
    return instance.transaction(async transaction => fn({
      query: (text, params) => embeddedQuery(transaction, text, params),
      exec: text => transaction.exec(text),
      release() {}
    }));
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn({
      query: (text, params) => client.query(text, params),
      exec: text => client.query(text),
      release() {}
    });
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (config.databaseMode === "pglite") {
    const pending = embeddedOpening;
    if (pending) await pending.catch(() => {});
    const instance = embedded;
    embedded = null;
    embeddedOpening = null;
    if (instance) await instance.close();
    return;
  }
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

module.exports = { initialize, query, exec, tx, close };
