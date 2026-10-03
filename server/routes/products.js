"use strict";
/* /api/products — remembered product NAMES for autocomplete.
   This is not inventory: no quantity, no stock, no price is kept here. */
const express = require("express");
const db = require("../db");
const { wrap, cleanText } = require("../lib/http");
const { normalizeName, rankNames } = require("../lib/names");

const router = express.Router();

/* Insert-or-touch a name inside an existing transaction/client and
   return the canonical spelling, so the ledger stays consistent. */
async function rememberName(client, rawName) {
  const name = String(rawName || "").replace(/\s+/g, " ").trim();
  const normalized = normalizeName(name);
  if (!normalized) return name;
  const { rows } = await client.query(
    `INSERT INTO product_names (name, normalized_name, usage_count, last_used_at)
          VALUES ($1, $2, 1, now())
     ON CONFLICT (normalized_name) DO UPDATE
          SET usage_count = product_names.usage_count + 1,
              last_used_at = now()
     RETURNING name`,
    [name, normalized]);
  return rows[0].name;            // the spelling stored the first time wins
}

/* autocomplete: /api/products?q=جوا&limit=8 — narrows with every character */
router.get("/", wrap(async (req, res) => {
  const q = String(req.query.q || "");
  const limit = Math.min(parseInt(req.query.limit || "8", 10) || 8, 25);
  const normalized = normalizeName(q);

  let rows;
  if (!normalized) {
    rows = (await db.query(
      `SELECT name, normalized_name, usage_count, last_used_at FROM product_names
        ORDER BY usage_count DESC, last_used_at DESC LIMIT $1`, [limit])).rows;
  } else {
    /* every typed word must appear somewhere; the exact ordering is
       decided by the shared ranking helper */
    const tokens = normalized.split(" ").filter(Boolean);
    const conds = tokens.map((_, i) => `normalized_name LIKE $${i + 1}`).join(" AND ");
    rows = (await db.query(
      `SELECT name, normalized_name, usage_count, last_used_at FROM product_names
        WHERE ${conds} ORDER BY usage_count DESC, last_used_at DESC LIMIT 200`,
      tokens.map(t => "%" + t + "%"))).rows;
  }
  res.json({ query: q, suggestions: rankNames(rows, q, limit) });
}));

/* the full list (used once at boot as a cache for instant first keystroke) */
router.get("/all", wrap(async (_req, res) => {
  const { rows } = await db.query(
    "SELECT name FROM product_names ORDER BY usage_count DESC, last_used_at DESC LIMIT 2000");
  res.json({ names: rows.map(r => r.name) });
}));

/* save a name explicitly (the sale endpoints already do this themselves) */
router.post("/", wrap(async (req, res) => {
  const name = cleanText(req.body.name, { field: "name", max: 80 });
  const canonical = await db.tx(client => rememberName(client, name));
  res.status(201).json({ name: canonical });
}));

module.exports = router;
module.exports.rememberName = rememberName;
