"use strict";
/* ═══════════════════════════════════════════════════════════════════
   يوسف للعطور — منطق العطور المشترك (مغلق / مفتوح بالمل / عبوات)

   • الرصيد المغلق  : products.quantity        (قطع)  — تكلفة القطعة = purchase_price
   • الرصيد المفتوح : products.open_ml         (مل)   — تكلفة المل   = open_cost_per_ml
   • العبوات        : vials.quantity           (قطع)  — تكلفة العبوة = vials.cost

   سعر العلبة المغلقة (sale_price) مستقل تماماً عن سعر المل (ml_price).
   ═══════════════════════════════════════════════════════════════════ */

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const r4 = v => Math.round((Number(v) || 0) * 10000) / 10000;

/* تكلفة المل الفعلية للمنتج: المتوسط المسجّل، وإلا (تكلفة العلبة ÷ حجمها) */
function mlCostOf(product) {
  const stored = Number(product.open_cost_per_ml || 0);
  if (stored > 0) return stored;
  const size = Number(product.size_ml || 0);
  return size > 0 ? r4(Number(product.purchase_price || 0) / size) : 0;
}

/* إضافة مل إلى الرصيد المفتوح مع متوسط مرجّح لتكلفة المل.
   يُرجع الصف المحدَّث. */
async function addOpenMl(client, productId, ml, costPerMl) {
  const { rows } = await client.query("SELECT open_ml, open_cost_per_ml FROM products WHERE id = $1 FOR UPDATE", [productId]);
  if (!rows.length) return null;
  const oldMl = Number(rows[0].open_ml), oldCost = Number(rows[0].open_cost_per_ml);
  const newMl = r2(oldMl + ml);
  const avg = newMl > 0 ? r4((oldMl * oldCost + ml * costPerMl) / newMl) : 0;
  const upd = await client.query(
    "UPDATE products SET open_ml = $1, open_cost_per_ml = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [newMl, avg, productId]);
  return upd.rows[0];
}

/* مقارنة مل مع هامش صغير لتفادي أخطاء الفاصلة العائمة */
const mlGt = (a, b) => r2(a) - r2(b) > 0.0001;

module.exports = { r2, r4, mlCostOf, addOpenMl, mlGt };
