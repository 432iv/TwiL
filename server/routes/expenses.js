"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/expenses — المصروفات
   كل مصروف: تسجيل + خصم من الصندوق + دخوله في صافي الربح والتقارير
   الأنواع: إيجار/كهرباء/إنترنت/نقل/صيانة/أخرى
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, toMoney } = require("../lib/http");
const { mapExpense } = require("../lib/map");

const router = express.Router();

const CATEGORIES = ["rent", "electricity", "internet", "transport", "maintenance", "other"];
function validCategory(raw) {
  const c = String(raw || "").trim();
  if (!CATEGORIES.includes(c)) throw new HttpError(400, "category_invalid", "نوع مصروف غير معروف");
  return c;
}

async function loadExpense(id, client) {
  const q = client || db;
  const { rows } = await q.query("SELECT * FROM expenses WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "expense_not_found", "Expense not found");
  return rows[0];
}

/* ───────────── سجل المصروفات ───────────── */
router.get("/", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.date)     { params.push(req.query.date);     where.push(`e.expense_date = $${params.length}`); }
  if (req.query.dayId)    { params.push(req.query.dayId);    where.push(`e.day_id = $${params.length}`); }
  if (req.query.category) { params.push(req.query.category); where.push(`e.category = $${params.length}`); }
  if (req.query.from)     { params.push(req.query.from);     where.push(`e.expense_date >= $${params.length}`); }
  if (req.query.to)       { params.push(req.query.to);       where.push(`e.expense_date <= $${params.length}`); }
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT e.* FROM expenses e ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`, params);
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  res.json({ expenses: rows.map(mapExpense), total: Math.round(total * 100) / 100 });
}));

/* ───────────── إضافة مصروف ───────────── */
router.post("/", wrap(async (req, res) => {
  const expense = await db.tx(async client => {
    const day = req.body.dayId
      ? await ledger.assertDayOpen(req.body.dayId, client)
      : await ledger.requireOpenDay(client);
    const category = validCategory(req.body.category);
    const amount = toMoney(req.body.amount, { field: "amount", max: 1000000 });
    if (amount <= 0) throw new HttpError(400, "amount_invalid", "المبلغ يجب أن يكون أكبر من صفر");
    const notes = req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 300, required: false }) : null;

    const { rows } = await client.query(
      `INSERT INTO expenses (day_id, category, amount, expense_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [day.id, category, amount, day.day_date, notes]);
    const exp = rows[0];
    await ledger.recordCashMove(client, {
      dayId: day.id, direction: "out", method: "cash", category: "expense",
      amount, description: "مصروف: " + notes, refType: "expense", refId: exp.id
    });
    return exp;
  });
  res.status(201).json({ expense: mapExpense(expense) });
}));

/* ───────────── تعديل مصروف (يوم مفتوح فقط) ───────────── */
router.put("/:id(\\d+)", wrap(async (req, res) => {
  const expense = await db.tx(async client => {
    const exp = await loadExpense(req.params.id, client);
    await ledger.assertDayOpen(exp.day_id, client);
    const category = req.body.category !== undefined ? validCategory(req.body.category) : exp.category;
    const amount = req.body.amount !== undefined ? toMoney(req.body.amount, { field: "amount", max: 1000000 }) : Number(exp.amount);
    if (amount <= 0) throw new HttpError(400, "amount_invalid", "المبلغ يجب أن يكون أكبر من صفر");
    const notes = req.body.notes !== undefined
      ? (req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 300, required: false }) : null)
      : exp.notes;
    const { rows } = await client.query(
      `UPDATE expenses SET category=$1, amount=$2, notes=$3, updated_at=now() WHERE id=$4 RETURNING *`,
      [category, amount, notes, exp.id]);
    /* إعادة بناء حركة الصندوق المرتبطة */
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'expense' AND ref_id = $1", [exp.id]);
    await ledger.recordCashMove(client, {
      dayId: exp.day_id, direction: "out", method: "cash", category: "expense",
      amount, description: "مصروف: " + notes, refType: "expense", refId: exp.id
    });
    return rows[0];
  });
  res.json({ expense: mapExpense(expense) });
}));

/* ───────────── حذف مصروف ───────────── */
router.delete("/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const exp = await loadExpense(req.params.id, client);
    await ledger.assertDayOpen(exp.day_id, client);
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'expense' AND ref_id = $1", [exp.id]);
    await client.query("DELETE FROM expenses WHERE id = $1", [exp.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
