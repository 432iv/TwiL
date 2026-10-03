"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/settings · /api/bootstrap · /api/payment-methods
   /api/backup (نسخ احتياطي) · /api/backup/restore (استرجاع)
   /api/import (استيراد نسخة المتصفح القديمة) · /api/data (حذف الكل)
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, isoDate, dayNameFor, toMoney, toInt } = require("../lib/http");
const { mapDay, mapNote, mapInvoice, mapProduct, mapCategory, mapVial, mapPurchase, mapExpense, mapCashMove } = require("../lib/map");
const { normalizeName } = require("../lib/names");

const router = express.Router();

/* التصنيفات الوحيدة المسموحة: صيفية / شتوية (يفرضها قيد في القاعدة أيضاً) */
async function seedCategories(client) {
  await client.query(`INSERT INTO categories (name, sort_order, code) VALUES
    ('صيفية', 1, 'summer'), ('شتوية', 2, 'winter')
    ON CONFLICT (code) DO NOTHING`);
}

/* ───────────── الإعدادات (تتبع الحساب بين الأجهزة) ───────────── */
const SETTINGS_COLS = `lang, theme, shop_name, shop_logo, shop_phone, shop_address,
                       invoice_footer, currency, default_min_stock, barcode_quick_sale, barcode_register_mode`;
async function readSettings(userId) {
  const { rows } = await db.query(`SELECT ${SETTINGS_COLS} FROM settings WHERE user_id = $1`, [userId]);
  if (rows.length) return rows[0];
  /* صف الإعدادات يُنشأ عند أول تسجيل دخول */
  await db.query("INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  const again = await db.query(`SELECT ${SETTINGS_COLS} FROM settings WHERE user_id = $1`, [userId]);
  return again.rows[0] || { lang: "ar", theme: "light" };
}

router.get("/settings", wrap(async (req, res) => {
  res.json({ settings: await readSettings(req.user.id) });
}));

router.put("/settings", wrap(async (req, res) => {
  const b = req.body || {};
  const cur = await readSettings(req.user.id);
  const lang = b.lang === "en" ? "en" : "ar";
  const theme = b.theme === "dark" ? "dark" : "light";
  const shopName = b.shopName !== undefined ? (b.shopName ? cleanText(b.shopName, { field: "shopName", max: 60, required: false }) : "يوسف للعطور") : cur.shop_name;
  const shopLogo = b.shopLogo !== undefined ? (b.shopLogo ? String(b.shopLogo).slice(0, 500000) : null) : cur.shop_logo;
  const shopPhone = b.shopPhone !== undefined ? (b.shopPhone ? cleanText(b.shopPhone, { field: "shopPhone", max: 40, required: false }) : null) : cur.shop_phone;
  const shopAddress = b.shopAddress !== undefined ? (b.shopAddress ? cleanText(b.shopAddress, { field: "shopAddress", max: 120, required: false }) : null) : cur.shop_address;
  const invoiceFooter = b.invoiceFooter !== undefined ? (b.invoiceFooter ? cleanText(b.invoiceFooter, { field: "invoiceFooter", max: 200, required: false }) : null) : cur.invoice_footer;
  const currency = b.currency !== undefined ? (b.currency ? cleanText(b.currency, { field: "currency", max: 8, required: false }) : "د.ل") : cur.currency;
  const defaultMinStock = b.defaultMinStock !== undefined ? toInt(b.defaultMinStock, { field: "defaultMinStock", min: 0, max: 1000 }) : cur.default_min_stock;
  const barcodeQuickSale = b.barcodeQuickSale !== undefined ? !!b.barcodeQuickSale : cur.barcode_quick_sale;
  const barcodeRegisterMode = b.barcodeRegisterMode !== undefined ? !!b.barcodeRegisterMode : cur.barcode_register_mode;

  const { rows } = await db.query(
    `INSERT INTO settings (user_id, ${SETTINGS_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id) DO UPDATE SET lang=$2, theme=$3, shop_name=$4, shop_logo=$5,
       shop_phone=$6, shop_address=$7, invoice_footer=$8, currency=$9, default_min_stock=$10,
       barcode_quick_sale=$11, barcode_register_mode=$12, updated_at=now()
     RETURNING ${SETTINGS_COLS}`,
    [req.user.id, lang, theme, shopName, shopLogo, shopPhone, shopAddress, invoiceFooter, currency, defaultMinStock, barcodeQuickSale, barcodeRegisterMode]);
  res.json({ settings: rows[0] });
}));

/* ───────────── طرق الدفع (تفعيل/تعطيل) ───────────── */
router.get("/payment-methods", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT code, sort_order, active FROM payment_methods ORDER BY sort_order, code");
  res.json({ methods: rows.map(r => ({ code: r.code, sortOrder: r.sort_order, active: !!r.active })) });
}));
router.put("/payment-methods", wrap(async (req, res) => {
  const code = String(req.body.code || "");
  if (code === "cash") throw new HttpError(400, "cash_locked", "النقد لا يمكن تعطيله");
  const active = !!req.body.active;
  const { rows } = await db.query(
    "UPDATE payment_methods SET active = $1 WHERE code = $2 RETURNING code, active", [active, code]);
  if (!rows.length) throw new HttpError(404, "payment_invalid", "طريقة دفع غير معروفة");
  res.json({ method: { code: rows[0].code, active: !!rows[0].active } });
}));

/* ───────────── bootstrap: المنظومة كاملة في طلب واحد ───────────── */
router.get("/bootstrap", wrap(async (req, res) => {
  const [settings, days, invoices, purchases, expenses, products, categories,
         names, notes, cash, dashboard, barcodes, vials] = await Promise.all([
    readSettings(req.user.id),
    db.query(`SELECT * FROM days ORDER BY day_date DESC LIMIT 400`),
    db.query("SELECT * FROM invoices ORDER BY sale_time DESC, id DESC LIMIT 400"),
    db.query(`SELECT p.*, (SELECT count(*) FROM purchase_items x WHERE x.purchase_id = p.id) AS items_count
                FROM purchases p ORDER BY p.created_at DESC, p.id DESC LIMIT 200`),
    db.query("SELECT * FROM expenses ORDER BY created_at DESC, id DESC LIMIT 500"),
    db.query(`SELECT p.*, c.name AS category_name, c.code AS category_code FROM products p
                LEFT JOIN categories c ON c.id = p.category_id
               ORDER BY p.is_active DESC, p.name LIMIT 3000`),
    db.query("SELECT * FROM categories ORDER BY sort_order, id"),
    db.query("SELECT name FROM product_names ORDER BY usage_count DESC, last_used_at DESC LIMIT 2000"),
    db.query("SELECT * FROM notes ORDER BY note_time DESC, id DESC LIMIT 2000"),
    db.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS balance
                FROM cash_movements WHERE method IS NULL OR method='cash'`),
    db.query(`SELECT
                (SELECT COALESCE(SUM(total - refunded),0) FROM invoices WHERE status <> 'cancelled') AS sales,
                (SELECT COALESCE(SUM(profit - refunded_profit),0) FROM invoices WHERE status <> 'cancelled') AS profit,
                (SELECT COALESCE(SUM(total),0) FROM purchases WHERE status='completed') AS purchases,
                (SELECT COALESCE(SUM(amount),0) FROM expenses) AS expenses`),
    db.query(`SELECT pb.barcode, pb.product_id, pb.wholesale_price, pb.sale_price,
                     p.name AS product_name, p.quantity, p.open_ml, p.allow_split, p.is_active
                FROM product_barcodes pb JOIN products p ON p.id = pb.product_id
               ORDER BY pb.id`),
    db.query("SELECT * FROM vials ORDER BY is_active DESC, size_ml, name")
  ]);

  const itemRows = invoices.rows.length ? await db.query(
    "SELECT * FROM invoice_items WHERE invoice_id = ANY($1::bigint[]) ORDER BY id",
    [invoices.rows.map(r => r.id)]) : { rows: [] };
  const byInv = new Map();
  for (const it of itemRows.rows) {
    if (!byInv.has(String(it.invoice_id))) byInv.set(String(it.invoice_id), []);
    byInv.get(String(it.invoice_id)).push(it);
  }

  /* إجماليات كل يوم في استعلام واحد — كان استعلامًا لكل يوم وهذا كان يبطئ bootstrap */
  const daySummaries = await ledger.daySummariesForApi(days.rows.map(r => r.id));
  const daysOut = days.rows.map(r => {
    const sum = daySummaries.get(String(r.id));
    const totals = sum ? sum.totals : ledger.zeroTotals();
    return Object.assign(mapDay(r), { totals, netProfit: totals.netProfit });
  });

  const g = dashboard.rows[0];
  res.json({
    user: { id: String(req.user.id), username: req.user.username, email: req.user.email },
    settings,
    days: daysOut,
    sessions: daysOut,
    invoices: invoices.rows.map(r => mapInvoice(r, byInv.get(String(r.id)) || [])),
    purchases: purchases.rows.map(r => mapPurchase(r, null)),
    expenses: expenses.rows.map(mapExpense),
    products: products.rows.map(mapProduct),
    categories: categories.rows.map(mapCategory),
    vials: vials.rows.map(mapVial),
    notes: notes.rows.map(mapNote),
    productNames: names.rows.map(r => r.name),
    barcodes: barcodes.rows.map(r => ({
      barcode: r.barcode, productId: String(r.product_id), productName: r.product_name,
      qty: Number(r.quantity), openMl: Number(r.open_ml), allowSplit: r.allow_split, active: r.is_active,
      wholesalePrice: Number(r.wholesale_price), salePrice: Number(r.sale_price)
    })),
    cashBalance: Number(cash.rows[0].balance),
    grand: {
      sales: ledger.r2(g.sales), profit: ledger.r2(g.profit),
      purchases: ledger.r2(g.purchases), expenses: ledger.r2(g.expenses),
      netProfit: ledger.r2(g.profit - g.expenses)
    },
    serverTime: new Date().toISOString()
  });
}));

/* ───────────── النسخ الاحتياطي الكامل ───────────── */
router.get("/backup", wrap(async (_req, res) => {
  const [settings, days, daySummaries, invoices, invoiceItems, returns, purchases, purchaseItems,
         expenses, cashMoves, products, categories, barcodes, vials, vialMoves, openOps, stockMoves,
         stocktakes, stocktakeItems, notes, names] =
    await Promise.all([
      db.query("SELECT * FROM settings"),
      db.query("SELECT * FROM days ORDER BY day_date"),
      db.query("SELECT * FROM day_summaries"),
      db.query("SELECT * FROM invoices ORDER BY id"),
      db.query("SELECT * FROM invoice_items ORDER BY id"),
      db.query("SELECT * FROM sale_returns ORDER BY id"),
      db.query("SELECT * FROM purchases ORDER BY id"),
      db.query("SELECT * FROM purchase_items ORDER BY id"),
      db.query("SELECT * FROM expenses ORDER BY id"),
      db.query("SELECT * FROM cash_movements ORDER BY id"),
      db.query("SELECT * FROM products ORDER BY id"),
      db.query("SELECT * FROM categories ORDER BY id"),
      db.query("SELECT * FROM product_barcodes ORDER BY id"),
      db.query("SELECT * FROM vials ORDER BY id"),
      db.query("SELECT * FROM vial_movements ORDER BY id"),
      db.query("SELECT * FROM open_operations ORDER BY id"),
      db.query("SELECT * FROM stock_movements ORDER BY id"),
      db.query("SELECT * FROM stocktakes ORDER BY id"),
      db.query("SELECT * FROM stocktake_items ORDER BY id"),
      db.query("SELECT * FROM notes ORDER BY id"),
      db.query("SELECT * FROM product_names ORDER BY id")
    ]);
  res.json({
    app: "Yousef Perfumes",
    schema: 5,
    exportedAt: new Date().toISOString(),
    data: {
      settings: settings.rows, days: days.rows, day_summaries: daySummaries.rows,
      invoices: invoices.rows, invoice_items: invoiceItems.rows, sale_returns: returns.rows,
      purchases: purchases.rows, purchase_items: purchaseItems.rows,
      expenses: expenses.rows, cash_movements: cashMoves.rows,
      products: products.rows, categories: categories.rows, product_barcodes: barcodes.rows,
      vials: vials.rows, vial_movements: vialMoves.rows, open_operations: openOps.rows,
      stock_movements: stockMoves.rows, stocktakes: stocktakes.rows, stocktake_items: stocktakeItems.rows,
      notes: notes.rows, product_names: names.rows
    }
  });
}));

/* ───────────── الاسترجاع ───────────── */
router.post("/backup/restore", wrap(async (req, res) => {
  if (String(req.body && req.body.confirm) !== "RESTORE") {
    throw new HttpError(400, "confirm_required", 'Send { "confirm": "RESTORE" }');
  }
  const data = req.body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.days) || !Array.isArray(data.invoices)) {
    throw new HttpError(400, "backup_invalid", "ملف النسخة الاحتياطية غير صالح");
  }
  /* نسخ الأنظمة القديمة (هواتف/IMEI) لا تتوافق مع نموذج العطور */
  const legacy = Array.isArray(data.phone_units) || (Array.isArray(data.products) && data.products.some(p => "kind" in p));
  if (legacy) {
    throw new HttpError(400, "backup_incompatible", "هذه النسخة من نظام قديم (هواتف) وغير متوافقة مع يوسف للعطور");
  }
  const t = (name) => Array.isArray(data[name]) ? data[name] : [];

  await db.tx(async client => {
    /* مسح شامل ثم إدراج */
    await client.query(`TRUNCATE sale_returns, invoice_items, invoices, purchase_items, purchases,
                        expenses, cash_movements, stocktake_items, stocktakes, stock_movements,
                        vial_movements, open_operations, product_barcodes, vials,
                        products, categories, day_summaries, notes, days, product_names
                        RESTART IDENTITY CASCADE`);
    /* الأعمدة المولّدة (GENERATED) تُستبعد من الإدراج — تُحسب تلقائياً */
    const GENERATED = {
      invoices: ["total", "profit"],
      invoice_items: ["line_total", "line_cost"],
      purchase_items: ["line_total"],
      stocktake_items: ["diff"]
    };
    const ins = async (table, rows, cols) => {
      const skip = GENERATED[table] || [];
      console.log("[restore]", table, rows.length, "rows");
      for (const r of rows) {
        const keys = cols.filter(c => !skip.includes(c) && r[c] !== undefined);
        if (!keys.length) continue;
        const vals = keys.map(c => {
          const v = r[c];
          if (Array.isArray(v)) return v;                    /* مصفوفات text[] — تُمرر كما هي */
          if (v !== null && typeof v === "object" && !(v instanceof Date)) {
            return JSON.stringify(v);                        /* jsonb مثل snapshot */
          }
          return v;
        });
        await client.query(
          `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")})`, vals);
      }
    };
    await ins("categories", t("categories"), ["id", "name", "sort_order", "code", "created_at"]);
    await ins("days", t("days"), ["id", "day_date", "day_name", "status", "opened_at", "closed_at"]);
    await ins("day_summaries", t("day_summaries"), ["day_id", "snapshot", "cash_balance", "created_at"]);
    await ins("products", t("products"),
      ["id", "name", "brand", "size_ml", "product_type", "category_id", "barcode", "image_url", "notes",
       "quantity", "purchase_price", "sale_price", "ml_price", "allow_split", "open_ml", "open_cost_per_ml",
       "min_stock", "is_active", "created_at", "updated_at"]);
    await ins("product_barcodes", t("product_barcodes"),
      ["id", "product_id", "barcode", "wholesale_price", "sale_price", "created_at"]);
    await ins("vials", t("vials"),
      ["id", "name", "size_ml", "cost", "sale_price", "quantity", "min_stock", "is_active", "created_at", "updated_at"]);
    await ins("invoices", t("invoices"),
      ["id", "day_id", "invoice_no", "payment_method", "debtor_name", "discount", "subtotal", "cost_total",
       "refunded", "refunded_profit", "status", "notes", "sale_date", "sale_time", "created_at", "updated_at"]);
    await ins("invoice_items", t("invoice_items"),
      ["id", "invoice_id", "product_id", "product_name", "qty", "qty_returned",
       "wholesale_price", "selling_price", "sale_type", "ml_qty", "ml_price", "ml_cost",
       "vial_id", "vial_name", "vial_size_ml", "vial_qty", "vial_cost", "vial_price", "created_at"]);
    await ins("sale_returns", t("sale_returns"),
      ["id", "invoice_id", "item_id", "day_id", "qty", "amount", "profit_adjust", "reason", "restocked", "returned_at"]);
    await ins("purchases", t("purchases"),
      ["id", "day_id", "purchase_no", "total", "paid", "notes", "purchase_date", "status", "created_at", "updated_at"]);
    await ins("purchase_items", t("purchase_items"),
      ["id", "purchase_id", "item_type", "product_id", "vial_id", "product_name", "qty", "unit_cost", "line_total", "created_at"]);
    await ins("expenses", t("expenses"),
      ["id", "day_id", "category", "amount", "expense_date", "notes", "created_at", "updated_at"]);
    await ins("cash_movements", t("cash_movements"),
      ["id", "day_id", "direction", "method", "category", "amount", "description", "ref_type", "ref_id", "moved_at", "created_at"]);
    await ins("stock_movements", t("stock_movements"),
      ["id", "product_id", "qty_in", "qty_out", "stock_kind", "ml_in", "ml_out", "reason", "ref_type", "ref_id", "note", "day_id", "moved_at"]);
    await ins("vial_movements", t("vial_movements"),
      ["id", "vial_id", "qty_in", "qty_out", "reason", "ref_type", "ref_id", "note", "day_id", "moved_at"]);
    await ins("open_operations", t("open_operations"),
      ["id", "product_id", "product_name", "pieces", "size_ml", "ml_added", "piece_cost", "cost_per_ml",
       "sealed_before", "sealed_after", "open_before", "open_after", "avg_cost_after", "note", "day_id", "created_at"]);
    await ins("stocktakes", t("stocktakes"), ["id", "day_id", "note", "lines", "diff_lines", "created_at"]);
    await ins("stocktake_items", t("stocktake_items"),
      ["id", "stocktake_id", "item_type", "product_id", "vial_id", "product_name", "system_qty", "counted_qty"]);
    await ins("notes", t("notes"), ["id", "day_id", "note_text", "note_date", "note_time", "created_at"]);
    await ins("product_names", t("product_names"), ["id", "name", "normalized_name", "usage_count", "last_used_at", "created_at"]);

    /* مزامنة المتتاليات مع أكبر معرف مُدرج */
    for (const seq of ["invoices_id_seq", "invoice_items_id_seq", "sale_returns_id_seq", "purchases_id_seq",
                       "purchase_items_id_seq", "expenses_id_seq", "cash_movements_id_seq", "products_id_seq",
                       "categories_id_seq", "product_barcodes_id_seq", "vials_id_seq", "vial_movements_id_seq",
                       "open_operations_id_seq", "stock_movements_id_seq",
                       "stocktakes_id_seq", "stocktake_items_id_seq", "days_id_seq", "notes_id_seq", "product_names_id_seq"]) {
      const table = seq.replace("_id_seq", "");
      await client.query(
        `SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
    }
    const maxInv = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(invoice_no, '\\D', '', 'g'), '')::bigint), 1) AS m FROM invoices`);
    await client.query("SELECT setval('invoice_seq', $1)", [maxInv.rows[0].m]);
    const maxPur = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(purchase_no, '\\D', '', 'g'), '')::bigint), 1) AS m FROM purchases`);
    await client.query("SELECT setval('purchase_seq', $1)", [maxPur.rows[0].m]);
    /* ضمان وجود تصنيفي صيفية/شتوية بعد الاسترجاع */
    await seedCategories(client);
  });
  res.json({ ok: true, restored: true });
}));

/* ───────────── استيراد بيانات النسخة القديمة (مرة واحدة) ───────────── */
router.post("/import", wrap(async (req, res) => {
  const existing = await db.query("SELECT (SELECT count(*) FROM invoices) s, (SELECT count(*) FROM days) d");
  if (Number(existing.rows[0].s) > 0 || Number(existing.rows[0].d) > 0) {
    throw new HttpError(409, "ledger_not_empty", "The server already holds ledger data");
  }
  const sessions = Array.isArray(req.body.sessions) ? req.body.sessions : [];
  const sales = Array.isArray(req.body.sales) ? req.body.sales : [];
  const notes = Array.isArray(req.body.notes) ? req.body.notes : [];
  const names = Array.isArray(req.body.productNames) ? req.body.productNames : [];

  const counts = await db.tx(async client => {
    const dayIdByOld = new Map();
    for (const s of sessions) {
      const date = isoDate(s.date);
      const status = s.status === "open" ? "open" : "closed";
      const { rows } = await client.query(
        `INSERT INTO days (day_date, day_name, status, opened_at, closed_at)
         VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), $5::timestamptz)
         ON CONFLICT (day_date) DO UPDATE SET day_name = EXCLUDED.day_name
         RETURNING id`,
        [date, cleanText(s.dayName || dayNameFor(date), { field: "dayName", max: 40 }), status, s.startedAt || null, s.closedAt || null]);
      dayIdByOld.set(String(s.id), rows[0].id);
    }
    for (const n of names) {
      const name = String(n || "").replace(/\s+/g, " ").trim();
      const norm = normalizeName(name);
      if (!norm) continue;
      await client.query(
        `INSERT INTO product_names (name, normalized_name) VALUES ($1,$2)
         ON CONFLICT (normalized_name) DO NOTHING`, [name, norm]);
    }
    let saleCount = 0;
    for (const s of [...sales].reverse()) {
      const dayId = dayIdByOld.get(String(s.sessionId));
      if (!dayId) continue;
      const qty = Math.max(1, parseInt(s.qty, 10) || 1);
      const price = Math.max(0, Number(s.price) || 0);
      const wholesale = Math.max(0, Number(s.wholesale) || 0);
      const payment = ["cash", "card", "unpaid"].includes(s.payment) ? s.payment : "cash";
      const subtotal = Math.round(price * qty * 100) / 100;
      const cost = Math.round(wholesale * qty * 100) / 100;
      const inv = await client.query(
        `INSERT INTO invoices (day_id, invoice_no, payment_method, subtotal, cost_total,
                               sale_date, sale_time, created_at, updated_at)
         VALUES ($1, 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0'), $2,$3,$4,$5,
                 COALESCE($6::timestamptz, now()), COALESCE($6::timestamptz, now()), now())
         RETURNING id`, [dayId, payment, subtotal, cost, isoDate(s.date), s.time || null]);
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_name, qty, wholesale_price, selling_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [inv.rows[0].id, cleanText(s.product, { field: "product", max: 120 }), qty, wholesale, price]);
      saleCount++;
    }
    let noteCount = 0;
    for (const n of [...notes].reverse()) {
      const dayId = dayIdByOld.get(String(n.sessionId));
      const text = String(n.text || "").replace(/\s+/g, " ").trim();
      if (!dayId || !text) continue;
      await client.query(
        `INSERT INTO notes (day_id, note_text, note_date, note_time)
         VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()))`,
        [dayId, text, isoDate(n.date), n.time || null]);
      noteCount++;
    }
    return { days: dayIdByOld.size, sales: saleCount, notes: noteCount, productNames: names.length };
  });
  res.status(201).json({ imported: counts });
}));

/* ───────────── منطقة الخطر: حذف كل البيانات ───────────── */
router.delete("/data", wrap(async (req, res) => {
  if (String(req.body && req.body.confirm) !== "DELETE") {
    throw new HttpError(400, "confirm_required", 'Send { "confirm": "DELETE" }');
  }
  await db.tx(async client => {
    await client.query(`TRUNCATE sale_returns, invoice_items, invoices, purchase_items, purchases,
                        expenses, cash_movements, stocktake_items, stocktakes, stock_movements,
                        vial_movements, open_operations, product_barcodes, vials,
                        products, categories, day_summaries, notes, days, product_names
                        RESTART IDENTITY CASCADE`);
    await client.query("SELECT setval('invoice_seq', 1, false)");
    await client.query("SELECT setval('purchase_seq', 1, false)");
    /* تصنيفا صيفية/شتوية يُعادان دائماً */
    await seedCategories(client);
  });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.seedCategories = seedCategories;
