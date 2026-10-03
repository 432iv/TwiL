"use strict";
/* Full API regression suite on a disposable embedded PostgreSQL database,
   followed by a close/reopen persistence check. This never touches .env DB. */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "yousef-perfumes-offline-"));
Object.assign(process.env, {
  DB_MODE: "pglite",
  DB_DATA_DIR: path.join(testDir, "database"),
  SESSION_SECRET: "offline-test-session-secret-not-for-production-123456789",
  OFFLINE_MODE: "1",
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "0"
});

const backend = require("../server/index");
const db = require("../server/db");
let runtime = null;

function runApiSuite(base) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "api.test.js")], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, BASE: base },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`API regression suite exited with ${signal || code}`));
    });
  });
}

async function main() {
  try {
    runtime = await backend.start({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${runtime.port}`;

    const health = await fetch(base + "/api/health").then(res => res.json());
    assert.equal(health.db, "pglite");
    assert.equal(health.offline, true);
    console.log("✓ Embedded PGlite backend starts without DATABASE_URL");

    const google = await fetch(base + "/api/auth/google");
    assert.equal(google.status, 503);
    assert.equal((await google.json()).error, "offline_google_unavailable");
    assert.equal(google.headers.get("location"), null);
    console.log("✓ Google OAuth is blocked locally; no external redirect is attempted");

    await runApiSuite(base);
    const before = await db.query(`
      SELECT (SELECT count(*)::int FROM products) AS products,
             (SELECT count(*)::int FROM invoices) AS invoices,
             (SELECT count(*)::int FROM users) AS users`);
    assert.ok(before.rows[0].products > 0, "API suite should leave restored products in the local database");
    assert.ok(before.rows[0].invoices > 0, "API suite should leave invoices in the local database");
    assert.equal(before.rows[0].users, 1);

    await runtime.close();
    runtime = null;
    console.log("✓ Backend closed cleanly; local PGlite database was flushed");

    runtime = await backend.start({ host: "127.0.0.1", port: 0 });
    const after = await db.query(`
      SELECT (SELECT count(*)::int FROM products) AS products,
             (SELECT count(*)::int FROM invoices) AS invoices,
             (SELECT count(*)::int FROM users) AS users`);
    assert.deepEqual(after.rows[0], before.rows[0]);
    const status = await fetch(`http://127.0.0.1:${runtime.port}/api/auth/status`).then(res => res.json());
    assert.equal(status.setupRequired, false);
    console.log(`✓ Data survived backend restart (${after.rows[0].products} products, ${after.rows[0].invoices} invoices, account retained)`);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error("\nOffline test failed:", err.stack || err.message);
  process.exitCode = 1;
});
