"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/purchases — المشتريات (بدون نظام موردين)
   • شراء عطور مغلقة  → يزيد الرصيد المغلق (قطع) ويحدّث متوسط تكلفة العلبة
   • شراء عبوات تقسيم → يزيد مخزون العبوات ويحدّث متوسط تكلفتها
   كل عملية شراء: زيادة المخزون + تحديث متوسط التكلفة المرجّح
   + حركة مخزون + حركة صندوق (إن كانت مدفوعة) + سجل قابل للمراجعة
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, toInt, toMoney } = require("../lib/http");
const { mapPurchase } = require("../lib/map");
const { resolveCategory } = require("./inventory");

const router = express.Router();
const r2 = ledger.r2;

/* متوسط التكلفة المرجّح — sign: +1 عند الشراء، -1 عند العكس */
function weightedAvg(oldQty, oldAvg, qty, cost, sign) {
  const after = oldQty + sign * qty;
  if (after <= 0) return Number(oldAvg);            /* رصيد صفري: يبقى المتوسط التاريخي */
  const totalValue = oldQty * Number(oldAvg) + sign * qty * Number(cost);
  return Math.max(0, Math.round((totalValue / after) * 100) / 100);
}

/* بند الشراء: عطر (موجود أو جديد يُنشأ ضمن العملية) أو عبوة تقسيم (موجودة أو جديدة) */
async function resolveItem(client, raw) {
  const qty = toInt(raw.qty, { field: "qty" });
  const unitCost = toMoney(raw.unitCost ?? raw.cost, { field: "unitCost" });

  /* ── عبوات التقسيم ── */
  if (raw.type === "vial" || raw.vialId || raw.newVial) {
    let vialId = raw.vialId ? toInt(raw.vialId, { field: "vialId", min: 1 }) : null;
    if (!vialId) {
      const nv = raw.newVial || {};
      const name = cleanText(nv.name || raw.name, { field: "name", max: 80 });
      const size = Math.round(parseFloat(nv.sizeMl) * 100) / 100;
      if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "sizeMl_invalid", "حجم العبوة (مل) غير صحيح");
      const created = await client.query(
        `INSERT INTO vials (name, size_ml, sale_price, min_stock) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, size, toMoney(nv.price ?? nv.salePrice ?? 0, { field: "price" }),
         toInt(nv.minStock ?? 10, { field: "minStock", min: 0, max: 1000000 })]);
      vialId = created.rows[0].id;
    }
    const vial = (await client.query("SELECT * FROM vials WHERE id = $1 FOR UPDATE", [vialId])).rows[0];
    if (!vial) throw new HttpError(404, "vial_not_found", "العبوة غير موجودة");
    return { type: "vial", vial, qty, unitCost };
  }

  /* ── عطور مغلقة ── */
  let productId = raw.productId ? toInt(raw.productId, { field: "productId", min: 1 }) : null;
  if (!productId) {
    /* منتج جديد من داخل فاتورة الشراء */
    const np = raw.newProduct || {};
    const name = cleanText(np.name || raw.name, { field: "name", max: 120 });
    const categoryId = await resolveCategory(client, { season: np.season, categoryId: np.categoryId }, null)
      .catch(() => null);
    const barcode = String(np.barcode || "").trim() || null;
    if (barcode) {
      const dupe = await client.query(
        `SELECT id FROM products WHERE barcode = $1 UNION ALL SELECT product_id FROM product_barcodes WHERE barcode = $1`, [barcode]);
      if (dupe.rows.length) throw new HttpError(409, "barcode_taken", "الباركود مستخدم لمنتج آخر");
    }
    const sizeMl = np.sizeMl ? Math.round(parseFloat(np.sizeMl) * 100) / 100 : null;
    if (np.sizeMl && !(sizeMl > 0)) throw new HttpError(400, "sizeMl_invalid", "الحجم الأصلي غير صحيح");
    const allowSplit = !!np.allowSplit && !!sizeMl;
    const created = await client.query(
      `INSERT INTO products (name, brand, size_ml, product_type, category_id, barcode,
                             sale_price, ml_price, allow_split, min_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name,
       np.brand ? cleanText(np.brand, { field: "brand", max: 80, required: false }) : null,
       sizeMl,
       np.productType ? cleanText(np.productType, { field: "productType", max: 60, required: false }) : null,
       categoryId, barcode,
       toMoney(np.salePrice ?? 0, { field: "salePrice" }),
       toMoney(np.mlPrice ?? 0, { field: "mlPrice" }),
       allowSplit,
       toInt(np.minStock ?? 3, { field: "minStock", min: 0 })]);
    productId = created.rows[0].id;
  }

  const prod = (await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId])).rows[0];
  if (!prod) throw new HttpError(404, "product_not_found", "المنتج غير موجود");
  return { type: "perfume", product: prod, qty, unitCost };
}

/* تطبيق بنود الشراء: مخزون + تكلفة + حركة */
async function applyItems(client, purchaseId, dayId, items) {
  let total = 0;
  for (const it of items) {
    total += r2(it.qty * it.unitCost);

    if (it.type === "vial") {
      const avg = weightedAvg(it.vial.quantity, it.vial.cost, it.qty, it.unitCost, +1);
      await client.query(
        `INSERT INTO purchase_items (purchase_id, item_type, vial_id, product_name, qty, unit_cost)
         VALUES ($1,'vial',$2,$3,$4,$5)`,
        [purchaseId, it.vial.id, it.vial.name, it.qty, it.unitCost]);
      await client.query("UPDATE vials SET quantity = quantity + $1, cost = $2, updated_at = now() WHERE id = $3",
        [it.qty, avg, it.vial.id]);
      await ledger.recordVialMove(client, {
        vialId: it.vial.id, qtyIn: it.qty, reason: "purchase",
        refType: "purchase", refId: purchaseId, note: "فاتورة شراء عبوات", dayId
      });
      it.vial.quantity += it.qty;
      it.vial.cost = avg;
      continue;
    }

    const avg = weightedAvg(it.product.quantity, it.product.purchase_price, it.qty, it.unitCost, +1);
    await client.query(
      `INSERT INTO purchase_items (purchase_id, item_type, product_id, product_name, qty, unit_cost)
       VALUES ($1,'perfume',$2,$3,$4,$5)`,
      [purchaseId, it.product.id, it.product.name, it.qty, it.unitCost]);
    await client.query("UPDATE products SET quantity = quantity + $1, purchase_price = $2, updated_at = now() WHERE id = $3",
      [it.qty, avg, it.product.id]);
    await ledger.recordStockMove(client, {
      productId: it.product.id, qtyIn: it.qty, reason: "purchase",
      refType: "purchase", refId: purchaseId, note: "فاتورة شراء", dayId
    });
    /* الكمية الجديدة تُقرأ للبند التالي لو تكرر نفس المنتج */
    it.product.quantity += it.qty;
    it.product.purchase_price = avg;
  }
  return r2(total);
}

/* عكس بنود الشراء (تعديل/إلغاء) — يرفض لو استُهلك المخزون */
async function reverseItems(client, purchaseId) {
  const { rows: items } = await client.query(
    "SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id", [purchaseId]);
  const dayId = (await ledger.getOpenDay(client) || {}).id || null;
  /* تحقق: الكمية الحالية كافية (تجميع البنود المكررة لنفس الصنف) */
  const need = new Map();
  for (const it of items) {
    const key = (it.item_type === "vial" ? "v" : "p") + (it.vial_id || it.product_id);
    need.set(key, (need.get(key) || 0) + it.qty);
  }
  for (const it of items) {
    const isVial = it.item_type === "vial";
    const row = (await client.query(
      `SELECT quantity FROM ${isVial ? "vials" : "products"} WHERE id = $1 FOR UPDATE`,
      [isVial ? it.vial_id : it.product_id])).rows[0];
    const key = (isVial ? "v" : "p") + (it.vial_id || it.product_id);
    if (!row || row.quantity < need.get(key)) {
      throw new HttpError(409, "stock_consumed",
        "تم استهلاك جزء من " + it.product_name + " — لا يمكن عكس العملية");
    }
  }
  /* العكس بترتيب معاكس ليبقى المتوسط المرجّح سليماً */
  for (const it of items.slice().reverse()) {
    if (it.item_type === "vial") {
      const v = (await client.query("SELECT * FROM vials WHERE id = $1 FOR UPDATE", [it.vial_id])).rows[0];
      const avg = weightedAvg(v.quantity, v.cost, it.qty, it.unit_cost, -1);
      await client.query("UPDATE vials SET quantity = quantity - $1, cost = $2, updated_at = now() WHERE id = $3",
        [it.qty, avg, v.id]);
      await ledger.recordVialMove(client, {
        vialId: v.id, qtyOut: it.qty, reason: "adjustment",
        refType: "purchase", refId: purchaseId, note: "عكس فاتورة شراء", dayId
      });
      continue;
    }
    const prod = (await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [it.product_id])).rows[0];
    const avg = weightedAvg(prod.quantity, prod.purchase_price, it.qty, it.unit_cost, -1);
    await client.query("UPDATE products SET quantity = quantity - $1, purchase_price = $2, updated_at = now() WHERE id = $3",
      [it.qty, avg, prod.id]);
    await ledger.recordStockMove(client, {
      productId: prod.id, qtyOut: it.qty, reason: "adjustment",
      refType: "purchase", refId: purchaseId, note: "عكس فاتورة شراء", dayId
    });
  }
}

async function loadPurchase(client, id, forUpdate) {
  const { rows } = await client.query(
    `SELECT p.*, (SELECT count(*) FROM purchase_items x WHERE x.purchase_id = p.id) AS items_count
       FROM purchases p WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [id]);
  if (!rows.length) throw new HttpError(404, "purchase_not_found", "Purchase not found");
  return rows[0];
}
async function purchaseWithItems(id) {
  const p = await loadPurchase(db, id, false);
  const items = await db.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id", [id]);
  return mapPurchase(p, items.rows);
}

/* ───────────── سجل المشتريات ───────────── */
router.get("/", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.date)  { params.push(req.query.date); where.push(`p.purchase_date = $${params.length}`); }
  if (req.query.dayId) { params.push(req.query.dayId); where.push(`p.day_id = $${params.length}`); }
  if (req.query.q) {
    params.push("%" + String(req.query.q).trim().toLowerCase() + "%");
    where.push(`(lower(p.purchase_no) LIKE $${params.length}
                 OR EXISTS (SELECT 1 FROM purchase_items x WHERE x.purchase_id = p.id
                             AND lower(x.product_name) LIKE $${params.length}))`);
  }
  const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 1000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT p.*, (SELECT count(*) FROM purchase_items x WHERE x.purchase_id = p.id) AS items_count
       FROM purchases p ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`, params);
  res.json({ purchases: rows.map(r => mapPurchase(r, null)) });
}));

router.get("/:id(\\d+)", wrap(async (req, res) => {
  res.json({ purchase: await purchaseWithItems(req.params.id) });
}));

/* ───────────── تسجيل شراء جديد ───────────── */
router.post("/", wrap(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) throw new HttpError(400, "items_required", "أضف منتجًا واحدًا على الأقل");

  const id = await db.tx(async client => {
    const day = req.body.dayId
      ? await ledger.assertDayOpen(req.body.dayId, client)
      : await ledger.requireOpenDay(client);
    const paid = req.body.paid === undefined ? true : !!req.body.paid;
    const notes = req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 400, required: false }) : null;

    const purchase = (await client.query(
      `INSERT INTO purchases (day_id, purchase_no, paid, notes, purchase_date)
       VALUES ($1, 'PUR-' || lpad(nextval('purchase_seq')::text, 5, '0'), $2, $3, $4) RETURNING *`,
      [day.id, paid, notes, day.day_date])).rows[0];

    const items = [];
    for (const raw of rawItems) items.push(await resolveItem(client, raw));
    const total = await applyItems(client, purchase.id, day.id, items);
    await client.query("UPDATE purchases SET total = $1 WHERE id = $2", [total, purchase.id]);

    if (paid && total > 0) {
      await ledger.recordCashMove(client, {
        dayId: day.id, direction: "out", method: "cash", category: "purchase",
        amount: total, description: "فاتورة شراء " + purchase.purchase_no,
        refType: "purchase", refId: purchase.id
      });
    }
    return purchase.id;
  });
  res.status(201).json({ purchase: await purchaseWithItems(id) });
}));

/* ───────────── تعديل فاتورة شراء ───────────── */
router.put("/:id(\\d+)", wrap(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) throw new HttpError(400, "items_required", "أضف منتجًا واحدًا على الأقل");
  const id = await db.tx(async client => {
    const p = await loadPurchase(client, req.params.id, true);
    await ledger.assertDayOpen(p.day_id, client);
    if (p.status === "cancelled") throw new HttpError(409, "purchase_cancelled", "فاتورة الشراء ملغاة");

    await reverseItems(client, p.id);
    await client.query("DELETE FROM purchase_items WHERE purchase_id = $1", [p.id]);
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'purchase' AND ref_id = $1", [p.id]);

    const day = await ledger.dayById(p.day_id, client);
    const paid = req.body.paid === undefined ? p.paid : !!req.body.paid;
    const notes = req.body.notes !== undefined
      ? (req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 400, required: false }) : null)
      : p.notes;

    const items = [];
    for (const raw of rawItems) items.push(await resolveItem(client, raw));
    const total = await applyItems(client, p.id, day.id, items);
    await client.query("UPDATE purchases SET total = $1, paid = $2, notes = $3, updated_at = now() WHERE id = $4",
      [total, paid, notes, p.id]);
    if (paid && total > 0) {
      await ledger.recordCashMove(client, {
        dayId: day.id, direction: "out", method: "cash", category: "purchase",
        amount: total, description: "فاتورة شراء " + p.purchase_no,
        refType: "purchase", refId: p.id
      });
    }
    return p.id;
  });
  res.json({ purchase: await purchaseWithItems(id) });
}));

/* ───────────── إلغاء فاتورة شراء ───────────── */
router.post("/:id(\\d+)/cancel", wrap(async (req, res) => {
  const id = await db.tx(async client => {
    const p = await loadPurchase(client, req.params.id, true);
    await ledger.assertDayOpen(p.day_id, client);
    if (p.status === "cancelled") throw new HttpError(409, "purchase_cancelled", "الفاتورة ملغاة بالفعل");

    await reverseItems(client, p.id);
    if (p.paid && Number(p.total) > 0) {
      await ledger.recordCashMove(client, {
        dayId: p.day_id, direction: "in", method: "cash", category: "purchase",
        amount: Number(p.total), description: "إلغاء فاتورة شراء " + p.purchase_no,
        refType: "purchase", refId: p.id
      });
    }
    await client.query("UPDATE purchases SET status = 'cancelled', updated_at = now() WHERE id = $1", [p.id]);
    return p.id;
  });
  res.json({ purchase: await purchaseWithItems(id) });
}));

/* ───────────── حذف نهائي ───────────── */
router.delete("/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const p = await loadPurchase(client, req.params.id, true);
    await ledger.assertDayOpen(p.day_id, client);
    if (p.status !== "cancelled") {
      await reverseItems(client, p.id);
      if (p.paid && Number(p.total) > 0) {
        await ledger.recordCashMove(client, {
          dayId: p.day_id, direction: "in", method: "cash", category: "purchase",
          amount: Number(p.total), description: "حذف فاتورة شراء " + p.purchase_no,
          refType: "purchase", refId: p.id
        });
      }
    }
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'purchase' AND ref_id = $1", [p.id]);
    await client.query("DELETE FROM purchases WHERE id = $1", [p.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
