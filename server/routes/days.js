"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/days — اليومية
   يوم واحد مفتوح في كل مرة؛ الإغلاق يحفظ لقطة ثابتة للأرقام
   (مبيعات/أرباح/مصروفات/مشتريات/صندوق/صافي) لا تتغير بعدها.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, isoDate, cleanText, dayNameFor } = require("../lib/http");
const { mapDay, mapNote, mapInvoice } = require("../lib/map");

const router = express.Router();

async function dayById(id, client) {
  const q = client || db;
  const { rows } = await q.query("SELECT * FROM days WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "day_not_found", "Day not found");
  return rows[0];
}

/* كل الأيام مع إجمالياتها (لقطة ثابتة للأيام المغلقة) */
router.get("/", wrap(async (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = "";
  if (status === "open" || status === "closed") { params.push(status); where = "WHERE d.status = $1"; }
  const { rows } = await db.query(
    `SELECT * FROM days d ${where} ORDER BY d.day_date DESC`, params);

  /* إجماليات كل الأيام دفعة واحدة (بدل استعلام لكل يوم) */
  const summaries = await ledger.daySummariesForApi(rows.map(r => r.id));
  const days = rows.map(r => {
    const sum = summaries.get(String(r.id));
    const totals = sum ? sum.totals : ledger.zeroTotals();
    return Object.assign(mapDay(r), {
      totals,
      cashBalanceAtClose: sum ? sum.cashBalanceAtClose : null,
      frozen: sum ? sum.frozen : false,
      netProfit: totals.netProfit
    });
  });
  res.json({
    days,
    sessions: days,                     /* توافق مع الواجهة السابقة */
    reports: days.filter(d => d.status === "closed")
  });
}));

/* اليوم المفتوح الحالي */
router.get("/current", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM days WHERE status = 'open' LIMIT 1");
  if (!rows.length) return res.json({ day: null, totals: null });
  const { totals } = await ledger.daySummaryForApi(rows[0].id);
  res.json({
    day: mapDay(rows[0]),
    totals: {
      total: totals.total, cost: totals.cost, profit: totals.profit, count: totals.count,
      cash: totals.cash, card: totals.card, unpaid: totals.unpaid, byMethod: totals.byMethod,
      purchases: totals.purchases, expenses: totals.expenses, cashFlow: totals.cashFlow,
      saleTypes: totals.saleTypes,
      netProfit: totals.netProfit
    }
  });
}));

/* فتح يوم جديد */
router.post("/", wrap(async (req, res) => {
  const date = req.body.date ? isoDate(req.body.date) : new Date().toISOString().slice(0, 10);
  const dayName = req.body.dayName ? cleanText(req.body.dayName, { field: "dayName", max: 40 }) : dayNameFor(date);

  const open = await db.query("SELECT id FROM days WHERE status = 'open'");
  if (open.rows.length) throw new HttpError(409, "day_already_open", "A day is already open");

  const existing = await db.query("SELECT id, status FROM days WHERE day_date = $1", [date]);
  if (existing.rows.length) {
    throw new HttpError(409, "day_exists", "That date already has a ledger day");
  }
  const { rows } = await db.query(
    `INSERT INTO days (day_date, day_name) VALUES ($1,$2) RETURNING *`, [date, dayName]);
  res.status(201).json({ day: mapDay(rows[0]) });
}));

/* تفاصيل يوم: فواتير + ملاحظات + إجماليات (تعمل للمغلق والمفتوح) */
router.get("/:id(\\d+)", wrap(async (req, res) => {
  const day = await dayById(req.params.id);
  const [summary, invoices, notes, purchases, expenses, cashMoves, returns] = await Promise.all([
    ledger.daySummaryForApi(day.id),
    db.query("SELECT * FROM invoices WHERE day_id = $1 ORDER BY sale_time DESC, id DESC", [day.id]),
    db.query("SELECT * FROM notes WHERE day_id = $1 ORDER BY note_time DESC, id DESC", [day.id]),
    db.query(`SELECT p.*, (SELECT count(*) FROM purchase_items x WHERE x.purchase_id = p.id) AS items_count
                FROM purchases p WHERE p.day_id = $1 ORDER BY p.created_at DESC`, [day.id]),
    db.query("SELECT * FROM expenses WHERE day_id = $1 ORDER BY created_at DESC", [day.id]),
    db.query("SELECT * FROM cash_movements WHERE day_id = $1 ORDER BY moved_at DESC, id DESC", [day.id]),
    db.query("SELECT * FROM sale_returns WHERE day_id = $1 ORDER BY returned_at DESC", [day.id])
  ]);
  const itemRows = invoices.rows.length ? await db.query(
    "SELECT * FROM invoice_items WHERE invoice_id = ANY($1::bigint[]) ORDER BY id",
    [invoices.rows.map(r => r.id)]) : { rows: [] };
  const byInv = new Map();
  for (const it of itemRows.rows) {
    if (!byInv.has(String(it.invoice_id))) byInv.set(String(it.invoice_id), []);
    byInv.get(String(it.invoice_id)).push(it);
  }
  res.json({
    day: mapDay(day),
    totals: summary.totals,
    cashBalanceAtClose: summary.cashBalanceAtClose,
    frozen: summary.frozen,
    sales: invoices.rows.map(r => mapInvoice(r, byInv.get(String(r.id)) || [])),
    notes: notes.rows.map(mapNote),
    purchases: purchases.rows.map(r => ({
      id: String(r.id), purchaseNo: r.purchase_no, total: Number(r.total), paid: r.paid,
      status: r.status, itemsCount: Number(r.items_count), notes: r.notes,
      time: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
    })),
    expenses: expenses.rows.map(r => ({
      id: String(r.id), category: r.category, amount: Number(r.amount),
      notes: r.notes, time: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
    })),
    cashMovements: cashMoves.rows.map(r => ({
      id: String(r.id), direction: r.direction, method: r.method, category: r.category,
      amount: Number(r.amount), description: r.description,
      time: r.moved_at instanceof Date ? r.moved_at.toISOString() : r.moved_at
    })),
    returns: returns.rows.map(r => ({
      id: String(r.id), invoiceId: String(r.invoice_id), qty: r.qty, amount: Number(r.amount),
      reason: r.reason, time: r.returned_at instanceof Date ? r.returned_at.toISOString() : r.returned_at
    }))
  });
}));

/* إغلاق اليوم — يخزن لقطة نهائية */
router.post("/:id(\\d+)/close", wrap(async (req, res) => {
  const out = await db.tx(async client => {
    const day = await dayById(req.params.id, client);
    if (day.status === "closed") throw new HttpError(409, "day_already_closed", "Day is already closed");
    const { rows } = await client.query(
      `UPDATE days SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING *`, [day.id]);
    if (!rows.length) throw new HttpError(409, "day_already_closed", "Day is already closed");

    const snapshot = await ledger.buildDaySnapshot(day.id, client);
    await client.query(
      `INSERT INTO day_summaries (day_id, snapshot, cash_balance)
       VALUES ($1,$2,$3)
       ON CONFLICT (day_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, cash_balance = EXCLUDED.cash_balance`,
      [day.id, JSON.stringify(snapshot), snapshot.cashBalanceAtClose]);
    return { day: rows[0], snapshot };
  });

  res.json({
    day: mapDay(out.day),
    totals: out.snapshot.totals,
    cashBalanceAtClose: out.snapshot.cashBalanceAtClose,
    noteCount: out.snapshot.totals.noteCount,
    report: {
      id: "rep-" + String(out.day.id), sessionId: String(out.day.id),
      dayName: out.day.day_name, date: out.day.day_date,
      closedAt: out.day.closed_at, totals: out.snapshot.totals
    }
  });
}));

/* إعادة فتح يوم مغلق — مسموح فقط إن لم يكن هناك يوم مفتوح آخر.
   اللقطة الثابتة تُحذف (ستُبنى من جديد عند الإغلاق التالي) وتبقى كل العمليات كما هي. */
router.post("/:id(\\d+)/reopen", wrap(async (req, res) => {
  const day = await db.tx(async client => {
    const d = (await client.query("SELECT * FROM days WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!d) throw new HttpError(404, "day_not_found", "Day not found");
    if (d.status === "open") throw new HttpError(409, "day_already_open", "اليوم مفتوح بالفعل");
    const other = await client.query("SELECT id FROM days WHERE status = 'open' AND id <> $1", [d.id]);
    if (other.rows.length) {
      throw new HttpError(409, "day_already_open", "يوجد يوم مفتوح آخر — أغلقه أولاً ثم أعد فتح هذا اليوم");
    }
    await client.query("DELETE FROM day_summaries WHERE day_id = $1", [d.id]);
    const { rows } = await client.query(
      "UPDATE days SET status = 'open', closed_at = NULL WHERE id = $1 RETURNING *", [d.id]);
    return rows[0];
  });
  const { totals } = await ledger.daySummaryForApi(day.id);
  res.json({ day: mapDay(day), totals });
}));

/* حذف يوم — مرفوض إذا احتوى عمليات مرتبطة بالمخزون والصندوق */
router.delete("/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const day = await dayById(req.params.id, client);
    const used = await client.query(
      `SELECT (SELECT count(*) FROM invoices  WHERE day_id = $1) AS invoices,
              (SELECT count(*) FROM purchases WHERE day_id = $1) AS purchases,
              (SELECT count(*) FROM expenses WHERE day_id = $1) AS expenses,
              (SELECT count(*) FROM cash_movements WHERE day_id = $1) AS cash,
              (SELECT count(*) FROM sale_returns WHERE day_id = $1) AS returns,
              (SELECT count(*) FROM open_operations WHERE day_id = $1) AS opens,
              (SELECT count(*) FROM vial_movements WHERE day_id = $1) AS vials`, [day.id]);
    const u = used.rows[0];
    if (Number(u.invoices) || Number(u.purchases) || Number(u.expenses) || Number(u.cash) || Number(u.returns)
        || Number(u.opens) || Number(u.vials)) {
      throw new HttpError(409, "day_has_data",
        "لا يمكن حذف يوم يحتوي عمليات مرتبطة بالمخزون والصندوق — احذف عملياته أولاً");
    }
    await client.query("DELETE FROM notes WHERE day_id = $1", [day.id]);
    await client.query("DELETE FROM stock_movements WHERE day_id = $1", [day.id]);
    await client.query("DELETE FROM days WHERE id = $1", [day.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
