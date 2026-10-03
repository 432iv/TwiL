"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/inventory — مخزون العطور
     • عطور: رصيد مغلق (قطع) + رصيد مفتوح للتقسيم (مل) + أسعار مستقلة
     • "تخصيص للتقسيم": تحويل N علبة مغلقة إلى N × حجمها مل مفتوحة
     • عبوات التقسيم (vials): مخزون وتكلفة وسعر
     • حركة المخزون الموحّدة (مغلق / مفتوح / عبوات) + الجرد
   كل تغيير كمية يمر عبر حركة مخزون موثقة.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const perfume = require("../lib/perfume");
const { wrap, HttpError, cleanText, toInt, toMoney } = require("../lib/http");
const { mapProduct, mapCategory, mapVial, mapOpenOp, mapStockMove, mapStocktake, mapStocktakeItem } = require("../lib/map");

const router = express.Router();
const r2 = ledger.r2;

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.code AS category_code FROM products p
  LEFT JOIN categories c ON c.id = p.category_id`;

async function getProduct(client, id, forUpdate) {
  const { rows } = await client.query(
    `SELECT p.*, c.name AS category_name, c.code AS category_code FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = $1 ${forUpdate ? "FOR UPDATE OF p" : ""}`, [id]);
  if (!rows.length) throw new HttpError(404, "product_not_found", "Product not found");
  return rows[0];
}

async function getVial(client, id, forUpdate) {
  const { rows } = await client.query(`SELECT * FROM vials WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [id]);
  if (!rows.length) throw new HttpError(404, "vial_not_found", "العبوة غير موجودة");
  return rows[0];
}

/* التصنيف: صيفية / شتوية فقط — يُقبل categoryId أو season (summer|winter) */
async function resolveCategory(client, body, fallback) {
  if (body.season !== undefined && body.season !== null && body.season !== "") {
    const { rows } = await client.query("SELECT id FROM categories WHERE code = $1", [String(body.season)]);
    if (!rows.length) throw new HttpError(400, "season_invalid", "التصنيف يجب أن يكون صيفية أو شتوية");
    return rows[0].id;
  }
  if (body.categoryId !== undefined) {
    if (!body.categoryId) return null;
    const id = toInt(body.categoryId, { field: "categoryId", min: 1 });
    const { rows } = await client.query("SELECT id FROM categories WHERE id = $1", [id]);
    if (!rows.length) throw new HttpError(404, "category_not_found", "التصنيف غير موجود");
    return id;
  }
  return fallback === undefined ? null : fallback;
}

/* مل / حجم: رقم موجب بمنزلتين عشريتين */
function toMl(value, { field, min = 0.01, max = 100000, allowNull = false }) {
  if ((value === undefined || value === null || value === "") && allowNull) return null;
  const n = perfume.r2(parseFloat(value));
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field}_invalid`, `${field} must be ${min}..${max}`);
  return n;
}

async function assertBarcodeFree(client, barcode, exceptId) {
  const code = String(barcode || "").trim();
  if (!code) return null;
  const { rows } = await client.query(
    `SELECT id FROM products WHERE barcode = $1 AND id <> COALESCE($2::bigint, 0)
     UNION ALL
     SELECT product_id FROM product_barcodes WHERE barcode = $1 AND product_id <> COALESCE($2::bigint, 0)`,
    [code, exceptId || null]);
  if (rows.length) throw new HttpError(409, "barcode_taken", "هذا الباركود مستخدم لمنتج آخر");
  return code || null;
}

/* مزامنة عمود products.barcode (النموذج البسيط) مع جدول product_barcodes (مصدر الحقيقة
   لكل عمليات البحث ومنع التكرار)، حتى تبقى الطريقتان متوافقتين تمامًا دون تكرار أو تضارب. */
async function syncDefaultBarcode(client, productId, oldBarcode, newBarcode, wholesalePrice, salePrice) {
  const oldCode = oldBarcode ? String(oldBarcode).trim() : "";
  const newCode = newBarcode ? String(newBarcode).trim() : "";
  if (oldCode && oldCode !== newCode) {
    await client.query("DELETE FROM product_barcodes WHERE product_id = $1 AND barcode = $2", [productId, oldCode]);
  }
  if (newCode) {
    await client.query(
      `INSERT INTO product_barcodes (product_id, barcode, wholesale_price, sale_price)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (barcode) DO UPDATE SET wholesale_price = $3, sale_price = $4`,
      [productId, newCode, wholesalePrice, salePrice]);
  }
}

/* ───────────── المخزون كاملاً + التصنيفات + العبوات ───────────── */
router.get("/", wrap(async (_req, res) => {
  const [products, categories, vials] = await Promise.all([
    db.query(PRODUCT_SELECT + " ORDER BY p.is_active DESC, p.name"),
    db.query("SELECT * FROM categories ORDER BY sort_order, id"),
    db.query("SELECT * FROM vials ORDER BY is_active DESC, size_ml, name")
  ]);
  res.json({
    products: products.rows.map(mapProduct),
    categories: categories.rows.map(mapCategory),
    vials: vials.rows.map(mapVial)
  });
}));

/* ───────────── بحث سريع للمنتجات (نماذج البيع والشراء) ───────────── */
router.get("/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/\s+/g, " ").trim();
  const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 25);
  if (!q) {
    const { rows } = await db.query(
      PRODUCT_SELECT + " WHERE p.is_active AND (p.quantity > 0 OR p.open_ml > 0) ORDER BY p.updated_at DESC LIMIT $1", [limit]);
    return res.json({ products: rows.map(mapProduct) });
  }
  const like = "%" + q.toLowerCase() + "%";
  const { rows } = await db.query(
    `SELECT p.*, c.name AS category_name, c.code AS category_code,
            (CASE
               WHEN lower(p.name) = $1 THEN 0
               WHEN lower(p.barcode) = $1 THEN 0
               WHEN EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND lower(b.barcode) = $1) THEN 0
               WHEN lower(p.name) LIKE $2 THEN 1
               WHEN lower(p.brand) LIKE $2 THEN 2
               WHEN lower(c.name) LIKE $2 THEN 2
               ELSE 3 END) AS rank
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active AND (lower(p.name) LIKE $2 OR lower(p.barcode) LIKE $2
             OR lower(p.brand) LIKE $2 OR lower(c.name) LIKE $2
             OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND lower(b.barcode) LIKE $2))
      ORDER BY rank, p.name LIMIT $3`, [q.toLowerCase(), like, limit]);
  res.json({ products: rows.map(mapProduct) });
}));

/* ───────────── قراءة حقول العطر من الطلب ───────────── */
function readPerfumeFields(body, prod) {
  const has = k => body[k] !== undefined;
  const text = (k, cur, max) => has(k) ? (body[k] ? cleanText(body[k], { field: k, max, required: false }) : null) : cur;
  const out = {
    brand:       text("brand", prod ? prod.brand : null, 80),
    productType: text("productType", prod ? prod.product_type : null, 60),
    notes:       text("notes", prod ? prod.notes : null, 500),
    sizeMl:      has("sizeMl") ? toMl(body.sizeMl, { field: "sizeMl", allowNull: true }) : (prod ? prod.size_ml : null),
    purchasePrice: toMoney(body.purchasePrice ?? (prod ? prod.purchase_price : 0), { field: "purchasePrice" }),
    salePrice:   toMoney(body.salePrice ?? (prod ? prod.sale_price : 0), { field: "salePrice" }),
    mlPrice:     toMoney(body.mlPrice ?? (prod ? prod.ml_price : 0), { field: "mlPrice" }),
    allowSplit:  has("allowSplit") ? !!body.allowSplit : (prod ? prod.allow_split : false),
    minStock:    toInt(body.minStock ?? (prod ? prod.min_stock : 3), { field: "minStock", min: 0, max: 100000 })
  };
  if (out.allowSplit && !out.sizeMl) {
    throw new HttpError(400, "size_required_for_split", "حدد الحجم الأصلي (مل) لتفعيل التقسيم");
  }
  return out;
}

/* ───────────── إضافة منتج (عطر) ───────────── */
router.post("/products", wrap(async (req, res) => {
  const product = await db.tx(async client => {
    const name = cleanText(req.body.name, { field: "name", max: 120 });
    const categoryId = await resolveCategory(client, req.body, null);
    const barcode = await assertBarcodeFree(client, req.body.barcode, null);
    const f = readPerfumeFields(req.body, null);

    const { rows } = await client.query(
      `INSERT INTO products (name, brand, size_ml, product_type, category_id, barcode, image_url, notes,
                             purchase_price, sale_price, ml_price, allow_split, min_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name, f.brand, f.sizeMl, f.productType, categoryId, barcode,
       req.body.image ? String(req.body.image).slice(0, 300000) : null, f.notes,
       f.purchasePrice, f.salePrice, f.mlPrice, f.allowSplit, f.minStock]);
    const prod = rows[0];
    await syncDefaultBarcode(client, prod.id, null, barcode, f.purchasePrice, f.salePrice);

    const day = await ledger.getOpenDay(client);
    /* رصيد افتتاحي مغلق (قطع) */
    const qty = toInt(req.body.qty ?? 0, { field: "qty", min: 0, max: 100000 });
    if (qty > 0) {
      await client.query("UPDATE products SET quantity = $1 WHERE id = $2", [qty, prod.id]);
      await ledger.recordStockMove(client, {
        productId: prod.id, qtyIn: qty, reason: "initial", note: "رصيد افتتاحي (مغلق)", dayId: day ? day.id : null
      });
    }
    /* رصيد افتتاحي مفتوح (مل) — يتطلب تفعيل التقسيم */
    const openMl = toMl(req.body.openMl ?? 0, { field: "openMl", min: 0 });
    if (openMl > 0) {
      if (!f.allowSplit) throw new HttpError(400, "split_not_allowed", "فعّل التقسيم أولاً لإدخال رصيد مفتوح");
      const costPerMl = f.sizeMl ? perfume.r4(f.purchasePrice / f.sizeMl) : 0;
      await perfume.addOpenMl(client, prod.id, openMl, costPerMl);
      await ledger.recordStockMove(client, {
        productId: prod.id, stockKind: "open", mlIn: openMl, reason: "initial",
        note: "رصيد افتتاحي (مفتوح)", dayId: day ? day.id : null
      });
    }
    return getProduct(client, prod.id, false);
  });
  res.status(201).json({ product: mapProduct(product) });
}));

/* ───────────── تعديل منتج ───────────── */
router.put("/products/:id(\\d+)", wrap(async (req, res) => {
  const product = await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);

    const name = cleanText(req.body.name ?? prod.name, { field: "name", max: 120 });
    const barcode = await assertBarcodeFree(client, req.body.barcode ?? prod.barcode, prod.id);
    const categoryId = await resolveCategory(client, req.body, prod.category_id);
    const f = readPerfumeFields(req.body, prod);
    if (!f.allowSplit && Number(prod.open_ml) > 0) {
      throw new HttpError(409, "open_stock_exists", "لا يمكن إيقاف التقسيم وما زال هناك رصيد مفتوح — بِعه أو سوِّه أولاً");
    }
    /* تكلفة المل المفتوح: تعديل يدوي اختياري (يتجاوز المتوسط المحسوب) */
    const openCost = req.body.openCostPerMl !== undefined
      ? perfume.r4(toMoney(req.body.openCostPerMl, { field: "openCostPerMl" })) : Number(prod.open_cost_per_ml);

    await client.query(
      `UPDATE products SET name=$1, brand=$2, size_ml=$3, product_type=$4, category_id=$5, barcode=$6,
              image_url=$7, notes=$8, purchase_price=$9, sale_price=$10, ml_price=$11, allow_split=$12,
              min_stock=$13, open_cost_per_ml=$14, is_active=$15, updated_at=now()
        WHERE id=$16`,
      [name, f.brand, f.sizeMl, f.productType, categoryId, barcode,
       req.body.image !== undefined ? (req.body.image ? String(req.body.image).slice(0, 300000) : null) : prod.image_url,
       f.notes, f.purchasePrice, f.salePrice, f.mlPrice, f.allowSplit, f.minStock, openCost,
       req.body.active === undefined ? prod.is_active : !!req.body.active,
       prod.id]);
    await syncDefaultBarcode(client, prod.id, prod.barcode, barcode, f.purchasePrice, f.salePrice);
    return getProduct(client, prod.id, false);
  });
  res.json({ product: mapProduct(product) });
}));

/* ───────────── خريطة كل الباركودات (للبحث الفوري من المتصفح دون اتصال بالخادم) ───────────── */
router.get("/barcodes", wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT pb.barcode, pb.product_id AS "productId",
            pb.wholesale_price AS "wholesalePrice", pb.sale_price AS "salePrice",
            p.name AS "productName", p.quantity AS qty, p.open_ml AS "openMl",
            p.allow_split AS "allowSplit", p.is_active AS active
       FROM product_barcodes pb JOIN products p ON p.id = pb.product_id
      ORDER BY pb.id`);
  res.json({
    barcodes: rows.map(r => ({
      barcode: r.barcode, productId: String(r.productId), productName: r.productName,
      qty: Number(r.qty), openMl: Number(r.openMl), allowSplit: r.allowSplit, active: r.active,
      wholesalePrice: Number(r.wholesalePrice), salePrice: Number(r.salePrice)
    }))
  });
}));

/* ───────────── حفظ دفعة تسجيل منتجات جديدة بالباركود (وضع تسجيل المنتجات) ─────────────
   منتج رئيسي واحد (جديد أو موجود بنفس الاسم بالضبط) + عدة مجموعات باركود، كل مجموعة
   لها سعر جملة/بيع خاص بها، والكمية الإجمالية تُضاف على مستوى المنتج فقط. */
router.post("/barcode-batches", wrap(async (req, res) => {
  const product = await db.tx(async client => {
    const name = cleanText(req.body.productName, { field: "productName", max: 120 });
    const qty = toInt(req.body.qty ?? 0, { field: "qty", min: 0, max: 1000000 });
    const groupsIn = Array.isArray(req.body.groups) ? req.body.groups : [];
    if (!groupsIn.length) throw new HttpError(400, "no_barcodes", "لا توجد باركودات في هذه الدفعة");

    const groups = [];
    const allCodes = [];
    for (const g of groupsIn) {
      const codes = Array.isArray(g.barcodes)
        ? [...new Set(g.barcodes.map(c => String(c || "").trim()).filter(Boolean))] : [];
      if (!codes.length) throw new HttpError(400, "empty_group", "إحدى المجموعات لا تحتوي على أي باركود صالح");
      const wholesalePrice = toMoney(g.wholesalePrice ?? 0, { field: "wholesalePrice" });
      const salePrice = toMoney(g.salePrice ?? 0, { field: "salePrice" });
      for (const c of codes) {
        if (allCodes.includes(c)) throw new HttpError(409, "duplicate_in_batch", "الباركود " + c + " مكرر داخل نفس الدفعة");
        allCodes.push(c);
      }
      groups.push({ codes, wholesalePrice, salePrice });
    }

    const dup = await client.query(
      `SELECT barcode FROM product_barcodes WHERE barcode = ANY($1::text[])
       UNION SELECT barcode FROM products WHERE barcode = ANY($1::text[])
       LIMIT 1`, [allCodes]);
    if (dup.rows.length) {
      throw new HttpError(409, "barcode_taken", "الباركود \"" + dup.rows[0].barcode + "\" مسجل مسبقًا لمنتج آخر");
    }

    const found = await client.query(
      `SELECT * FROM products WHERE lower(btrim(name)) = lower(btrim($1)) LIMIT 1`, [name]);
    let prod;
    if (found.rows.length) {
      prod = found.rows[0];
    } else {
      const categoryId = await resolveCategory(client, req.body);
      const ins = await client.query(
        `INSERT INTO products (name, size_ml, category_id, barcode, purchase_price, sale_price, min_stock)
         VALUES ($1,$2,$3,NULL,$4,$5,3) RETURNING *`,
        [name, toMl(req.body.sizeMl, { field: "sizeMl", allowNull: true }), categoryId,
         groups[0].wholesalePrice, groups[0].salePrice]);
      prod = ins.rows[0];
    }

    for (const g of groups) {
      for (const code of g.codes) {
        await client.query(
          `INSERT INTO product_barcodes (product_id, barcode, wholesale_price, sale_price) VALUES ($1,$2,$3,$4)`,
          [prod.id, code, g.wholesalePrice, g.salePrice]);
      }
    }

    if (qty > 0) {
      await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2", [qty, prod.id]);
      const day = await ledger.getOpenDay(client);
      await ledger.recordStockMove(client, {
        productId: prod.id, qtyIn: qty, reason: "initial",
        note: "دفعة باركود جديدة (" + allCodes.length + " باركود)", dayId: day ? day.id : null
      });
    }
    return getProduct(client, prod.id, false);
  });
  res.status(201).json({ product: mapProduct(product) });
}));

/* ───────────── حذف منتج — فقط إذا لم يسبق تحركه (وإلا: أرشفة) ───────────── */
router.delete("/products/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);
    const used = await client.query(
      `SELECT (SELECT count(*) FROM stock_movements WHERE product_id = $1) AS moves,
              (SELECT count(*) FROM invoice_items WHERE product_id = $1) AS sales,
              (SELECT count(*) FROM purchase_items WHERE product_id = $1) AS purchases,
              (SELECT count(*) FROM open_operations WHERE product_id = $1) AS opens`, [prod.id]);
    const u = used.rows[0];
    if (Number(u.moves) > 0 || Number(u.sales) > 0 || Number(u.purchases) > 0 || Number(u.opens) > 0) {
      throw new HttpError(409, "product_in_use",
        "لا يمكن حذف منتج له سجل حركة أو عمليات — أرشفه بدلاً من ذلك لتبقى التقارير سليمة");
    }
    await client.query("DELETE FROM products WHERE id = $1", [prod.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

/* ───────────── تسوية يدوية للكمية (مغلق بالقطعة أو مفتوح بالمل) ───────────── */
router.post("/products/:id(\\d+)/adjust", wrap(async (req, res) => {
  const out = await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);
    const day = await ledger.requireOpenDay(client);
    const direction = req.body.direction === "out" ? "out" : "in";
    const target = req.body.target === "open" ? "open" : "sealed";
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : "تسوية يدوية";

    if (target === "open") {
      const ml = toMl(req.body.ml ?? req.body.qty, { field: "ml" });
      if (direction === "in") {
        if (!prod.allow_split) throw new HttpError(400, "split_not_allowed", "فعّل التقسيم لهذا العطر أولاً");
        await perfume.addOpenMl(client, prod.id, ml, perfume.mlCostOf(prod));
        await ledger.recordStockMove(client, { productId: prod.id, stockKind: "open", mlIn: ml, reason: "adjustment", note, dayId: day.id });
      } else {
        if (perfume.mlGt(ml, prod.open_ml)) throw new HttpError(400, "open_stock_insufficient", "المتوفر المفتوح " + prod.open_ml + " مل");
        await client.query("UPDATE products SET open_ml = open_ml - $1, updated_at = now() WHERE id = $2", [ml, prod.id]);
        await ledger.recordStockMove(client, { productId: prod.id, stockKind: "open", mlOut: ml, reason: "adjustment", note, dayId: day.id });
      }
    } else {
      const qty = toInt(req.body.qty, { field: "qty" });
      if (direction === "in") {
        await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2", [qty, prod.id]);
        await ledger.recordStockMove(client, { productId: prod.id, qtyIn: qty, reason: "adjustment", note, dayId: day.id });
      } else {
        if (prod.quantity < qty) throw new HttpError(400, "stock_insufficient", "الكمية المغلقة المتوفرة " + prod.quantity);
        await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2", [qty, prod.id]);
        await ledger.recordStockMove(client, { productId: prod.id, qtyOut: qty, reason: "adjustment", note, dayId: day.id });
      }
    }
    return getProduct(client, prod.id, false);
  });
  res.json({ product: mapProduct(out) });
}));

/* ───────────── تخصيص للتقسيم: علب مغلقة → مل مفتوح ─────────────
   N علبة مغلقة تنقص من الرصيد المغلق، ويُضاف N × الحجم الأصلي إلى الرصيد المفتوح.
   تكلفة المل = تكلفة العلبة ÷ حجمها (قابلة للتعديل عبر unitCost) وتُدمج بمتوسط مرجّح. */
router.post("/products/:id(\\d+)/open-split", wrap(async (req, res) => {
  const out = await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);
    const day = await ledger.requireOpenDay(client);
    if (!prod.is_active) throw new HttpError(400, "product_inactive", "المنتج مؤرشف");
    if (!prod.allow_split) throw new HttpError(400, "split_not_allowed", "هذا العطر غير مسموح بتقسيمه — فعّل التقسيم من تعديل المنتج");
    const size = Number(prod.size_ml || 0);
    if (!(size > 0)) throw new HttpError(400, "size_required_for_split", "حدد الحجم الأصلي للعطر أولاً");
    const pieces = toInt(req.body.pieces ?? 1, { field: "pieces", min: 1, max: 10000 });
    if (pieces > prod.quantity) {
      throw new HttpError(400, "stock_insufficient", "الكمية المغلقة المتوفرة " + prod.quantity);
    }
    const pieceCost = req.body.unitCost !== undefined && req.body.unitCost !== null && req.body.unitCost !== ""
      ? toMoney(req.body.unitCost, { field: "unitCost" }) : Number(prod.purchase_price);
    const costPerMl = perfume.r4(pieceCost / size);
    const mlAdded = perfume.r2(pieces * size);
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : null;

    const sealedBefore = prod.quantity, openBefore = Number(prod.open_ml);
    await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2", [pieces, prod.id]);
    const after = await perfume.addOpenMl(client, prod.id, mlAdded, costPerMl);

    const op = (await client.query(
      `INSERT INTO open_operations
         (product_id, product_name, pieces, size_ml, ml_added, piece_cost, cost_per_ml,
          sealed_before, sealed_after, open_before, open_after, avg_cost_after, note, day_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [prod.id, prod.name, pieces, size, mlAdded, pieceCost, costPerMl,
       sealedBefore, sealedBefore - pieces, openBefore, Number(after.open_ml),
       Number(after.open_cost_per_ml), note, day.id])).rows[0];

    const msg = "تخصيص للتقسيم: " + pieces + " × " + size + " مل";
    await ledger.recordStockMove(client, {
      productId: prod.id, qtyOut: pieces, reason: "open_split", refType: "open_operation", refId: op.id,
      note: msg, dayId: day.id
    });
    await ledger.recordStockMove(client, {
      productId: prod.id, stockKind: "open", mlIn: mlAdded, reason: "open_split",
      refType: "open_operation", refId: op.id, note: msg, dayId: day.id
    });
    return { product: await getProduct(client, prod.id, false), op };
  });
  res.status(201).json({ product: mapProduct(out.product), operation: mapOpenOp(out.op) });
}));

/* سجل عمليات التخصيص للتقسيم */
router.get("/open-operations", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.productId) { params.push(req.query.productId); where.push(`product_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); where.push(`created_at >= $${params.length}::date`); }
  if (req.query.to)   { params.push(req.query.to);   where.push(`created_at < ($${params.length}::date + 1)`); }
  const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 1000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT * FROM open_operations ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  res.json({ operations: rows.map(mapOpenOp) });
}));

/* ───────────── عبوات التقسيم (vials) ───────────── */
router.get("/vials", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM vials ORDER BY is_active DESC, size_ml, name");
  res.json({ vials: rows.map(mapVial) });
}));

router.post("/vials", wrap(async (req, res) => {
  const vial = await db.tx(async client => {
    const name = cleanText(req.body.name, { field: "name", max: 80 });
    const size = toMl(req.body.sizeMl, { field: "sizeMl" });
    const cost = toMoney(req.body.cost ?? 0, { field: "cost" });
    const price = toMoney(req.body.price ?? req.body.salePrice ?? 0, { field: "price" });
    const qty = toInt(req.body.qty ?? 0, { field: "qty", min: 0, max: 1000000 });
    const minStock = toInt(req.body.minStock ?? 10, { field: "minStock", min: 0, max: 1000000 });
    const active = req.body.active === undefined ? true : !!req.body.active;
    const v = (await client.query(
      `INSERT INTO vials (name, size_ml, cost, sale_price, quantity, min_stock, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [name, size, cost, price, qty, minStock, active])).rows[0];
    if (qty > 0) {
      const day = await ledger.getOpenDay(client);
      await ledger.recordVialMove(client, { vialId: v.id, qtyIn: qty, reason: "initial", note: "رصيد افتتاحي", dayId: day ? day.id : null });
    }
    return v;
  });
  res.status(201).json({ vial: mapVial(vial) });
}));

router.put("/vials/:id(\\d+)", wrap(async (req, res) => {
  const vial = await db.tx(async client => {
    const v = await getVial(client, req.params.id, true);
    const name = cleanText(req.body.name ?? v.name, { field: "name", max: 80 });
    const size = req.body.sizeMl !== undefined ? toMl(req.body.sizeMl, { field: "sizeMl" }) : Number(v.size_ml);
    const cost = toMoney(req.body.cost ?? v.cost, { field: "cost" });
    const price = toMoney(req.body.price ?? req.body.salePrice ?? v.sale_price, { field: "price" });
    const minStock = toInt(req.body.minStock ?? v.min_stock, { field: "minStock", min: 0, max: 1000000 });
    const active = req.body.active === undefined ? v.is_active : !!req.body.active;
    return (await client.query(
      `UPDATE vials SET name=$1, size_ml=$2, cost=$3, sale_price=$4, min_stock=$5, is_active=$6, updated_at=now()
        WHERE id=$7 RETURNING *`, [name, size, cost, price, minStock, active, v.id])).rows[0];
  });
  res.json({ vial: mapVial(vial) });
}));

router.post("/vials/:id(\\d+)/adjust", wrap(async (req, res) => {
  const vial = await db.tx(async client => {
    const v = await getVial(client, req.params.id, true);
    const day = await ledger.requireOpenDay(client);
    const direction = req.body.direction === "out" ? "out" : "in";
    const qty = toInt(req.body.qty, { field: "qty", min: 1, max: 1000000 });
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : "تسوية يدوية";
    if (direction === "out" && v.quantity < qty) {
      throw new HttpError(400, "vial_insufficient", "المتوفر من العبوة " + v.quantity);
    }
    const upd = (await client.query(
      `UPDATE vials SET quantity = quantity ${direction === "in" ? "+" : "-"} $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [qty, v.id])).rows[0];
    await ledger.recordVialMove(client, {
      vialId: v.id, qtyIn: direction === "in" ? qty : 0, qtyOut: direction === "out" ? qty : 0,
      reason: "adjustment", note, dayId: day.id
    });
    return upd;
  });
  res.json({ vial: mapVial(vial) });
}));

router.delete("/vials/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const v = await getVial(client, req.params.id, true);
    const used = await client.query(
      `SELECT (SELECT count(*) FROM vial_movements WHERE vial_id = $1) AS moves,
              (SELECT count(*) FROM invoice_items WHERE vial_id = $1) AS sales,
              (SELECT count(*) FROM purchase_items WHERE vial_id = $1) AS purchases`, [v.id]);
    const u = used.rows[0];
    if (Number(u.moves) > 0 || Number(u.sales) > 0 || Number(u.purchases) > 0) {
      throw new HttpError(409, "vial_in_use", "لا يمكن حذف عبوة لها سجل حركة — عطّلها بدلاً من ذلك");
    }
    await client.query("DELETE FROM vials WHERE id = $1", [v.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

/* ───────────── حركة المخزون الموحّدة (مغلق / مفتوح بالمل / عبوات) ───────────── */
router.get("/movements", wrap(async (req, res) => {
  const kind = ["sealed", "open", "vial"].includes(req.query.kind) ? req.query.kind : null;
  const filt = (alias, extra) => {
    const where = [], params = [];
    const p = v => { params.push(v); return "$" + params.length; };
    if (extra.productId) where.push(`${alias}.product_id = ${p(extra.productId)}`);
    if (extra.vialId)    where.push(`${alias}.vial_id = ${p(extra.vialId)}`);
    if (req.query.reason) where.push(`${alias}.reason = ${p(req.query.reason)}`);
    if (req.query.from)   where.push(`${alias}.moved_at >= ${p(req.query.from)}::date`);
    if (req.query.to)     where.push(`${alias}.moved_at < (${p(req.query.to)}::date + 1)`);
    return { where, params };
  };
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);
  const rows = [];

  if (kind !== "vial" && !req.query.vialId) {
    const f = filt("m", { productId: req.query.productId });
    if (kind) f.where.push(`m.stock_kind = '${kind}'`);
    const r = await db.query(
      `SELECT m.*, m.stock_kind AS kind, p.name AS product_name, NULL::bigint AS vial_id
         FROM stock_movements m JOIN products p ON p.id = m.product_id
         ${f.where.length ? "WHERE " + f.where.join(" AND ") : ""}
        ORDER BY m.moved_at DESC, m.id DESC LIMIT ${limit}`, f.params);
    rows.push(...r.rows);
  }
  if ((!kind || kind === "vial") && !req.query.productId) {
    const f = filt("m", { vialId: req.query.vialId });
    const r = await db.query(
      `SELECT m.*, 'vial' AS kind, v.name AS product_name, NULL::bigint AS product_id
         FROM vial_movements m JOIN vials v ON v.id = m.vial_id
         ${f.where.length ? "WHERE " + f.where.join(" AND ") : ""}
        ORDER BY m.moved_at DESC, m.id DESC LIMIT ${limit}`, f.params);
    rows.push(...r.rows);
  }
  rows.sort((a, b) => new Date(b.moved_at) - new Date(a.moved_at) || Number(b.id) - Number(a.id));
  res.json({ movements: rows.slice(0, limit).map(mapStockMove) });
}));

/* ───────────── التصنيفات: صيفية / شتوية فقط (ثابتة) ───────────── */
router.get("/categories", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM categories ORDER BY sort_order, id");
  res.json({ categories: rows.map(mapCategory) });
}));
router.all("/categories", (_req, _res, next) => next(new HttpError(403, "categories_fixed", "التصنيفات ثابتة: صيفية وشتوية فقط")));
router.all("/categories/:id(\\d+)", (_req, _res, next) => next(new HttpError(403, "categories_fixed", "التصنيفات ثابتة: صيفية وشتوية فقط")));

/* ───────────── الجرد: مغلق (قطع) / مفتوح (مل) / عبوات (قطع) ───────────── */
router.get("/stocktakes", wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT s.*,
            (SELECT count(*) FROM stocktake_items i WHERE i.stocktake_id = s.id AND i.item_type = 'sealed') AS sealed_lines,
            (SELECT count(*) FROM stocktake_items i WHERE i.stocktake_id = s.id AND i.item_type = 'open')   AS open_lines,
            (SELECT count(*) FROM stocktake_items i WHERE i.stocktake_id = s.id AND i.item_type = 'vial')   AS vial_lines
       FROM stocktakes s ORDER BY s.created_at DESC, s.id DESC LIMIT 100`);
  res.json({ stocktakes: rows.map(mapStocktake) });
}));

router.post("/stocktakes", wrap(async (req, res) => {
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) throw new HttpError(400, "lines_required", "أضف أصناف الجرد");
  const out = await db.tx(async client => {
    const day = await ledger.requireOpenDay(client);
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : null;
    const st = (await client.query(
      "INSERT INTO stocktakes (day_id, note) VALUES ($1,$2) RETURNING *", [day.id, note])).rows[0];

    let diffLines = 0;
    for (const ln of lines) {
      const type = ["sealed", "open", "vial"].includes(ln.type) ? ln.type : "sealed";

      if (type === "vial") {
        const v = await getVial(client, ln.vialId, true);
        const counted = toInt(ln.countedQty, { field: "countedQty", min: 0, max: 1000000 });
        const diff = counted - v.quantity;
        await client.query(
          `INSERT INTO stocktake_items (stocktake_id, item_type, vial_id, product_name, system_qty, counted_qty)
           VALUES ($1,'vial',$2,$3,$4,$5)`, [st.id, v.id, v.name, v.quantity, counted]);
        if (diff !== 0) {
          await client.query("UPDATE vials SET quantity = $1, updated_at = now() WHERE id = $2", [counted, v.id]);
          await ledger.recordVialMove(client, {
            vialId: v.id, qtyIn: diff > 0 ? diff : 0, qtyOut: diff < 0 ? -diff : 0, reason: "adjustment",
            refType: "stocktake", refId: st.id, note: "جرد عبوات: " + (diff > 0 ? "زيادة " + diff : "نقص " + (-diff)), dayId: day.id
          });
          diffLines++;
        }
        continue;
      }

      const prod = await getProduct(client, ln.productId, true);
      if (type === "open") {
        const counted = toMl(ln.countedQty, { field: "countedQty", min: 0 });
        const diff = perfume.r2(counted - Number(prod.open_ml));
        await client.query(
          `INSERT INTO stocktake_items (stocktake_id, item_type, product_id, product_name, system_qty, counted_qty)
           VALUES ($1,'open',$2,$3,$4,$5)`, [st.id, prod.id, prod.name, prod.open_ml, counted]);
        if (diff !== 0) {
          await client.query("UPDATE products SET open_ml = $1, updated_at = now() WHERE id = $2", [counted, prod.id]);
          await ledger.recordStockMove(client, {
            productId: prod.id, stockKind: "open", mlIn: diff > 0 ? diff : 0, mlOut: diff < 0 ? -diff : 0,
            reason: "adjustment", refType: "stocktake", refId: st.id,
            note: "جرد مفتوح: " + (diff > 0 ? "زيادة " + diff : "نقص " + (-diff)) + " مل", dayId: day.id
          });
          diffLines++;
        }
        continue;
      }

      const counted = toInt(ln.countedQty, { field: "countedQty", min: 0, max: 100000 });
      const diff = counted - prod.quantity;
      await client.query(
        `INSERT INTO stocktake_items (stocktake_id, item_type, product_id, product_name, system_qty, counted_qty)
         VALUES ($1,'sealed',$2,$3,$4,$5)`, [st.id, prod.id, prod.name, prod.quantity, counted]);
      if (diff !== 0) {
        await client.query("UPDATE products SET quantity = $1, updated_at = now() WHERE id = $2", [counted, prod.id]);
        await ledger.recordStockMove(client, {
          productId: prod.id, qtyIn: diff > 0 ? diff : 0, qtyOut: diff < 0 ? -diff : 0, reason: "adjustment",
          refType: "stocktake", refId: st.id, note: "جرد مغلق: " + (diff > 0 ? "زيادة " + diff : "نقص " + (-diff)), dayId: day.id });
        diffLines++;
      }
    }
    await client.query("UPDATE stocktakes SET lines = $1, diff_lines = $2 WHERE id = $3",
      [lines.length, diffLines, st.id]);
    return (await client.query("SELECT * FROM stocktakes WHERE id = $1", [st.id])).rows[0];
  });
  res.status(201).json({ stocktake: mapStocktake(out) });
}));

router.get("/stocktakes/:id(\\d+)", wrap(async (req, res) => {
  const st = await db.query("SELECT * FROM stocktakes WHERE id = $1", [req.params.id]);
  if (!st.rows.length) throw new HttpError(404, "stocktake_not_found", "الجرد غير موجود");
  const items = await db.query(
    "SELECT * FROM stocktake_items WHERE stocktake_id = $1 ORDER BY item_type, diff = 0, product_name", [req.params.id]);
  res.json({ stocktake: mapStocktake(st.rows[0]), items: items.rows.map(mapStocktakeItem) });
}));

module.exports = router;
module.exports.resolveCategory = resolveCategory;
