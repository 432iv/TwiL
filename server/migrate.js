"use strict";
/* Migration runner: applies server/migrations/*.sql once each, in order.
   Supports both the existing pg pool and the embedded desktop database. */
const fs = require("fs");
const path = require("path");
const db = require("./db");

const DIR = path.join(__dirname, "migrations");

async function migrate() {
  await db.initialize();
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set((await db.query("SELECT filename FROM schema_migrations")).rows.map(r => r.filename));
  const files = fs.readdirSync(DIR).filter(file => file.endsWith(".sql")).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    try {
      await db.tx(async client => {
        await client.exec(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      });
      console.log(`  + ${file} applied`);
      count++;
    } catch (err) {
      console.error(`  ! ${file} FAILED: ${err.message}`);
      throw err;
    }
  }

  console.log(count ? `\nMigrations complete (${count} new).` : "\nDatabase already up to date.");
  return count;
}

if (require.main === module) {
  migrate()
    .then(() => db.close())
    .catch(async err => {
      console.error(err);
      await db.close().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { migrate };
