"use strict";
/* Database rows -> the shapes the frontend renders.
   الأسماء القديمة (mapSale/mapDay/...) محفوظة كما هي حتى تبقى
   أجزاء الواجهة القائمة تعمل، والمحولات الجديدة تخدم أقسام v4. */

const str = v => (v === null || v === undefined ? null : String(v));
const iso = v => (v instanceof Date ? v.toISOString() : v);
const n = v => Number(v === null || v === undefined ? 0 : v);

const mapDay = r => ({
  id:        str(r.id),
  dayName:   r.day_name,
  date:      r.day_date,
  startedAt: iso(r.opened_at),
  closedAt:  iso(r.closed_at),
  status:    r.status
});

const mapNote = r => ({
  id:        str(r.id),
  sessionId: str(r.day_id),
  date:      r.note_date,
  text:      r.note_text,
  time:      iso(r.note_time)
});

/* ───────────── v4: الفواتير ───────────── */
const mapInvoiceItem = r => ({
  id:        str(r.id),
  productId: str(r.product_id),
  product:   r.product_name,
  qty:       n(r.qty),
  qtyReturned: n(r.qty_returned),
  wholesale: n(r.wholesale_price),
  price:     n(r.selling_price),
  total:     n(r.line_total),
  cost:      n(r.line_cost),
  saleType:  r.sale_type || "sealed",          // sealed | split
  isSplit:   r.sale_type === "split",
  ml:        n(r.ml_qty),                       // مل مباعة (بيع تقسيم)
  mlPrice:   n(r.ml_price),                     // سعر المل وقت البيع
  mlCost:    n(r.ml_cost),                      // تكلفة المل وقت البيع
  vialId:    str(r.vial_id),
  vialName:  r.vial_name || null,
  vialSize:  r.vial_size_ml === null || r.vial_size_ml === undefined ? null : n(r.vial_size_ml),
  vialQty:   n(r.vial_qty),
  vialCost:  n(r.vial_cost),                    // تكلفة العبوة الواحدة
  vialPrice: n(r.vial_price)                    // سعر العبوة الواحدة على الزبون
});

const mapInvoice = (r, items) => {
  const refunded = n(r.refunded);
  const refundedProfit = n(r.refunded_profit);
  return {
    id:         str(r.id),
    invoice:    r.invoice_no,
    sessionId:  str(r.day_id),
    date:       r.sale_date,
    time:       iso(r.sale_time),
    payment:    r.payment_method,
    debtorName: r.debtor_name || null,
    discount:   n(r.discount),
    subtotal:   n(r.subtotal),
    cost:       n(r.cost_total),
    total:      n(r.total),
    profit:     n(r.profit),
    refunded,
    refundedProfit,
    effTotal:   n(r.total) - refunded,
    effCost:    n(r.cost_total) - (refunded - refundedProfit),
    effProfit:  n(r.profit) - refundedProfit,
    status:     r.status,
    notes:      r.notes || null,
    items:      (items || []).map(mapInvoiceItem)
  };
};

/* سطر مبسّط للعمليات الأخيرة في لوحة التحكم */
const mapInvoiceLite = r => ({
  id: str(r.id), invoice: r.invoice_no, date: r.sale_date, time: iso(r.sale_time),
  payment: r.payment_method, total: n(r.total) - n(r.refunded),
  profit: n(r.profit) - n(r.refunded_profit), status: r.status,
  itemsCount: n(r.items_count), firstProduct: r.first_product || ""
});

const mapReturn = r => ({
  id: str(r.id), invoiceId: str(r.invoice_id), itemId: str(r.item_id),
  dayId: str(r.day_id), qty: n(r.qty), amount: n(r.amount),
  profitAdjust: n(r.profit_adjust), reason: r.reason || null,
  time: iso(r.returned_at)
});

/* ───────────── v4: المخزون (عطور) ───────────── */
const mapProduct = r => {
  const qty = n(r.quantity), openMl = n(r.open_ml);
  const size = r.size_ml === null || r.size_ml === undefined ? null : n(r.size_ml);
  return {
    id:         str(r.id),
    name:       r.name,
    brand:      r.brand || null,
    sizeMl:     size,                       // الحجم الأصلي للعلبة (مل)
    productType: r.product_type || null,
    categoryId: str(r.category_id),
    category:   r.category_name || null,    // صيفية | شتوية
    season:     r.category_code || null,    // summer | winter
    barcode:    r.barcode || null,
    image:      r.image_url || null,
    notes:      r.notes || null,
    qty,                                    // رصيد مغلق (قطع)
    openMl,                                 // رصيد مفتوح (مل)
    purchasePrice: n(r.purchase_price),     // تكلفة العلبة المغلقة (متوسط)
    salePrice:  n(r.sale_price),            // سعر بيع العلبة المغلقة
    mlPrice:    n(r.ml_price),              // سعر المل عند التقسيم (مستقل عن سعر العلبة)
    openCostPerMl: n(r.open_cost_per_ml),   // تكلفة المل المفتوح (متوسط)
    allowSplit: !!r.allow_split,
    minStock:   n(r.min_stock),
    active:     !!r.is_active,
    lowStock:   !!r.is_active && qty <= n(r.min_stock),
    stockValue: Math.round((qty * n(r.purchase_price)) * 100) / 100,
    openValue:  Math.round((openMl * n(r.open_cost_per_ml)) * 100) / 100,
    createdAt:  iso(r.created_at),
    updatedAt:  iso(r.updated_at)
  };
};

const mapCategory = r => ({ id: str(r.id), name: r.name, code: r.code, sortOrder: n(r.sort_order) });

const mapVial = r => ({
  id: str(r.id), name: r.name, sizeMl: n(r.size_ml),
  cost: n(r.cost), price: n(r.sale_price), qty: n(r.quantity),
  minStock: n(r.min_stock), active: !!r.is_active,
  lowStock: !!r.is_active && n(r.quantity) <= n(r.min_stock),
  stockValue: Math.round((n(r.quantity) * n(r.cost)) * 100) / 100,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

const mapOpenOp = r => ({
  id: str(r.id), productId: str(r.product_id), product: r.product_name,
  pieces: n(r.pieces), sizeMl: n(r.size_ml), mlAdded: n(r.ml_added),
  pieceCost: n(r.piece_cost), costPerMl: n(r.cost_per_ml),
  sealedBefore: n(r.sealed_before), sealedAfter: n(r.sealed_after),
  openBefore: n(r.open_before), openAfter: n(r.open_after),
  avgCostAfter: n(r.avg_cost_after), note: r.note || null,
  dayId: str(r.day_id), time: iso(r.created_at)
});

/* حركة مخزون موحّدة: kind = sealed (قطع) | open (مل) | vial (عبوات) */
const mapStockMove = r => {
  const kind = r.kind || r.stock_kind || "sealed";
  const isOpen = kind === "open";
  return {
    id: str(r.id), kind, unit: isOpen ? "ml" : "pcs",
    productId: str(r.product_id), vialId: str(r.vial_id), product: r.product_name,
    qtyIn:  isOpen ? n(r.ml_in)  : n(r.qty_in),
    qtyOut: isOpen ? n(r.ml_out) : n(r.qty_out),
    reason: r.reason,
    refType: r.ref_type, refId: str(r.ref_id), note: r.note || null,
    dayId: str(r.day_id), time: iso(r.moved_at)
  };
};

const mapStocktake = r => ({
  id: str(r.id), dayId: str(r.day_id), note: r.note || null,
  lines: n(r.lines), diffLines: n(r.diff_lines), time: iso(r.created_at),
  sealedLines: n(r.sealed_lines), openLines: n(r.open_lines), vialLines: n(r.vial_lines)
});

const mapStocktakeItem = r => ({
  id: str(r.id), type: r.item_type, productId: str(r.product_id), vialId: str(r.vial_id),
  name: r.product_name, systemQty: n(r.system_qty), countedQty: n(r.counted_qty), diff: n(r.diff)
});

/* ───────────── v4: المشتريات والمصروفات والصندوق ───────────── */
const mapPurchaseItem = r => ({
  id: str(r.id), type: r.item_type || "perfume",
  productId: str(r.product_id), vialId: str(r.vial_id), product: r.product_name,
  qty: n(r.qty), unitCost: n(r.unit_cost), total: n(r.line_total)
});

const mapPurchase = (r, items) => ({
  id: str(r.id), purchaseNo: r.purchase_no, sessionId: str(r.day_id),
  date: r.purchase_date, total: n(r.total), paid: !!r.paid,
  notes: r.notes || null, status: r.status,
  itemsCount: n(r.items_count), time: iso(r.created_at),
  items: (items || []).map(mapPurchaseItem)
});

const mapExpense = r => ({
  id: str(r.id), sessionId: str(r.day_id), category: r.category,
  amount: n(r.amount), date: r.expense_date, notes: r.notes || null,
  time: iso(r.created_at)
});

const mapCashMove = r => ({
  id: str(r.id), dayId: str(r.day_id), direction: r.direction,
  method: r.method, category: r.category, amount: n(r.amount),
  description: r.description || null, time: iso(r.moved_at)
});

module.exports = {
  mapDay, mapNote,
  mapInvoice, mapInvoiceItem, mapInvoiceLite, mapReturn,
  mapProduct, mapCategory, mapVial, mapOpenOp, mapStockMove, mapStocktake, mapStocktakeItem,
  mapPurchase, mapPurchaseItem, mapExpense, mapCashMove
};
