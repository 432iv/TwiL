"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/cashbox — الصندوق
   الرصيد النقدي الحالي + المقبوضات والمدفوعات + مبيعات نقد/بطاقة
   + المصروفات والمشتريات + الإيداعات والسحوبات + حركة الصندوق
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, toMoney } = require("../lib/http");
const { mapCashMove } = require("../lib/map");

const router = express.Router();
const r2 = ledger.r2;

/* ملخص الصندوق: رصيد + إجماليات (اليوم المفتوح أو فترة) */
router.get("/", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.dayId) { params.push(req.query.dayId); where.push(`m.day_id = $${params.length}`); }
  else if (req.query.from || req.query.to) {
    if (req.query.from) { params.push(req.query.from); where.push(`m.moved_at >= $${params.length}::timestamptz`); }
    if (req.query.to)   { params.push(req.query.to + " 23:59:59"); where.push(`m.moved_at <= $${params.length}::timestamptz`); }
  }
  const scope = where.length ? "WHERE " + where.join(" AND ") : "";

  const [balance, cardTotal, sums, moves, openDay] = await Promise.all([
    ledger.cashBalance(),
    db.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS t
                FROM cash_movements WHERE method = 'card'`),
    db.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0)                                    AS total_in,
        COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0)                                   AS total_out,
        COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND method = 'cash'), 0)            AS sales_cash,
        COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND method = 'card'), 0)            AS sales_card,
        COALESCE(SUM(amount) FILTER (WHERE category = 'refund'), 0)                                 AS refunds,
        COALESCE(SUM(amount) FILTER (WHERE category = 'expense'), 0)                                AS expenses,
        COALESCE(SUM(amount) FILTER (WHERE category = 'purchase'), 0)                               AS purchases,
        COALESCE(SUM(amount) FILTER (WHERE category = 'deposit'), 0)                                AS deposits,
        COALESCE(SUM(amount) FILTER (WHERE category = 'withdrawal'), 0)                             AS withdrawals
       FROM cash_movements m ${scope}`, params),
    db.query(`SELECT m.* FROM cash_movements m ${scope}
               ORDER BY m.moved_at DESC, m.id DESC LIMIT 400`, params),
    ledger.getOpenDay()
  ]);

  const s = sums.rows[0];
  res.json({
    balance: r2(balance),
    cardTotal: r2(cardTotal.rows[0].t),
    openDay: openDay ? { id: String(openDay.id), date: openDay.day_date, status: openDay.status } : null,
    totals: {
      in: r2(s.total_in), out: r2(s.total_out),
      salesCash: r2(s.sales_cash), salesCard: r2(s.sales_card), refunds: r2(s.refunds),
      expenses: r2(s.expenses), purchases: r2(s.purchases),
      deposits: r2(s.deposits), withdrawals: r2(s.withdrawals)
    },
    movements: moves.rows.map(mapCashMove)
  });
}));

/* ───────────── إيداع ───────────── */
router.post("/deposit", wrap(async (req, res) => {
  const move = await db.tx(async client => {
    const day = await ledger.requireOpenDay(client);
    const amount = toMoney(req.body.amount, { field: "amount", max: 1000000 });
    if (amount <= 0) throw new HttpError(400, "amount_invalid", "المبلغ يجب أن يكون أكبر من صفر");
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : null;
    return ledger.recordCashMove(client, {
      dayId: day.id, direction: "in", method: "cash", category: "deposit",
      amount, description: "إيداع نقدي" + (note ? ": " + note : ""), refType: "manual"
    });
  });
  res.status(201).json({ movement: mapCashMove(move) });
}));

/* ───────────── سحب ───────────── */
router.post("/withdraw", wrap(async (req, res) => {
  const move = await db.tx(async client => {
    const day = await ledger.requireOpenDay(client);
    const amount = toMoney(req.body.amount, { field: "amount", max: 1000000 });
    if (amount <= 0) throw new HttpError(400, "amount_invalid", "المبلغ يجب أن يكون أكبر من صفر");
    const balance = await ledger.cashBalance(client);
    if (amount > balance) throw new HttpError(400, "insufficient_cash", "رصيد الصندوق النقدي " + balance + " غير كافٍ");
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : null;
    return ledger.recordCashMove(client, {
      dayId: day.id, direction: "out", method: "cash", category: "withdrawal",
      amount, description: "سحب نقدي" + (note ? ": " + note : ""), refType: "manual"
    });
  });
  res.status(201).json({ movement: mapCashMove(move) });
}));

/* حذف حركة يدوية (إيداع/سحب) — يومها مفتوح فقط */
router.delete("/movements/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const { rows } = await client.query("SELECT * FROM cash_movements WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) throw new HttpError(404, "movement_not_found", "الحركة غير موجودة");
    const mv = rows[0];
    if (!["deposit", "withdrawal"].includes(mv.category) || mv.ref_type !== "manual") {
      throw new HttpError(409, "movement_locked", "لا يمكن حذف حركة مرتبطة بعملية — عدّل العملية نفسها");
    }
    if (mv.day_id) await ledger.assertDayOpen(mv.day_id, client);
    await client.query("DELETE FROM cash_movements WHERE id = $1", [mv.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
