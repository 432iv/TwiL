"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/reports — لوحة التحكم والتقارير
   dashboard · المبيعات (يوم/منتج/طريقة دفع/نوع البيع/حجم التقسيم)
   · الأرباح والخسائر · المخزون (مغلق/مفتوح/عبوات، نواقص، الأكثر مبيعاً، الأقل حركة)
   · تقرير العطور (مبيعات مغلقة وتقسيم، مل مباعة، عبوات، فتح للتقسيم)
   كل الأرقام محسوبة من البيانات الفعلية — لا أرقام ثابتة.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, isoDate } = require("../lib/http");
const { mapInvoiceLite } = require("../lib/map");

const router = express.Router();
const r2 = ledger.r2;

/* ═══════════════ لوحة التحكم ═══════════════ */
router.get("/dashboard", wrap(async (_req, res) => {
  const open = await ledger.getOpenDay();

  const [today, balance, cardTotal, inventory, grand, recentInvoices, recentPurchases, lowStock, unpaidTotal,
         openPerfumes, topSelling, vialStats, lowVials] =
    await Promise.all([
      open ? ledger.dayTotals(open.id) : null,
      ledger.cashBalance(),
      db.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS t
                  FROM cash_movements WHERE method='card'`),
      db.query(`SELECT COALESCE(SUM(quantity * purchase_price),0) AS value,
                       COALESCE(SUM(quantity * sale_price),0) AS retail,
                       COALESCE(SUM(quantity),0) AS sealed_qty,
                       COALESCE(SUM(open_ml),0) AS open_ml,
                       COALESCE(SUM(open_ml * open_cost_per_ml),0) AS open_value,
                       COALESCE(SUM(open_ml * ml_price),0) AS open_retail,
                       count(*) FILTER (WHERE is_active) AS products,
                       count(*) FILTER (WHERE is_active AND quantity <= min_stock) AS low_count,
                       count(*) FILTER (WHERE open_ml > 0) AS open_count
                  FROM products`),
      db.query(`
        SELECT
          (SELECT COALESCE(SUM(total - refunded),0) FROM invoices WHERE status <> 'cancelled')                          AS sales,
          (SELECT COALESCE(SUM(profit - refunded_profit),0) FROM invoices WHERE status <> 'cancelled')                 AS profit,
          (SELECT COALESCE(SUM(total),0) FROM purchases WHERE status = 'completed')                                    AS purchases,
          (SELECT COALESCE(SUM(amount),0) FROM expenses)                                                               AS expenses,
          (SELECT count(*) FROM invoices WHERE status <> 'cancelled')                                                  AS invoice_count,
          (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date = CURRENT_DATE)                             AS expenses_today`),
      db.query(`SELECT i.*,
                       (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id) AS items_count,
                       (SELECT x.product_name FROM invoice_items x WHERE x.invoice_id = i.id ORDER BY x.id LIMIT 1) AS first_product
                  FROM invoices i WHERE i.status <> 'cancelled'
                 ORDER BY i.sale_time DESC, i.id DESC LIMIT 8`),
      db.query(`SELECT p.*, (SELECT count(*) FROM purchase_items x WHERE x.purchase_id = p.id) AS items_count,
                       (SELECT x.product_name FROM purchase_items x WHERE x.purchase_id = p.id ORDER BY x.id LIMIT 1) AS first_product
                  FROM purchases p WHERE p.status = 'completed'
                 ORDER BY p.created_at DESC, p.id DESC LIMIT 5`),
      db.query(`SELECT p.id, p.name, p.brand, p.quantity, p.min_stock, p.open_ml
                  FROM products p WHERE p.is_active AND p.quantity <= p.min_stock
                 ORDER BY (p.quantity - p.min_stock), p.name LIMIT 12`),
      db.query(`SELECT COALESCE(SUM(total - refunded),0) AS t FROM invoices
                  WHERE status <> 'cancelled' AND payment_method = 'unpaid'`),
      db.query(`SELECT p.id, p.name, p.brand, p.size_ml, p.open_ml, p.ml_price, p.quantity
                  FROM products p WHERE p.is_active AND p.open_ml > 0
                 ORDER BY p.open_ml, p.name LIMIT 12`),
      db.query(`
        SELECT ii.product_id AS id, ii.product_name AS name,
               SUM(ii.qty - ii.qty_returned) FILTER (WHERE ii.sale_type = 'sealed') AS pieces,
               SUM(ii.ml_qty * (ii.qty - ii.qty_returned)) FILTER (WHERE ii.sale_type = 'split') AS ml,
               SUM(ii.line_total * (ii.qty - ii.qty_returned) / ii.qty) AS total
          FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.status <> 'cancelled' AND ii.product_id IS NOT NULL
           AND i.sale_date >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY 1,2 HAVING SUM(ii.qty - ii.qty_returned) > 0
         ORDER BY total DESC LIMIT 5`),
      db.query(`SELECT count(*) FILTER (WHERE is_active) AS vials,
                       COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(quantity * cost),0) AS value,
                       count(*) FILTER (WHERE is_active AND quantity <= min_stock) AS low_count
                  FROM vials`),
      db.query(`SELECT id, name, size_ml, quantity, min_stock FROM vials
                 WHERE is_active AND quantity <= min_stock ORDER BY quantity, size_ml LIMIT 12`)
    ]);

  const g = grand.rows[0];
  const todayExpenses = today ? today.expenses.total : Number(g.expenses_today);
  res.json({
    today: today ? {
      sales: today.total, profit: today.profit, count: today.count,
      cash: today.cash, card: today.card, unpaid: today.unpaid,
      purchases: today.purchases, expenses: today.expenses,
      netProfit: today.netProfit,
      saleTypes: today.saleTypes,
      cashIn: today.cashFlow.in, cashOut: today.cashFlow.out, cashNet: today.cashFlow.net,
      deposits: today.cashFlow.deposits, withdrawals: today.cashFlow.withdrawals,
      refunds: today.cashFlow.refunds
    } : null,
    openDay: open ? { id: String(open.id), date: open.day_date, startedAt: open.opened_at } : null,
    cashBalance: r2(balance),
    cardTotal: r2(cardTotal.rows[0].t),
    unpaidTotal: r2(unpaidTotal.rows[0].t),
    inventory: {
      value: r2(inventory.rows[0].value),
      retailValue: r2(inventory.rows[0].retail),
      products: Number(inventory.rows[0].products),
      lowCount: Number(inventory.rows[0].low_count),
      sealedQty: Number(inventory.rows[0].sealed_qty),
      openMl: r2(inventory.rows[0].open_ml),
      openValue: r2(inventory.rows[0].open_value),
      openRetail: r2(inventory.rows[0].open_retail),
      openCount: Number(inventory.rows[0].open_count),
      lowStock: lowStock.rows.map(r => ({
        id: String(r.id), name: r.name, brand: r.brand || null, qty: r.quantity,
        minStock: r.min_stock, openMl: Number(r.open_ml)
      })),
      vials: {
        count: Number(vialStats.rows[0].vials), qty: Number(vialStats.rows[0].qty),
        value: r2(vialStats.rows[0].value), lowCount: Number(vialStats.rows[0].low_count),
        low: lowVials.rows.map(r => ({
          id: String(r.id), name: r.name, sizeMl: Number(r.size_ml), qty: r.quantity, minStock: r.min_stock
        }))
      }
    },
    openPerfumes: openPerfumes.rows.map(r => ({
      id: String(r.id), name: r.name, brand: r.brand || null, sizeMl: r.size_ml === null ? null : Number(r.size_ml),
      openMl: Number(r.open_ml), mlPrice: Number(r.ml_price), sealedQty: r.quantity
    })),
    topSelling: topSelling.rows.map(r => ({
      id: String(r.id), name: r.name, pieces: Number(r.pieces || 0), ml: Number(r.ml || 0), total: r2(r.total)
    })),
    grand: {
      sales: r2(g.sales), profit: r2(g.profit),
      purchases: r2(g.purchases), expenses: r2(g.expenses),
      netProfit: r2(g.profit - g.expenses),
      invoiceCount: Number(g.invoice_count)
    },
    recentInvoices: recentInvoices.rows.map(mapInvoiceLite),
    recentPurchases: recentPurchases.rows.map(r => ({
      id: String(r.id), purchaseNo: r.purchase_no, total: Number(r.total),
      itemsCount: Number(r.items_count), firstProduct: r.first_product || "",
      time: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      status: r.status
    }))
  });
}));

/* ═══════════════ تقارير المبيعات ═══════════════
   ?from&to&group=day|product|method|type|size
     type = مغلق مقابل تقسيم · size = حسب حجم التقسيم المباع (5/10/20 مل…) */
router.get("/sales", wrap(async (req, res) => {
  const from = req.query.from ? isoDate(req.query.from) : null;
  const to = req.query.to ? isoDate(req.query.to) : null;
  const group = ["day", "product", "method", "type", "size"].includes(req.query.group) ? req.query.group : "day";
  const conds = ["i.status <> 'cancelled'"];
  const params = [];
  if (from) { params.push(from); conds.push(`i.sale_date >= $${params.length}`); }
  if (to)   { params.push(to);   conds.push(`i.sale_date <= $${params.length}`); }
  const where = "WHERE " + conds.join(" AND ");

  /* بنود فعّالة (بعد خصم المرتجعات) — تُستخدم في تجميعات المنتج/النوع/الحجم */
  const EFF_ITEMS = `
    SELECT ii.*, i.sale_date,
           round(ii.selling_price * (ii.qty - ii.qty_returned), 2)   AS e_total,
           round(ii.wholesale_price * (ii.qty - ii.qty_returned), 2) AS e_cost,
           (ii.qty - ii.qty_returned)                                AS e_qty
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      ${where}`;
  const margin = r => Number(r.total) > 0 ? Math.round((Number(r.profit) / Number(r.total)) * 1000) / 10 : 0;

  if (group === "product") {
    const { rows } = await db.query(`
      SELECT x.product_name AS label, x.product_id AS product_id,
             SUM(x.e_qty) FILTER (WHERE x.sale_type = 'sealed') AS qty,
             SUM(x.ml_qty * x.e_qty) FILTER (WHERE x.sale_type = 'split') AS ml,
             SUM(x.e_total) AS total, SUM(x.e_cost) AS cost, SUM(x.e_total - x.e_cost) AS profit
        FROM (${EFF_ITEMS}) x
       GROUP BY 1, 2 ORDER BY total DESC LIMIT 200`, params);
    return res.json({ group, rows: rows.map(r => ({
      label: r.label, productId: r.product_id === null ? null : String(r.product_id),
      qty: Number(r.qty || 0), ml: r2(r.ml || 0),
      total: r2(r.total), cost: r2(r.cost), profit: r2(r.profit), margin: margin(r)
    })) });
  }

  if (group === "type") {
    const { rows } = await db.query(`
      SELECT x.sale_type AS label, count(*) FILTER (WHERE x.e_qty > 0) AS lines,
             COALESCE(SUM(x.e_qty) FILTER (WHERE x.sale_type = 'sealed'), 0) AS qty,
             COALESCE(SUM(x.ml_qty * x.e_qty), 0) AS ml,
             SUM(x.e_total) AS total, SUM(x.e_cost) AS cost, SUM(x.e_total - x.e_cost) AS profit
        FROM (${EFF_ITEMS}) x
       GROUP BY 1 ORDER BY 1`, params);
    return res.json({ group, rows: rows.map(r => ({
      label: r.label, lines: Number(r.lines), qty: Number(r.qty), ml: r2(r.ml),
      total: r2(r.total), cost: r2(r.cost), profit: r2(r.profit), margin: margin(r)
    })) });
  }

  if (group === "size") {
    const { rows } = await db.query(`
      SELECT x.ml_qty AS label, count(*) AS lines, SUM(x.ml_qty) AS ml,
             SUM(x.e_total) AS total, SUM(x.e_cost) AS cost, SUM(x.e_total - x.e_cost) AS profit
        FROM (${EFF_ITEMS}) x
       WHERE x.sale_type = 'split' AND x.e_qty > 0
       GROUP BY 1 ORDER BY 1`, params);
    return res.json({ group, rows: rows.map(r => ({
      label: Number(r.label), lines: Number(r.lines), ml: r2(r.ml),
      total: r2(r.total), cost: r2(r.cost), profit: r2(r.profit), margin: margin(r)
    })) });
  }

  if (group === "method") {
    const { rows } = await db.query(`
      SELECT i.payment_method AS label, count(*) AS count,
             SUM(i.total - i.refunded) AS total,
             SUM(i.profit - i.refunded_profit) AS profit
        FROM invoices i ${where}
       GROUP BY 1 ORDER BY total DESC`, params);
    return res.json({ group, rows: rows.map(r => ({
      label: r.label, count: Number(r.count), total: r2(r.total), profit: r2(r.profit)
    })) });
  }

  const { rows } = await db.query(`
    SELECT i.sale_date AS label, count(*) AS count,
           SUM(i.total - i.refunded) AS total,
           SUM(i.cost_total - (i.refunded - i.refunded_profit)) AS cost,
           SUM(i.profit - i.refunded_profit) AS profit
      FROM invoices i ${where}
     GROUP BY 1 ORDER BY 1 DESC LIMIT 400`, params);
  res.json({ group: "day", rows: rows.map(r => ({
    label: r.label, count: Number(r.count), total: r2(r.total), cost: r2(r.cost), profit: r2(r.profit)
  })) });
}));

/* ═══════════════ الأرباح والخسائر (فترة) ═══════════════ */
router.get("/pnl", wrap(async (req, res) => {
  const from = req.query.from ? isoDate(req.query.from) : null;
  const to = req.query.to ? isoDate(req.query.to) : null;
  const dConds = [], pConds = ["status = 'completed'"], eConds = [];
  const params = [];
  if (from) { params.push(from); dConds.push(`sale_date >= $${params.length}`); pConds.push(`purchase_date >= $${params.length}`); eConds.push(`expense_date >= $${params.length}`); }
  if (to)   { params.push(to);   dConds.push(`sale_date <= $${params.length}`); pConds.push(`purchase_date <= $${params.length}`); eConds.push(`expense_date <= $${params.length}`); }

  const [sales, purchases, expenses] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(total - refunded),0) AS sales,
                     COALESCE(SUM(cost_total - (refunded - refunded_profit)),0) AS cost,
                     COALESCE(SUM(profit - refunded_profit),0) AS profit,
                     COALESCE(SUM(discount),0) AS discounts,
                     count(*) AS count
                FROM invoices WHERE status <> 'cancelled'
                ${dConds.length ? "AND " + dConds.join(" AND ") : ""}`, params),
    db.query(`SELECT COALESCE(SUM(total),0) AS total, count(*) AS count
                FROM purchases WHERE ${pConds.join(" AND ")}`, params),
    db.query(`SELECT category, SUM(amount) AS total FROM expenses
                ${eConds.length ? "WHERE " + eConds.join(" AND ") : ""}
               GROUP BY 1`, params)
  ]);

  const s = sales.rows[0];
  const expByCat = {};
  let expTotal = 0;
  for (const r of expenses.rows) { expByCat[r.category] = r2(r.total); expTotal += Number(r.total); }
  res.json({
    period: { from, to },
    sales: { total: r2(s.sales), cost: r2(s.cost), profit: r2(s.profit), discounts: r2(s.discounts), count: Number(s.count) },
    purchases: { total: r2(purchases.rows[0].total), count: Number(purchases.rows[0].count) },
    expenses: { total: r2(expTotal), byCategory: expByCat },
    netProfit: r2(Number(s.profit) - expTotal)
  });
}));

/* ═══════════════ تقارير المخزون (مغلق / مفتوح / عبوات) ═══════════════ */
router.get("/inventory", wrap(async (_req, res) => {
  const [value, low, top, slow, split, vials, lowVials] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(quantity * purchase_price),0) AS cost_value,
                     COALESCE(SUM(quantity * sale_price),0) AS retail_value,
                     COALESCE(SUM(open_ml * open_cost_per_ml),0) AS open_cost,
                     COALESCE(SUM(open_ml * ml_price),0) AS open_retail,
                     count(*) FILTER (WHERE is_active) AS products,
                     COALESCE(SUM(quantity),0) AS total_qty,
                     COALESCE(SUM(open_ml),0) AS open_ml
                FROM products`),
    db.query(`SELECT p.id, p.name, p.brand, p.quantity, p.min_stock, p.purchase_price, p.open_ml
                FROM products p WHERE p.is_active AND p.quantity <= p.min_stock
               ORDER BY (p.quantity - p.min_stock), p.name`),
    db.query(`
      SELECT ii.product_id AS id, ii.product_name AS name,
             COALESCE(SUM(ii.qty - ii.qty_returned) FILTER (WHERE ii.sale_type = 'sealed'), 0) AS qty,
             COALESCE(SUM(ii.ml_qty * (ii.qty - ii.qty_returned)) FILTER (WHERE ii.sale_type = 'split'), 0) AS ml,
             SUM(ii.line_total * (ii.qty - ii.qty_returned) / ii.qty) AS total,
             SUM((ii.line_total - ii.line_cost) * (ii.qty - ii.qty_returned) / ii.qty) AS profit
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.status <> 'cancelled' AND ii.product_id IS NOT NULL
       GROUP BY 1,2 ORDER BY total DESC NULLS LAST LIMIT 10`),
    db.query(`
      SELECT p.id, p.name, p.quantity, p.open_ml, p.purchase_price, p.open_cost_per_ml, p.updated_at,
             (SELECT MAX(ii.created_at) FROM invoice_items ii
               JOIN invoices i ON i.id = ii.invoice_id
              WHERE ii.product_id = p.id AND i.status <> 'cancelled') AS last_sold_at
        FROM products p
       WHERE p.is_active AND (p.quantity > 0 OR p.open_ml > 0)
         AND NOT EXISTS (SELECT 1 FROM invoice_items ii
                          JOIN invoices i ON i.id = ii.invoice_id
                         WHERE ii.product_id = p.id AND i.status <> 'cancelled'
                           AND i.sale_date >= CURRENT_DATE - INTERVAL '30 days')
       ORDER BY p.updated_at DESC LIMIT 10`),
    /* مغلق مقابل مفتوح لكل عطر */
    db.query(`SELECT p.id, p.name, p.brand, p.size_ml, p.quantity, p.open_ml, p.purchase_price, p.sale_price,
                     p.ml_price, p.open_cost_per_ml, p.allow_split
                FROM products p WHERE p.is_active AND (p.quantity > 0 OR p.open_ml > 0 OR p.allow_split)
               ORDER BY p.name`),
    db.query(`SELECT COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(quantity * cost),0) AS cost_value,
                     COALESCE(SUM(quantity * sale_price),0) AS retail_value, count(*) FILTER (WHERE is_active) AS n
                FROM vials`),
    db.query(`SELECT id, name, size_ml, quantity, min_stock FROM vials
               WHERE is_active AND quantity <= min_stock ORDER BY quantity, size_ml`)
  ]);

  const v = value.rows[0], vv = vials.rows[0];
  res.json({
    value: {
      cost: r2(v.cost_value),
      retail: r2(v.retail_value),
      openCost: r2(v.open_cost),
      openRetail: r2(v.open_retail),
      products: Number(v.products),
      totalQty: Number(v.total_qty),
      openMl: r2(v.open_ml),
      vialQty: Number(vv.qty), vialCost: r2(vv.cost_value), vialRetail: r2(vv.retail_value), vialTypes: Number(vv.n)
    },
    lowStock: low.rows.map(r => ({
      id: String(r.id), name: r.name, brand: r.brand || null, qty: r.quantity,
      minStock: r.min_stock, purchasePrice: r2(r.purchase_price), openMl: Number(r.open_ml)
    })),
    lowVials: lowVials.rows.map(r => ({
      id: String(r.id), name: r.name, sizeMl: Number(r.size_ml), qty: r.quantity, minStock: r.min_stock
    })),
    topSelling: top.rows.map(r => ({
      id: String(r.id), name: r.name, qty: Number(r.qty), ml: r2(r.ml),
      total: r2(r.total), profit: r2(r.profit)
    })),
    slowMoving: slow.rows.map(r => ({
      id: String(r.id), name: r.name, qty: r.quantity, openMl: Number(r.open_ml),
      value: r2(r.quantity * r.purchase_price + Number(r.open_ml) * Number(r.open_cost_per_ml)),
      lastSoldAt: r.last_sold_at instanceof Date ? r.last_sold_at.toISOString() : r.last_sold_at
    })),
    sealedVsOpen: split.rows.map(r => ({
      id: String(r.id), name: r.name, brand: r.brand || null,
      sizeMl: r.size_ml === null ? null : Number(r.size_ml), allowSplit: r.allow_split,
      sealedQty: r.quantity, openMl: Number(r.open_ml),
      sealedCost: r2(r.quantity * r.purchase_price), sealedRetail: r2(r.quantity * r.sale_price),
      openCost: r2(Number(r.open_ml) * Number(r.open_cost_per_ml)), openRetail: r2(Number(r.open_ml) * Number(r.ml_price))
    }))
  });
}));

/* ═══════════════ تقرير العطور: مبيعات مغلقة وتقسيم، مل، عبوات، فتح للتقسيم ═══════════════
   ?from&to — بنود الفواتير غير الملغاة، بعد خصم المرتجعات (قبل خصم الفاتورة) */
router.get("/perfumes", wrap(async (req, res) => {
  const from = req.query.from ? isoDate(req.query.from) : null;
  const to = req.query.to ? isoDate(req.query.to) : null;
  const conds = ["i.status <> 'cancelled'"], params = [];
  const dConds = [], pConds = ["p.status = 'completed'"], oConds = [], eConds = [];
  if (from) {
    params.push(from);
    const n = "$" + params.length;
    conds.push(`i.sale_date >= ${n}`); pConds.push(`p.purchase_date >= ${n}`);
    oConds.push(`o.created_at >= ${n}::date`); eConds.push(`expense_date >= ${n}`); dConds.push(n);
  }
  if (to) {
    params.push(to);
    const n = "$" + params.length;
    conds.push(`i.sale_date <= ${n}`); pConds.push(`p.purchase_date <= ${n}`);
    oConds.push(`o.created_at < (${n}::date + 1)`); eConds.push(`expense_date <= ${n}`);
  }
  const where = "WHERE " + conds.join(" AND ");
  const EFF = `
    SELECT ii.*, i.sale_date,
           round(ii.selling_price * (ii.qty - ii.qty_returned), 2)   AS e_total,
           round(ii.wholesale_price * (ii.qty - ii.qty_returned), 2) AS e_cost,
           (ii.qty - ii.qty_returned)                                AS e_qty
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id ${where}`;

  const [byType, byPerfume, bySize, byVial, opens, purchases, expenses, stock] = await Promise.all([
    db.query(`SELECT x.sale_type, count(*) FILTER (WHERE x.e_qty > 0) AS lines,
                     COALESCE(SUM(x.e_qty) FILTER (WHERE x.sale_type = 'sealed'), 0) AS pieces,
                     COALESCE(SUM(x.ml_qty * x.e_qty), 0) AS ml,
                     COALESCE(SUM(x.ml_price * x.ml_qty * x.e_qty), 0) AS ml_sales,
                     COALESCE(SUM(x.vial_price * x.vial_qty * x.e_qty), 0) AS vial_sales,
                     COALESCE(SUM(x.vial_cost * x.vial_qty * x.e_qty), 0) AS vial_cost,
                     COALESCE(SUM(x.e_total),0) AS total, COALESCE(SUM(x.e_cost),0) AS cost
                FROM (${EFF}) x GROUP BY 1`, params),
    db.query(`SELECT x.product_id AS id, x.product_name AS name,
                     COALESCE(SUM(x.e_qty) FILTER (WHERE x.sale_type = 'sealed'), 0) AS pieces,
                     COALESCE(SUM(x.e_total) FILTER (WHERE x.sale_type = 'sealed'), 0) AS sealed_total,
                     COALESCE(SUM(x.ml_qty * x.e_qty) FILTER (WHERE x.sale_type = 'split'), 0) AS ml,
                     COALESCE(SUM(x.e_total) FILTER (WHERE x.sale_type = 'split'), 0) AS split_total,
                     SUM(x.e_total) AS total, SUM(x.e_cost) AS cost
                FROM (${EFF}) x GROUP BY 1,2
              HAVING SUM(x.e_qty) > 0 ORDER BY total DESC LIMIT 100`, params),
    db.query(`SELECT x.ml_qty AS size, count(*) AS lines, SUM(x.ml_qty) AS ml,
                     SUM(x.e_total) AS total, SUM(x.e_cost) AS cost
                FROM (${EFF}) x WHERE x.sale_type = 'split' AND x.e_qty > 0
               GROUP BY 1 ORDER BY 1`, params),
    db.query(`SELECT x.vial_id AS id, COALESCE(x.vial_name, '—') AS name, x.vial_size_ml AS size,
                     SUM(x.vial_qty) AS qty, SUM(x.vial_cost * x.vial_qty) AS cost,
                     SUM(x.vial_price * x.vial_qty) AS sales
                FROM (${EFF}) x WHERE x.sale_type = 'split' AND x.e_qty > 0 AND x.vial_qty > 0
               GROUP BY 1,2,3 ORDER BY 3, 2`, params),
    db.query(`SELECT count(*) AS ops, COALESCE(SUM(o.pieces),0) AS pieces,
                     COALESCE(SUM(o.ml_added),0) AS ml, COALESCE(SUM(o.pieces * o.piece_cost),0) AS cost
                FROM open_operations o ${oConds.length ? "WHERE " + oConds.join(" AND ") : ""}`, params.slice(0, oConds.length)),
    db.query(`SELECT COALESCE(SUM(x.line_total) FILTER (WHERE x.item_type = 'perfume'),0) AS perfumes,
                     COALESCE(SUM(x.line_total) FILTER (WHERE x.item_type = 'vial'),0) AS vials,
                     COALESCE(SUM(x.qty) FILTER (WHERE x.item_type = 'perfume'),0) AS perfume_qty,
                     COALESCE(SUM(x.qty) FILTER (WHERE x.item_type = 'vial'),0) AS vial_qty
                FROM purchase_items x JOIN purchases p ON p.id = x.purchase_id WHERE ${pConds.join(" AND ")}`, params),
    db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses ${eConds.length ? "WHERE " + eConds.join(" AND ") : ""}`, params),
    db.query(`SELECT COALESCE(SUM(quantity),0) AS sealed_qty, COALESCE(SUM(quantity * purchase_price),0) AS sealed_cost,
                     COALESCE(SUM(open_ml),0) AS open_ml, COALESCE(SUM(open_ml * open_cost_per_ml),0) AS open_cost,
                     (SELECT COALESCE(SUM(quantity),0) FROM vials) AS vial_qty,
                     (SELECT COALESCE(SUM(quantity * cost),0) FROM vials) AS vial_cost
                FROM products`)
  ]);

  const kind = t => byType.rows.find(r => r.sale_type === t) || {};
  const sealed = kind("sealed"), split = kind("split");
  const sealedTotal = r2(sealed.total || 0), sealedCost = r2(sealed.cost || 0);
  const splitTotal = r2(split.total || 0), splitCost = r2(split.cost || 0);
  const pct = (profit, total) => Number(total) > 0 ? Math.round((Number(profit) / Number(total)) * 1000) / 10 : 0;
  const expTotal = r2(expenses.rows[0].total);
  const totalProfit = r2(sealedTotal - sealedCost + splitTotal - splitCost);
  const pu = purchases.rows[0], op = opens.rows[0], st = stock.rows[0];

  res.json({
    period: { from, to },
    sealed: {
      pieces: Number(sealed.pieces || 0), total: sealedTotal, cost: sealedCost,
      profit: r2(sealedTotal - sealedCost), margin: pct(sealedTotal - sealedCost, sealedTotal)
    },
    split: {
      lines: Number(split.lines || 0), ml: r2(split.ml || 0), total: splitTotal, cost: splitCost,
      profit: r2(splitTotal - splitCost), margin: pct(splitTotal - splitCost, splitTotal),
      perfumeSales: r2(split.ml_sales || 0),
      vialSales: r2(split.vial_sales || 0), vialCost: r2(split.vial_cost || 0)
    },
    totalProfit,
    byPerfume: byPerfume.rows.map(r => ({
      id: r.id === null ? null : String(r.id), name: r.name, pieces: Number(r.pieces), ml: r2(r.ml),
      sealedTotal: r2(r.sealed_total), splitTotal: r2(r.split_total),
      total: r2(r.total), cost: r2(r.cost), profit: r2(r.total - r.cost)
    })),
    bySize: bySize.rows.map(r => ({
      size: Number(r.size), lines: Number(r.lines), ml: r2(r.ml),
      total: r2(r.total), cost: r2(r.cost), profit: r2(r.total - r.cost)
    })),
    vials: byVial.rows.map(r => ({
      id: r.id === null ? null : String(r.id), name: r.name, size: r.size === null ? null : Number(r.size),
      qty: Number(r.qty), cost: r2(r.cost), sales: r2(r.sales), profit: r2(r.sales - r.cost)
    })),
    openOps: { count: Number(op.ops), pieces: Number(op.pieces), ml: r2(op.ml), cost: r2(op.cost) },
    purchases: {
      perfumes: r2(pu.perfumes), vials: r2(pu.vials), total: r2(Number(pu.perfumes) + Number(pu.vials)),
      perfumeQty: Number(pu.perfume_qty), vialQty: Number(pu.vial_qty)
    },
    expenses: expTotal,
    netProfit: r2(totalProfit - expTotal),
    stock: {
      sealedQty: Number(st.sealed_qty), sealedCost: r2(st.sealed_cost),
      openMl: r2(st.open_ml), openCost: r2(st.open_cost),
      vialQty: Number(st.vial_qty), vialCost: r2(st.vial_cost)
    }
  });
}));

module.exports = router;
