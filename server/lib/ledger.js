"use strict";
/* ═══════════════════════════════════════════════════════════════════
   يوسف للعطور — منطق الدفتر المشترك
   كل الأقسام (مبيعات/مشتريات/مصروفات/صندوق/تقارير) تمر من هنا
   حتى تبقى الأرقام متطابقة في كل مكان.
   ═══════════════════════════════════════════════════════════════════ */
const db = require("../db");
const { HttpError } = require("./http");

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

/* صافي القيم الفعلية للفاتورة (بعد المرتجعات) */
function invoiceEffective(inv) {
  const refunded = Number(inv.refunded || 0);
  const refundedProfit = Number(inv.refunded_profit || 0);
  return {
    total:  r2(Number(inv.total) - refunded),
    cost:   r2(Number(inv.cost_total) - (refunded - refundedProfit)),
    profit: r2(Number(inv.profit) - refundedProfit)
  };
}

/* ───────────── اليوم المفتوح ───────────── */
async function getOpenDay(client) {
  const q = client || db;
  const { rows } = await q.query("SELECT * FROM days WHERE status = 'open' LIMIT 1");
  return rows.length ? rows[0] : null;
}
async function requireOpenDay(client) {
  const day = await getOpenDay(client);
  if (!day) throw new HttpError(409, "no_open_day", "Start a day first");
  return day;
}
async function dayById(id, client) {
  const q = client || db;
  const { rows } = await q.query("SELECT * FROM days WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "day_not_found", "Day not found");
  return rows[0];
}
/* يرفض الكتابة على يوم مغلق */
async function assertDayOpen(dayId, client) {
  const day = await dayById(dayId, client);
  if (day.status !== "open") throw new HttpError(409, "day_closed", "This day is closed");
  return day;
}

/* ───────────── حركة الصندوق ───────────── */
async function recordCashMove(client, move) {
  const { rows } = await client.query(
    `INSERT INTO cash_movements (day_id, direction, method, category, amount, description, ref_type, ref_id, moved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()))
     RETURNING *`,
    [move.dayId, move.direction, move.method || null, move.category,
     move.amount, move.description || null, move.refType || null,
     move.refId || null, move.movedAt || null]);
  return rows[0];
}
/* حركة عكسية (عكس اتجاه ومبلغ حركة سابقة) */
async function reverseCashMove(client, mv, description) {
  return recordCashMove(client, {
    dayId:     mv.day_id,
    direction: mv.direction === "in" ? "out" : "in",
    method:    mv.method,
    category:  mv.category,
    amount:    mv.amount,
    description: description || ("عكس: " + (mv.description || "")),
    refType:   mv.ref_type,
    refId:     mv.ref_id
  });
}
/* الرصيد النقدي = كل داخل نقدي − كل خارج نقدي (حركات البطاقة لا تدخل الصندوق) */
const CASH_BALANCE_SQL = `
  SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS balance
    FROM cash_movements
   WHERE method IS NULL OR method = 'cash'`;
async function cashBalance(client) {
  const q = client || db;
  const { rows } = await q.query(CASH_BALANCE_SQL);
  return r2(rows[0].balance);
}

/* ───────────── حركة المخزون ─────────────
   stockKind = 'sealed' (قطع مغلقة: qtyIn/qtyOut)  |  'open' (مل: mlIn/mlOut) */
async function recordStockMove(client, m) {
  const { rows } = await client.query(
    `INSERT INTO stock_movements
       (product_id, qty_in, qty_out, stock_kind, ml_in, ml_out, reason, ref_type, ref_id, note, day_id, moved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now()))
     RETURNING *`,
    [m.productId, m.qtyIn || 0, m.qtyOut || 0, m.stockKind || "sealed",
     r2(m.mlIn || 0), r2(m.mlOut || 0), m.reason, m.refType || null,
     m.refId || null, m.note || null, m.dayId || null, m.movedAt || null]);
  return rows[0];
}

/* حركة مخزون عبوات التقسيم */
async function recordVialMove(client, m) {
  const { rows } = await client.query(
    `INSERT INTO vial_movements (vial_id, qty_in, qty_out, reason, ref_type, ref_id, note, day_id, moved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()))
     RETURNING *`,
    [m.vialId, m.qtyIn || 0, m.qtyOut || 0, m.reason, m.refType || null,
     m.refId || null, m.note || null, m.dayId || null, m.movedAt || null]);
  return rows[0];
}

/* ───────────── تفصيل المبيعات: مغلق / تقسيم ─────────────
   أرقام البنود قبل خصم الفاتورة وبعد خصم المرتجعات. تُرجع Map: dayId -> { sealed, split } */
const emptyKind = () => ({ total: 0, cost: 0, profit: 0, count: 0, ml: 0 });
async function saleTypeBreakdownByDay(dayIds, client) {
  const q = client || db;
  const out = new Map();
  const ids = (dayIds || []).map(String);
  if (!ids.length) return out;
  const { rows } = await q.query(
    `SELECT i.day_id, ii.sale_type,
            COALESCE(SUM(ii.line_total - COALESCE(r.amt,0)), 0)                            AS total,
            COALESCE(SUM(ii.line_cost  - (COALESCE(r.amt,0) - COALESCE(r.pa,0))), 0)       AS cost,
            COUNT(ii.id) FILTER (WHERE ii.qty_returned < ii.qty)                           AS count,
            COALESCE(SUM(ii.ml_qty) FILTER (WHERE ii.qty_returned < ii.qty), 0)            AS ml
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id AND i.status <> 'cancelled'
       LEFT JOIN (SELECT item_id, SUM(amount) AS amt, SUM(profit_adjust) AS pa
                    FROM sale_returns GROUP BY item_id) r ON r.item_id = ii.id
      WHERE i.day_id = ANY($1::bigint[])
      GROUP BY i.day_id, ii.sale_type`, [ids]);
  for (const id of ids) out.set(id, { sealed: emptyKind(), split: emptyKind() });
  for (const row of rows) {
    const o = out.get(String(row.day_id));
    const k = row.sale_type === "split" ? o.split : o.sealed;
    k.total = r2(row.total); k.cost = r2(row.cost); k.profit = r2(row.total - row.cost);
    k.count = Number(row.count); k.ml = r2(row.ml);
  }
  return out;
}

/* ───────────── إجماليات اليوم (مبيعات فعالة + مشتريات + مصروفات + صندوق) ───────────── */
const DAY_SALES_TOTALS = `
  SELECT
    COALESCE(SUM(i.total - i.refunded), 0)                                            AS total,
    COALESCE(SUM(i.cost_total - (i.refunded - i.refunded_profit)), 0)                 AS cost,
    COALESCE(SUM(i.profit - i.refunded_profit), 0)                                    AS profit,
    COUNT(i.id)                                                                       AS count,
    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'cash'), 0)  AS cash,
    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'card'), 0)  AS card,
    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'unpaid'),0) AS unpaid,
    (SELECT COALESCE(jsonb_object_agg(x.pm, x.amt), '{}'::jsonb)
       FROM (SELECT i2.payment_method AS pm, SUM(i2.total - i2.refunded) AS amt
               FROM invoices i2 WHERE i2.day_id = d.id AND i2.status <> 'cancelled'
              GROUP BY 1) x)                                                          AS by_method
   FROM days d
   LEFT JOIN invoices i ON i.day_id = d.id AND i.status <> 'cancelled'`;

async function dayTotals(dayId, client) {
  const q = client || db;
  const [sales, purchases, expenses, cash, notesCount, returnsCount] = await Promise.all([
    q.query(DAY_SALES_TOTALS + " WHERE d.id = $1 GROUP BY d.id", [dayId]),
    q.query(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(total) FILTER (WHERE paid),0) AS paid_total, count(*) AS count
               FROM purchases WHERE day_id = $1 AND status = 'completed'`, [dayId]),
    q.query(`SELECT COALESCE(SUM(cat_total),0) AS total, COALESCE(SUM(n),0) AS count,
                    COALESCE(jsonb_object_agg(category, cat_total), '{}'::jsonb) AS by_category
               FROM (SELECT category, SUM(amount) AS cat_total, count(*) AS n
                       FROM expenses WHERE day_id = $1 GROUP BY 1) t`, [dayId]),
    q.query(`SELECT
                COALESCE(SUM(amount) FILTER (WHERE direction = 'in'  AND (method IS NULL OR method = 'cash')), 0) AS cash_in,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'out' AND (method IS NULL OR method = 'cash')), 0) AS cash_out,
                COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND direction = 'in'), 0)  AS sales_cash_in,
                COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND method = 'card'), 0)   AS sales_card,
                COALESCE(SUM(amount) FILTER (WHERE category = 'refund'), 0)                        AS refunds,
                COALESCE(SUM(amount) FILTER (WHERE category = 'expense'  AND direction = 'out'), 0) AS expenses,
                COALESCE(SUM(amount) FILTER (WHERE category = 'purchase' AND direction = 'out'), 0) AS purchases_paid,
                COALESCE(SUM(amount) FILTER (WHERE category = 'deposit'), 0)                        AS deposits,
                COALESCE(SUM(amount) FILTER (WHERE category = 'withdrawal'), 0)                     AS withdrawals
               FROM cash_movements WHERE day_id = $1`, [dayId]),
    q.query("SELECT count(*)::int AS n FROM notes WHERE day_id = $1", [dayId]),
    q.query("SELECT count(*)::int AS n FROM sale_returns WHERE day_id = $1", [dayId])
  ]);
  const s = sales.rows[0], p = purchases.rows[0], e = expenses.rows[0], c = cash.rows[0];
  const profit = r2(s.profit);
  const expensesTotal = r2(e.total);
  const types = (await saleTypeBreakdownByDay([dayId], q)).get(String(dayId));
  return {
    total: r2(s.total), cost: r2(s.cost), profit, count: Number(s.count),
    saleTypes: types,
    cash: r2(s.cash), card: r2(s.card), unpaid: r2(s.unpaid),
    byMethod: s.by_method || {},
    purchases: { total: r2(p.total), paid: r2(p.paid_total), count: Number(p.count) },
    expenses: { total: expensesTotal, count: Number(e.count), byCategory: e.by_category || {} },
    cashFlow: {
      in: r2(c.cash_in), out: r2(c.cash_out), net: r2(c.cash_in - c.cash_out),
      salesCash: r2(c.sales_cash_in), salesCard: r2(c.sales_card), refunds: r2(c.refunds),
      expenses: r2(c.expenses), purchases: r2(c.purchases_paid),
      deposits: r2(c.deposits), withdrawals: r2(c.withdrawals)
    },
    netProfit: r2(profit - expensesTotal),
    noteCount: Number(notesCount.rows[0].n),
    returnCount: Number(returnsCount.rows[0].n)
  };
}

/* ───────────── لقطة إغلاق اليوم (ثابتة لا تتغير) ───────────── */
async function buildDaySnapshot(dayId, client) {
  const q = client || db;
  const [totals, balance, day, invCount] = await Promise.all([
    dayTotals(dayId, q),
    cashBalance(q),
    dayById(dayId, q),
    q.query("SELECT count(*)::int AS n FROM invoices WHERE day_id = $1", [dayId])
  ]);
  return {
    totals,
    cashBalanceAtClose: balance,
    invoiceCount: Number(invCount.rows[0].n),
    day: { id: String(day.id), date: day.day_date, dayName: day.day_name,
           startedAt: day.opened_at instanceof Date ? day.opened_at.toISOString() : day.opened_at }
  };
}

/* ملخص اليوم للعرض: إن وُجدت لقطة إغلاق فهي المصدر (الأرقام لا تتغير) */
async function daySummaryForApi(dayId, client) {
  const q = client || db;
  const snap = await q.query("SELECT snapshot, cash_balance FROM day_summaries WHERE day_id = $1", [dayId]);
  if (snap.rows.length) {
    const s = snap.rows[0].snapshot;
    return { totals: s.totals, cashBalanceAtClose: Number(snap.rows[0].cash_balance), frozen: true };
  }
  const totals = await dayTotals(dayId, q);
  return { totals, cashBalanceAtClose: null, frozen: false };
}

/* إجماليات يوم بلا أي عمليات — مطابقة لصفر dayTotals */
function zeroTotals() {
  return {
    total: 0, cost: 0, profit: 0, count: 0, cash: 0, card: 0, unpaid: 0, byMethod: {},
    saleTypes: { sealed: emptyKind(), split: emptyKind() },
    purchases: { total: 0, paid: 0, count: 0 },
    expenses: { total: 0, count: 0, byCategory: {} },
    cashFlow: { in: 0, out: 0, net: 0, salesCash: 0, salesCard: 0, refunds: 0,
                expenses: 0, purchases: 0, deposits: 0, withdrawals: 0 },
    netProfit: 0, noteCount: 0, returnCount: 0
  };
}

/* ─────────────────────────────────────────────────────────────────────
   إجماليات عدة أيام في استعلام واحد — بديل N+1.
   كان كل طلب bootstrap ينفّذ استعلامًا لكل يوم (400 يوم ≈ 400+ استعلام
   متتالي) وهو السبب الرئيسي في بطء النظام. الآن: لقطات جاهزة في
   استعلام واحد + حساب الأيام المفتوحة في 8 استعلامات متوازية.
   ───────────────────────────────────────────────────────────────────── */
async function daySummariesForApi(dayIds, client) {
  const q = client || db;
  const ids = (dayIds || []).map(String);
  const out = new Map();
  if (!ids.length) return out;

  /* 1) أيام مغلقة: اللقطة المخزنة تكفي (بدون أي حساب) */
  const snaps = await q.query(
    `SELECT ds.day_id, ds.snapshot, ds.cash_balance
       FROM day_summaries ds
      WHERE ds.day_id = ANY($1::bigint[])`, [ids]);
  for (const row of snaps.rows) {
    const snap = row.snapshot || {};
    out.set(String(row.day_id), {
      totals: snap.totals || zeroTotals(),
      cashBalanceAtClose: Number(row.cash_balance),
      frozen: true
    });
  }

  /* 2) باقي الأيام (مفتوحة/بدون لقطة): تُحسب كلها دفعة واحدة */
  const missing = ids.filter(id => !out.has(id));
  if (!missing.length) return out;

  const [salesR, byMethodR, purchasesR, expensesR, expByCatR, cashR, notesR, returnsR] = await Promise.all([
    q.query(`SELECT i.day_id,
                    COALESCE(SUM(i.total - i.refunded), 0)                                AS total,
                    COALESCE(SUM(i.cost_total - (i.refunded - i.refunded_profit)), 0)     AS cost,
                    COALESCE(SUM(i.profit - i.refunded_profit), 0)                        AS profit,
                    COUNT(i.id)                                                           AS count,
                    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'cash'), 0)  AS cash,
                    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'card'), 0)  AS card,
                    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'unpaid'), 0) AS unpaid
               FROM invoices i
              WHERE i.day_id = ANY($1::bigint[]) AND i.status <> 'cancelled'
              GROUP BY i.day_id`, [missing]),
    q.query(`SELECT day_id, payment_method AS pm, SUM(total - refunded) AS amt
               FROM invoices
              WHERE day_id = ANY($1::bigint[]) AND status <> 'cancelled'
              GROUP BY 1, 2`, [missing]),
    q.query(`SELECT day_id, COALESCE(SUM(total), 0) AS total,
                    COALESCE(SUM(total) FILTER (WHERE paid), 0) AS paid_total, count(*) AS count
               FROM purchases
              WHERE day_id = ANY($1::bigint[]) AND status = 'completed'
              GROUP BY day_id`, [missing]),
    q.query(`SELECT day_id, COALESCE(SUM(amount), 0) AS total, count(*) AS count
               FROM expenses WHERE day_id = ANY($1::bigint[]) GROUP BY day_id`, [missing]),
    q.query(`SELECT day_id, category, SUM(amount) AS total
               FROM expenses WHERE day_id = ANY($1::bigint[]) GROUP BY 1, 2`, [missing]),
    q.query(`SELECT day_id,
                    COALESCE(SUM(amount) FILTER (WHERE direction = 'in'  AND (method IS NULL OR method = 'cash')), 0) AS cash_in,
                    COALESCE(SUM(amount) FILTER (WHERE direction = 'out' AND (method IS NULL OR method = 'cash')), 0) AS cash_out,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND direction = 'in'), 0)  AS sales_cash_in,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND method = 'card'), 0)   AS sales_card,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'refund'), 0)                        AS refunds,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'expense'  AND direction = 'out'), 0) AS expenses,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'purchase' AND direction = 'out'), 0) AS purchases_paid,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'deposit'), 0)                       AS deposits,
                    COALESCE(SUM(amount) FILTER (WHERE category = 'withdrawal'), 0)                    AS withdrawals
               FROM cash_movements WHERE day_id = ANY($1::bigint[]) GROUP BY day_id`, [missing]),
    q.query("SELECT day_id, count(*)::int AS n FROM notes WHERE day_id = ANY($1::bigint[]) GROUP BY day_id", [missing]),
    q.query("SELECT day_id, count(*)::int AS n FROM sale_returns WHERE day_id = ANY($1::bigint[]) GROUP BY day_id", [missing])
  ]);

  const typesM = await saleTypeBreakdownByDay(missing, q);
  const byMethod = new Map();
  for (const r of byMethodR.rows) {
    const k = String(r.day_id);
    if (!byMethod.has(k)) byMethod.set(k, {});
    byMethod.get(k)[r.pm] = r2(r.amt);
  }
  const purchasesM = new Map(purchasesR.rows.map(r => [String(r.day_id), r]));
  const expensesM  = new Map(expensesR.rows.map(r => [String(r.day_id), r]));
  const cashM      = new Map(cashR.rows.map(r => [String(r.day_id), r]));
  const notesM     = new Map(notesR.rows.map(r => [String(r.day_id), r.n]));
  const returnsM   = new Map(returnsR.rows.map(r => [String(r.day_id), r.n]));
  const salesM     = new Map(salesR.rows.map(r => [String(r.day_id), r]));
  const expCat = new Map();
  for (const r of expByCatR.rows) {
    const k = String(r.day_id);
    if (!expCat.has(k)) expCat.set(k, {});
    expCat.get(k)[r.category] = r2(r.total);
  }

  for (const id of missing) {
    const s = salesM.get(id);
    const p = purchasesM.get(id);
    const e = expensesM.get(id);
    const c = cashM.get(id);
    const profit = r2(s ? s.profit : 0);
    const expensesTotal = r2(e ? e.total : 0);
    out.set(id, {
      totals: {
        total: r2(s ? s.total : 0), cost: r2(s ? s.cost : 0), profit,
        count: s ? Number(s.count) : 0,
        cash: r2(s ? s.cash : 0), card: r2(s ? s.card : 0), unpaid: r2(s ? s.unpaid : 0),
        byMethod: byMethod.get(id) || {},
        saleTypes: typesM.get(id) || { sealed: emptyKind(), split: emptyKind() },
        purchases: { total: r2(p ? p.total : 0), paid: r2(p ? p.paid_total : 0), count: p ? Number(p.count) : 0 },
        expenses: { total: expensesTotal, count: e ? Number(e.count) : 0, byCategory: expCat.get(id) || {} },
        cashFlow: {
          in: r2(c ? c.cash_in : 0), out: r2(c ? c.cash_out : 0),
          net: r2((c ? c.cash_in : 0) - (c ? c.cash_out : 0)),
          salesCash: r2(c ? c.sales_cash_in : 0), salesCard: r2(c ? c.sales_card : 0),
          refunds: r2(c ? c.refunds : 0), expenses: r2(c ? c.expenses : 0),
          purchases: r2(c ? c.purchases_paid : 0),
          deposits: r2(c ? c.deposits : 0), withdrawals: r2(c ? c.withdrawals : 0)
        },
        netProfit: r2(profit - expensesTotal),
        noteCount: Number(notesM.get(id) || 0),
        returnCount: Number(returnsM.get(id) || 0)
      },
      cashBalanceAtClose: null,
      frozen: false
    });
  }
  return out;
}

module.exports = {
  r2, invoiceEffective, getOpenDay, requireOpenDay, dayById, assertDayOpen,
  recordCashMove, reverseCashMove, cashBalance, recordStockMove, recordVialMove,
  saleTypeBreakdownByDay,
  dayTotals, buildDaySnapshot, daySummaryForApi, daySummariesForApi, zeroTotals, DAY_SALES_TOTALS
};
