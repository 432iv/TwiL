"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/sales — المبيعات في نموذج الفواتير متعددة الأصناف
   كل عملية بيع:
     خصم المخزون + حركة مخزون + فاتورة + أصنافها + حركة صندوق + ربح
   المرتجعات والإلغاء والتعديل تعكس كل الآثار داخل معاملة واحدة.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, toInt, toMoney, isoDate } = require("../lib/http");
const { mapInvoice, mapInvoiceLite, mapReturn } = require("../lib/map");
const { rememberName } = require("./products");
const perfume = require("../lib/perfume");

const router = express.Router();
const r2 = ledger.r2;

async function validPayment(code, client) {
  const q = client || db;
  const { rows } = await q.query("SELECT code FROM payment_methods WHERE code = $1 AND active", [code]);
  if (!rows.length) throw new HttpError(400, "payment_invalid", "Unknown payment method");
  return rows[0].code;
}

function resolveDebtorName(payment, raw) {
  if (payment !== "unpaid") return null;
  const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || null;
}

/* ───────────── بنود الفاتورة: تحقق + تجهيز ─────────────
   البند (بيع مغلق):  {productId?, name, qty, wholesale, selling}
   البند (بيع تقسيم): {productId, mode:"split", ml, mlPrice?, vialId?, vialQty?, vialPrice?}
     السعر = مل × سعر المل + (عدد العبوات × سعر العبوة)
     التكلفة = مل × تكلفة المل + (عدد العبوات × تكلفة العبوة)
   - بند بمنتج مخزني: يخصم من المخزون (مغلق بالقطعة أو مفتوح بالمل)
   - بند حر (بدون productId): يُباع بدون مخزون كما في النسخة السابقة */
async function prepareItems(client, rawItems, mode) {
  const prepared = [];
  /* حجوزات داخل نفس الفاتورة: صنفان بنفس المنتج/العبوة لا يتجاوزان الرصيد معاً */
  const reservedQty = new Map(), reservedMl = new Map(), reservedVial = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

  for (const raw of rawItems) {
    const isSplit = raw.mode === "split" || raw.saleType === "split";

    if (isSplit) {
      if (!raw.productId) throw new HttpError(400, "split_needs_product", "بيع التقسيم يحتاج عطراً من المخزون");
      const { rows } = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [raw.productId]);
      if (!rows.length) throw new HttpError(404, "product_not_found", "Product not found");
      const product = rows[0];
      if (!product.is_active) throw new HttpError(400, "product_inactive", "Product is archived");
      if (!product.allow_split) throw new HttpError(400, "split_not_allowed", "هذا العطر غير مسموح بتقسيمه");

      const ml = perfume.r2(parseFloat(raw.ml));
      if (!Number.isFinite(ml) || ml <= 0 || ml > 100000) throw new HttpError(400, "ml_invalid", "كمية المل غير صحيحة");
      const mlPrice = toMoney(raw.mlPrice ?? product.ml_price, { field: "ml_price" });
      if (mlPrice <= 0) throw new HttpError(400, "ml_price_required", "حدد سعر المل لهذا العطر أولاً");

      const needMl = perfume.r2((reservedMl.get(String(product.id)) || 0) + ml);
      if (perfume.mlGt(needMl, product.open_ml)) {
        throw new HttpError(400, "open_stock_insufficient",
          "المتوفر من " + product.name + " المفتوح للتقسيم هو " + Number(product.open_ml) + " مل");
      }
      add(reservedMl, String(product.id), ml);

      let vial = null, vialQty = 0, vialPrice = 0;
      if (raw.vialId) {
        const v = (await client.query("SELECT * FROM vials WHERE id = $1 FOR UPDATE", [raw.vialId])).rows[0];
        if (!v) throw new HttpError(404, "vial_not_found", "Vial not found");
        if (!v.is_active) throw new HttpError(400, "vial_inactive", "العبوة غير مفعّلة");
        vial = v;
        vialQty = toInt(raw.vialQty ?? 1, { field: "vial_qty", min: 1, max: 1000 });
        vialPrice = toMoney(raw.vialPrice ?? v.sale_price, { field: "vial_price" });
        if (perfume.mlGt(ml, Number(v.size_ml) * vialQty)) {
          throw new HttpError(400, "vial_too_small", "حجم العبوة (" + Number(v.size_ml) + " مل) أصغر من الكمية المباعة");
        }
        const needVial = (reservedVial.get(String(v.id)) || 0) + vialQty;
        if (needVial > v.quantity) {
          throw new HttpError(400, "vial_insufficient", "المتوفر من العبوة «" + v.name + "» هو " + v.quantity);
        }
        add(reservedVial, String(v.id), vialQty);
      }

      const mlCost = perfume.r4(perfume.mlCostOf(product));
      const selling = perfume.r2(ml * mlPrice + vialQty * vialPrice);
      const wholesale = perfume.r2(ml * mlCost + (vial ? vialQty * Number(vial.cost) : 0));
      prepared.push({
        product, name: product.name, qty: 1, wholesale, selling,
        split: { ml, mlPrice, mlCost, vial, vialQty, vialPrice }
      });
      continue;
    }

    const name = cleanText(raw.name || raw.product, { field: "product", max: 120, required: !raw.productId });
    const qty = toInt(raw.qty, { field: "qty" });
    let product = null;

    if (raw.productId) {
      const { rows } = await client.query(
        "SELECT * FROM products WHERE id = $1 FOR UPDATE", [raw.productId]);
      if (!rows.length) throw new HttpError(404, "product_not_found", "Product not found");
      product = rows[0];
      if (!product.is_active) throw new HttpError(400, "product_inactive", "Product is archived");
    }
    const wholesale = toMoney(raw.wholesale ?? (product ? product.purchase_price : 0), { field: "wholesale" });
    const selling = toMoney(raw.selling ?? raw.price, { field: "price" });

    if (product) {
      const need = (reservedQty.get(String(product.id)) || 0) + qty;
      if (need > product.quantity) {
        throw new HttpError(400, "stock_insufficient", "الكمية المغلقة المتوفرة من " + product.name + " هي " + product.quantity);
      }
      add(reservedQty, String(product.id), qty);
    }
    prepared.push({ product, name: product ? product.name : name, qty, wholesale, selling, split: null });
  }
  return prepared;
}

/* إدخال بنود الفاتورة + خصم المخزون + حركات المخزون */
async function applyItems(client, invoiceId, dayId, prepared, reason) {
  let subtotal = 0, costTotal = 0;
  for (const p of prepared) {
    subtotal  += r2(p.selling * p.qty);
    costTotal += r2(p.wholesale * p.qty);

    if (!p.product) {                              /* بند حر: يُسجَّل بلا مخزون */
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, qty, wholesale_price, selling_price)
         VALUES ($1,NULL,$2,$3,$4,$5)`,
        [invoiceId, p.name, p.qty, p.wholesale, p.selling]);
      continue;
    }

    if (p.split) {
      const sp = p.split;
      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_id, product_name, qty, wholesale_price, selling_price,
            sale_type, ml_qty, ml_price, ml_cost,
            vial_id, vial_name, vial_size_ml, vial_qty, vial_cost, vial_price)
         VALUES ($1,$2,$3,1,$4,$5,'split',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [invoiceId, p.product.id, p.name, p.wholesale, p.selling,
         sp.ml, sp.mlPrice, sp.mlCost,
         sp.vial ? sp.vial.id : null, sp.vial ? sp.vial.name : null,
         sp.vial ? sp.vial.size_ml : null, sp.vialQty,
         sp.vial ? sp.vial.cost : 0, sp.vialPrice]);
      await client.query("UPDATE products SET open_ml = open_ml - $1, updated_at = now() WHERE id = $2",
        [sp.ml, p.product.id]);
      await ledger.recordStockMove(client, {
        productId: p.product.id, stockKind: "open", mlOut: sp.ml,
        reason: reason === "edit" ? "edit" : "split_sale", refType: "invoice", refId: invoiceId,
        note: "بيع تقسيم " + sp.ml + " مل", dayId
      });
      if (sp.vial) {
        await client.query("UPDATE vials SET quantity = quantity - $1, updated_at = now() WHERE id = $2",
          [sp.vialQty, sp.vial.id]);
        await ledger.recordVialMove(client, {
          vialId: sp.vial.id, qtyOut: sp.vialQty,
          reason: reason === "edit" ? "edit" : "split_sale", refType: "invoice", refId: invoiceId,
          note: "عبوة بيع تقسيم", dayId
        });
      }
      continue;
    }

    await client.query(
      `INSERT INTO invoice_items (invoice_id, product_id, product_name, qty, wholesale_price, selling_price)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [invoiceId, p.product.id, p.name, p.qty, p.wholesale, p.selling]);
    await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2",
      [p.qty, p.product.id]);
    await ledger.recordStockMove(client, {
      productId: p.product.id, qtyOut: p.qty, reason, refType: "invoice", refId: invoiceId,
      note: "فاتورة بيع", dayId
    });
  }
  return { subtotal: r2(subtotal), costTotal: r2(costTotal) };
}

/* إعادة مل وعبوات بند تقسيم إلى المخزون (مع متوسط التكلفة) */
async function restockSplitItem(client, item, { reason, refType, refId, note, dayId }) {
  const ml = Number(item.ml_qty);
  if (item.product_id && ml > 0) {
    await perfume.addOpenMl(client, item.product_id, ml, Number(item.ml_cost));
    await ledger.recordStockMove(client, {
      productId: item.product_id, stockKind: "open", mlIn: ml, reason, refType, refId, note, dayId
    });
  }
  if (item.vial_id && Number(item.vial_qty) > 0) {
    const upd = await client.query("UPDATE vials SET quantity = quantity + $1, updated_at = now() WHERE id = $2 RETURNING id",
      [item.vial_qty, item.vial_id]);
    if (upd.rows.length) {
      await ledger.recordVialMove(client, {
        vialId: item.vial_id, qtyIn: item.vial_qty, reason, refType, refId, note, dayId
      });
    }
  }
}

/* إرجاع بنود فاتورة إلى المخزون (كمية لم تُرجع) */
async function restoreInvoiceStock(client, invoice, reason, note) {
  const { rows: items } = await client.query(
    "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id", [invoice.id]);
  const dayId = (await ledger.getOpenDay(client) || {}).id || null;
  let restoredQty = 0;
  for (const it of items) {
    const give = it.qty - it.qty_returned;
    if (!it.product_id || give <= 0) continue;
    if (it.sale_type === "split") {
      await restockSplitItem(client, it, {
        reason: reason === "return_in" ? "split_return" : reason,
        refType: "invoice", refId: invoice.id, note: note + " " + invoice.invoice_no, dayId
      });
      restoredQty += 1;
      continue;
    }
    await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2",
      [give, it.product_id]);
    await ledger.recordStockMove(client, {
      productId: it.product_id, qtyIn: give, reason, refType: "invoice", refId: invoice.id,
      note: note + " " + invoice.invoice_no, dayId
    });
    restoredQty += give;
  }
  return restoredQty;
}

/* حركة الصندوق لفاتورة حسب طريقة الدفع */
async function cashForInvoice(client, invoice, dayId) {
  if (invoice.payment_method === "unpaid" || Number(invoice.total) <= 0) return;
  await ledger.recordCashMove(client, {
    dayId, direction: "in", method: invoice.payment_method, category: "sale",
    amount: Number(invoice.total), description: "فاتورة بيع " + invoice.invoice_no,
    refType: "invoice", refId: invoice.id
  });
}

async function loadInvoice(id) {
  const { rows } = await db.query("SELECT * FROM invoices WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "sale_not_found", "Sale not found");
  return rows[0];
}
async function loadInvoiceWithItems(id) {
  const inv = await loadInvoice(id);
  const items = await db.query("SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id", [id]);
  return mapInvoice(inv, items.rows);
}

/* ───────────── قائمة الفواتير ───────────── */
router.get("/", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.date)  { params.push(isoDate(req.query.date)); where.push(`i.sale_date = $${params.length}`); }
  if (req.query.dayId) { params.push(req.query.dayId);         where.push(`i.day_id = $${params.length}`); }
  if (req.query.status){ params.push(req.query.status);        where.push(`i.status = $${params.length}`); }
  if (req.query.q) {
    params.push("%" + String(req.query.q).trim().toLowerCase() + "%");
    where.push(`(lower(i.invoice_no) LIKE $${params.length}
                 OR lower(i.debtor_name) LIKE $${params.length}
                 OR EXISTS (SELECT 1 FROM invoice_items x WHERE x.invoice_id = i.id
                             AND lower(x.product_name) LIKE $${params.length}))`);
  }
  const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 1000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT i.* FROM invoices i ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY i.sale_time DESC, i.id DESC LIMIT $${params.length}`, params);
  if (!rows.length) return res.json({ invoices: [] });
  const ids = rows.map(r => r.id);
  const items = await db.query(
    `SELECT * FROM invoice_items WHERE invoice_id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  const byInv = new Map();
  for (const it of items.rows) {
    if (!byInv.has(String(it.invoice_id))) byInv.set(String(it.invoice_id), []);
    byInv.get(String(it.invoice_id)).push(it);
  }
  res.json({ invoices: rows.map(r => mapInvoice(r, byInv.get(String(r.id)) || [])) });
}));

/* ───────────── ملخص اليوم (توافق مع الواجهة القديمة) ───────────── */
router.get("/summary", wrap(async (req, res) => {
  let dayId;
  if (req.query.dayId) dayId = req.query.dayId;
  else if (req.query.date) {
    const d = await db.query("SELECT id FROM days WHERE day_date = $1", [isoDate(req.query.date)]);
    if (!d.rows.length) return res.json({ summary: null, day: null });
    dayId = d.rows[0].id;
  } else {
    const open = await ledger.getOpenDay();
    if (!open) return res.json({ summary: null, day: null });
    dayId = open.id;
  }
  const day = await ledger.dayById(dayId);
  const { totals } = await ledger.daySummaryForApi(dayId);
  res.json({
    summary: {
      total: totals.total, cost: totals.cost, profit: totals.profit, count: totals.count,
      cash: totals.cash, card: totals.card, byMethod: totals.byMethod
    },
    day: { id: String(day.id), date: day.day_date, status: day.status }
  });
}));

/* ───────────── تسجيل بيع جديد ───────────── */
router.post("/", wrap(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) throw new HttpError(400, "items_required", "أضف منتجًا واحدًا على الأقل");

  const invoice = await db.tx(async client => {
    const day = req.body.dayId
      ? await ledger.assertDayOpen(req.body.dayId, client)
      : await ledger.requireOpenDay(client);

    const payment = await validPayment(req.body.payment ?? req.body.payment_method, client);
    const debtorName = resolveDebtorName(payment, req.body.debtorName ?? req.body.debtor_name);
    const prepared = await prepareItems(client, rawItems, "create");

    const { rows } = await client.query(
      `INSERT INTO invoices (day_id, invoice_no, payment_method, debtor_name, sale_date)
       VALUES ($1, 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0'), $2, $3, $4)
       RETURNING *`,
      [day.id, payment, debtorName, day.day_date]);
    const inv = rows[0];

    const { subtotal, costTotal } = await applyItems(client, inv.id, day.id, prepared, "sale");
    const discount = Math.min(toMoney(req.body.discount ?? 0, { field: "discount" }), subtotal);

    await client.query(
      `UPDATE invoices SET subtotal = $1, cost_total = $2, discount = $3, notes = $4, updated_at = now()
        WHERE id = $5 RETURNING *`,
      [subtotal, costTotal, discount, req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 300, required: false }) : null, inv.id]);

    /* الأسماء الحرة تدخل قاموس الإكمال التلقائي كما في السابق */
    for (const p of prepared) {
      if (!p.product) await rememberName(client, p.name);
    }

    const finalInv = (await client.query("SELECT * FROM invoices WHERE id = $1", [inv.id])).rows[0];
    await cashForInvoice(client, finalInv, day.id);
    return finalInv;
  });

  res.status(201).json({ sale: await loadInvoiceWithItems(invoice.id), invoice: await loadInvoiceWithItems(invoice.id) });
}));

/* ───────────── تفاصيل فاتورة ───────────── */
router.get("/:id(\\d+)", wrap(async (req, res) => {
  res.json({ sale: await loadInvoiceWithItems(req.params.id) });
}));

/* ───────────── تعديل فاتورة (اليوم مفتوح، بدون مرتجعات) ───────────── */
router.put("/:id(\\d+)", wrap(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) throw new HttpError(400, "items_required", "أضف منتجًا واحدًا على الأقل");

  const out = await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    await ledger.assertDayOpen(inv.day_id, client);
    if (inv.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "الفاتورة ملغاة");
    if (Number(inv.refunded) > 0) throw new HttpError(409, "invoice_has_returns", "الفاتورة تحتوي مرتجعات — لا يمكن تعديلها");

    /* 1) إرجاع المخزون القديم كاملاً */
    await restoreInvoiceStock(client, inv, "edit", "تعديل فاتورة");
    /* 2) حذف البنود القديمة وحركات الصندوق المرتبطة (سيُعاد بناؤها) */
    await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [inv.id]);
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'invoice' AND ref_id = $1", [inv.id]);

    /* 3) إعادة التطبيق على البنود الجديدة */
    const payment = await validPayment(req.body.payment ?? req.body.payment_method ?? inv.payment_method, client);
    const debtorName = resolveDebtorName(payment, req.body.debtorName ?? req.body.debtor_name);
    const prepared = await prepareItems(client, rawItems, "edit");
    const { subtotal, costTotal } = await applyItems(client, inv.id, inv.day_id, prepared, "edit");
    const discount = Math.min(toMoney(req.body.discount ?? inv.discount, { field: "discount" }), subtotal);

    await client.query(
      `UPDATE invoices SET payment_method = $1, debtor_name = $2, subtotal = $3, cost_total = $4,
                           discount = $5, notes = $6, updated_at = now() WHERE id = $7`,
      [payment, debtorName, subtotal, costTotal, discount,
       req.body.notes !== undefined ? (req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 300, required: false }) : null) : inv.notes,
       inv.id]);

    const finalInv = (await client.query("SELECT * FROM invoices WHERE id = $1", [inv.id])).rows[0];
    await cashForInvoice(client, finalInv, inv.day_id);
    return finalInv;
  });

  res.json({ sale: await loadInvoiceWithItems(out.id) });
}));

/* ───────────── إرجاع منتجات من فاتورة ───────────── */
router.post("/:id(\\d+)/returns", wrap(async (req, res) => {
  const rawReturns = Array.isArray(req.body.returns) ? req.body.returns : [];
  if (!rawReturns.length) throw new HttpError(400, "returns_required", "حدد الأصناف المرتجعة");

  const result = await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    if (inv.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "الفاتورة ملغاة");
    const day = await ledger.requireOpenDay(client);   /* الإرجاع يسجل في اليوم المفتوح الحالي */

    let refundTotal = 0, refundProfit = 0;
    const applied = [];
    for (const rt of rawReturns) {
      const item = (await client.query("SELECT * FROM invoice_items WHERE id = $1 AND invoice_id = $2 FOR UPDATE",
        [rt.itemId, inv.id])).rows[0];
      if (!item) throw new HttpError(404, "item_not_found", "صنف غير موجود في الفاتورة");
      const maxGive = item.qty - item.qty_returned;
      const qty = toInt(rt.qty, { field: "qty", min: 1, max: maxGive });
      const reason = rt.reason ? cleanText(rt.reason, { field: "reason", max: 200, required: false }) : null;

      /* هل تعود البضاعة إلى المخزون؟ (افتراضي نعم — مرتجع تقسيم تالف/مفتوح يمكن ألا يُعاد) */
      const restock = rt.restock !== false;
      const amount = r2(Number(item.selling_price) * qty);
      /* إن عادت البضاعة تُعكس تكلفتها مع الربح؛ وإن لم تعد فالتكلفة تبقى خسارة */
      const profitAdjust = restock
        ? r2((Number(item.selling_price) - Number(item.wholesale_price)) * qty)
        : amount;

      await client.query("UPDATE invoice_items SET qty_returned = qty_returned + $1 WHERE id = $2", [qty, item.id]);
      await client.query(
        `INSERT INTO sale_returns (invoice_id, item_id, day_id, qty, amount, profit_adjust, reason, restocked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [inv.id, item.id, day.id, qty, amount, profitAdjust, reason, restock]);

      if (item.product_id && restock) {
        if (item.sale_type === "split") {
          await restockSplitItem(client, item, {
            reason: "split_return", refType: "sale_return", refId: inv.id,
            note: "مرتجع فاتورة " + inv.invoice_no, dayId: day.id
          });
        } else {
          await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2",
            [qty, item.product_id]);
          await ledger.recordStockMove(client, {
            productId: item.product_id, qtyIn: qty, reason: "return_in",
            refType: "sale_return", refId: inv.id, note: "مرتجع فاتورة " + inv.invoice_no, dayId: day.id
          });
        }
      }
      refundTotal += amount;
      refundProfit += profitAdjust;
      applied.push({ itemId: String(item.id), qty, amount, profitAdjust, restocked: restock });
    }

    await client.query(
      "UPDATE invoices SET refunded = refunded + $1, refunded_profit = refunded_profit + $2, updated_at = now() WHERE id = $3",
      [r2(refundTotal), r2(refundProfit), inv.id]);

    /* إن أُرجعت كل الكميات → الفاتورة "مُرجعة" */
    const left = await client.query(
      "SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1 AND qty_returned < qty", [inv.id]);
    if (left.rows[0].n === 0) {
      await client.query("UPDATE invoices SET status = 'returned', updated_at = now() WHERE id = $1", [inv.id]);
    }

    /* استرداد المبلغ حسب طريقة الدفع الأصلية */
    if (inv.payment_method !== "unpaid" && refundTotal > 0) {
      await ledger.recordCashMove(client, {
        dayId: day.id, direction: "out", method: inv.payment_method, category: "refund",
        amount: r2(refundTotal), description: "مرتجع فاتورة " + inv.invoice_no,
        refType: "invoice", refId: inv.id
      });
    }
    return applied;
  });

  res.status(201).json({ returns: result.map(a => Object.assign(a, { invoiceId: String(req.params.id) })), sale: await loadInvoiceWithItems(req.params.id) });
}));

/* ───────────── إلغاء البيع ───────────── */
router.post("/:id(\\d+)/cancel", wrap(async (req, res) => {
  const out = await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    await ledger.assertDayOpen(inv.day_id, client);
    if (inv.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "الفاتورة ملغاة بالفعل");

    /* إرجاع ما تبقى من المخزون */
    await restoreInvoiceStock(client, inv, "return_in", "إلغاء فاتورة");

    /* عكس أثر الصندوق للمبلغ الصافي المقبوض */
    const netReceived = r2(Number(inv.total) - Number(inv.refunded));
    if (inv.payment_method !== "unpaid" && netReceived > 0) {
      await ledger.recordCashMove(client, {
        dayId: inv.day_id, direction: "out", method: inv.payment_method, category: "refund",
        amount: netReceived, description: "إلغاء فاتورة " + inv.invoice_no,
        refType: "invoice", refId: inv.id
      });
    }
    await client.query("UPDATE invoices SET status = 'cancelled', updated_at = now() WHERE id = $1", [inv.id]);
    return (await client.query("SELECT * FROM invoices WHERE id = $1", [inv.id])).rows[0];
  });
  res.json({ sale: await loadInvoiceWithItems(out.id) });
}));

/* ───────────── حذف نهائي (يعكس كل الآثار) ───────────── */
router.delete("/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    await ledger.assertDayOpen(inv.day_id, client);
    if (inv.status !== "cancelled") {
      await restoreInvoiceStock(client, inv, "return_in", "حذف فاتورة");
      const netReceived = r2(Number(inv.total) - Number(inv.refunded));
      if (inv.payment_method !== "unpaid" && netReceived > 0) {
        await ledger.recordCashMove(client, {
          dayId: inv.day_id, direction: "out", method: inv.payment_method, category: "refund",
          amount: netReceived, description: "حذف فاتورة " + inv.invoice_no,
          refType: "invoice", refId: inv.id
        });
      }
    }
    await client.query("DELETE FROM sale_returns WHERE invoice_id = $1", [inv.id]);
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'invoice' AND ref_id = $1", [inv.id]);
    await client.query("DELETE FROM invoices WHERE id = $1", [inv.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
