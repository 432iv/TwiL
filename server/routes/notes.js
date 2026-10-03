"use strict";
/* /api/notes — daily notes. They are records, never money in a total. */
const express = require("express");
const db = require("../db");
const { wrap, HttpError, cleanText, isoDate } = require("../lib/http");
const { mapNote } = require("../lib/map");

const router = express.Router();

/* ?dayId= | ?date= | nothing = every note, newest first */
router.get("/", wrap(async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.dayId)     { params.push(req.query.dayId);         where = "WHERE day_id = $1"; }
  else if (req.query.date) { params.push(isoDate(req.query.date)); where = "WHERE note_date = $1"; }
  const { rows } = await db.query(
    `SELECT * FROM notes ${where} ORDER BY note_time DESC, id DESC`, params);
  res.json({ notes: rows.map(mapNote) });
}));

/* add a note to the open day (or to an explicit open day) */
router.post("/", wrap(async (req, res) => {
  const text = cleanText(req.body.text ?? req.body.note_text, { field: "note", max: 500 });

  const dayQuery = req.body.dayId
    ? await db.query("SELECT * FROM days WHERE id = $1", [req.body.dayId])
    : await db.query("SELECT * FROM days WHERE status = 'open'");
  if (!dayQuery.rows.length) throw new HttpError(409, "no_open_day", "Start a day first");
  const day = dayQuery.rows[0];
  if (day.status !== "open") throw new HttpError(409, "day_closed", "This day is closed");

  const { rows } = await db.query(
    `INSERT INTO notes (day_id, note_text, note_date) VALUES ($1,$2,$3) RETURNING *`,
    [day.id, text, day.day_date]);
  res.status(201).json({ note: mapNote(rows[0]) });
}));

/* delete — only while the owning day is open */
router.delete("/:id", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT n.id, d.status FROM notes n JOIN days d ON d.id = n.day_id WHERE n.id = $1`, [req.params.id]);
  if (!rows.length) throw new HttpError(404, "note_not_found", "Note not found");
  if (rows[0].status !== "open") throw new HttpError(409, "day_closed", "This day is closed");
  await db.query("DELETE FROM notes WHERE id = $1", [req.params.id]);
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
