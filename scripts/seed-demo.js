"use strict";
/* يوسف للعطور — بذر بيانات تجريبية واقعية (يمسح البيانات الحالية أولاً).
   الاستخدام:  node scripts/seed-demo.js
   المتغيرات:  SEED_USER / SEED_PASS (افتراضيًا owner / demo-pass-1234)          */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const USER = process.env.SEED_USER || "owner";
const PASS = process.env.SEED_PASS || "demo-pass-1234";

let token = "";
async function call(method, path, body) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(method + " " + path + " → " + res.status + " " + JSON.stringify(data).slice(0, 160));
  return data;
}

(async () => {
  console.log("▸ تجهيز حساب تجريبي ...");
  const status = await (await fetch(BASE + "/api/auth/status")).json();
  if (status.setupRequired) {
    await fetch(BASE + "/api/auth/setup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, email: "demo@yousef-perfumes.ly", password: PASS })
    });
    console.log("  أُنشئ الحساب: " + USER + " / " + PASS);
  }
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  if (!login.ok) {
    console.error("✗ تعذر الدخول — إذا نسيت كلمة المرور حددها: SEED_PASS=... node scripts/seed-demo.js");
    process.exit(1);
  }
  token = (await login.json()).token;
  await call("DELETE", "/data", { confirm: "DELETE" });
  console.log("✓ تم مسح البيانات السابقة");

  await call("PUT", "/settings", {
    shopName: "يوسف للعطور",
    currency: "د.ل", shopPhone: "091-234-5678",
    shopAddress: "شارع الجمهورية، طرابلس",
    invoiceFooter: "شكراً لزيارتكم — العطر يبقى أثراً جميلاً"
  });

  /* ── عبوات التقسيم ── */
  console.log("▸ عبوات التقسيم والعطور ...");
  const vial = (name, sizeMl, cost, price, qty) =>
    call("POST", "/inventory/vials", { name, sizeMl, cost, price, qty, minStock: 15 }).then(r => r.vial);
  const v5 = await vial("عبوة 5 مل", 5, 0.5, 1, 100);
  const v10 = await vial("عبوة 10 مل", 10, 0.7, 1.5, 80);
  const v20 = await vial("عبوة 20 مل", 20, 1, 2, 60);
  const v30 = await vial("عبوة 30 مل", 30, 1.2, 2.5, 40);
  await vial("عبوة 50 مل", 50, 1.8, 3.5, 12);

  /* ── العطور ── */
  const perfume = body => call("POST", "/inventory/products", Object.assign({ minStock: 2 }, body)).then(r => r.product);
  const sauvage = await perfume({ name: "Sauvage", brand: "Dior", sizeMl: 100, productType: "ماء عطر (EDP)", season: "winter",
    purchasePrice: 150, salePrice: 220, mlPrice: 3, allowSplit: true, qty: 6, barcode: "3348901419375" });
  const bleu = await perfume({ name: "Bleu de Chanel", brand: "Chanel", sizeMl: 100, productType: "ماء عطر (EDP)", season: "winter",
    purchasePrice: 210, salePrice: 300, mlPrice: 4, allowSplit: true, qty: 4, barcode: "3145891073604" });
  const aventus = await perfume({ name: "Aventus", brand: "Creed", sizeMl: 100, productType: "بارفان (Extrait)", season: "winter",
    purchasePrice: 520, salePrice: 700, mlPrice: 9, allowSplit: true, qty: 2, barcode: "3508441001114" });
  const lightBlue = await perfume({ name: "Light Blue", brand: "Dolce & Gabbana", sizeMl: 100, productType: "ماء تواليت (EDT)", season: "summer",
    purchasePrice: 95, salePrice: 140, mlPrice: 1.8, allowSplit: true, qty: 5, barcode: "3423473020400" });
  const acqua = await perfume({ name: "Acqua di Giò", brand: "Armani", sizeMl: 100, productType: "ماء تواليت (EDT)", season: "summer",
    purchasePrice: 110, salePrice: 160, mlPrice: 2, allowSplit: true, qty: 4, barcode: "3360372058230" });
  await perfume({ name: "Khamrah", brand: "Lattafa", sizeMl: 100, productType: "ماء عطر (EDP)", season: "winter",
    purchasePrice: 38, salePrice: 65, mlPrice: 0.9, allowSplit: true, qty: 9, barcode: "6290360593180" });
  await perfume({ name: "Eros", brand: "Versace", sizeMl: 50, productType: "ماء تواليت (EDT)", season: "summer",
    purchasePrice: 70, salePrice: 105, minStock: 3, qty: 1, barcode: "8011003809220" });
  await perfume({ name: "Oud Wood", brand: "Tom Ford", sizeMl: 50, productType: "دهن عود", season: "winter",
    purchasePrice: 340, salePrice: 480, minStock: 1, qty: 3, barcode: "888066000239" });
  await perfume({ name: "Libre", brand: "Yves Saint Laurent", sizeMl: 90, productType: "ماء عطر (EDP)", season: "summer",
    purchasePrice: 125, salePrice: 185, minStock: 2, qty: 2, barcode: "3614272648425" });

  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const back = days => { const d = new Date(today); d.setDate(d.getDate() - days); return d; };

  /* ── أمس: يوم كامل يُغلق ── */
  console.log("▸ يوم أمس (يُغلق ويثبّت) ...");
  const yday = await call("POST", "/days", { date: iso(back(1)) });
  await call("POST", "/purchases", { items: [
    { productId: sauvage.id, qty: 2, unitCost: 152 },
    { type: "vial", vialId: v10.id, qty: 40, unitCost: 0.72 },
    { newProduct: { name: "Hawas", brand: "Rasasi", sizeMl: 100, season: "summer", salePrice: 90, mlPrice: 1.2, allowSplit: true, minStock: 2 }, qty: 4, unitCost: 55 }
  ], paid: true, notes: "توريد بداية الأسبوع" });
  await call("POST", "/inventory/products/" + sauvage.id + "/open-split", { pieces: 1, note: "فتح علبة للتقسيم" });
  await call("POST", "/inventory/products/" + lightBlue.id + "/open-split", { pieces: 1 });
  await call("POST", "/sales", { items: [{ productId: sauvage.id, mode: "split", ml: 10, vialId: v10.id }], payment: "cash" });
  await call("POST", "/sales", { items: [
    { productId: sauvage.id, mode: "split", ml: 5, vialId: v5.id },
    { productId: lightBlue.id, mode: "split", ml: 20, vialId: v20.id }
  ], payment: "cash" });
  await call("POST", "/sales", { items: [{ productId: bleu.id, qty: 1, selling: 300 }], payment: "card" });
  await call("POST", "/sales", { items: [{ productId: acqua.id, qty: 1, selling: 160 }, { name: "تغليف هدايا", qty: 1, wholesale: 2, selling: 10 }], payment: "cash", discount: 10 });
  await call("POST", "/expenses", { category: "transport", amount: 40, notes: "توصيل طلبات" });
  await call("POST", "/expenses", { category: "internet", amount: 120, notes: "تجديد الإنترنت" });
  await call("POST", "/notes", { text: "الموزّع وعد بدفعة Creed جديدة الأسبوع القادم" });
  await call("POST", "/days/" + yday.day.id + "/close");

  /* ── اليوم: يوم مفتوح بعمليات جارية ── */
  console.log("▸ اليوم (يوم مفتوح) ...");
  await call("POST", "/days", { date: iso(today) });
  await call("POST", "/cashbox/deposit", { amount: 1500, note: "رصيد افتتاحي للصندوق" });
  await call("POST", "/inventory/products/" + aventus.id + "/open-split", { pieces: 1, note: "تقسيم للزبائن الخاصين" });
  await call("POST", "/sales", { items: [{ productId: aventus.id, mode: "split", ml: 10, vialId: v10.id }], payment: "card", notes: "زبون دائم" });
  await call("POST", "/sales", { items: [{ productId: sauvage.id, mode: "split", ml: 30, vialId: v30.id }], payment: "cash" });
  await call("POST", "/sales", { items: [{ productId: sauvage.id, qty: 1, selling: 220 }], payment: "cash", discount: 10 });
  await call("POST", "/sales", { items: [{ productId: lightBlue.id, mode: "split", ml: 10, vialId: v10.id }], payment: "unpaid", debtorName: "خالد المهيدي" });
  await call("POST", "/expenses", { category: "electricity", amount: 90, notes: "فاتورة كهرباء" });
  await call("POST", "/notes", { text: "زبون يسأل عن Aventus بالتقسيم 50 مل — تحضير عبوة 50 مل" });

  const boot = await call("GET", "/bootstrap");
  console.log("\n✓ اكتمل البذر التجريبي:");
  console.log("   عطور: " + boot.products.length + " · عبوات: " + boot.vials.length + " · فواتير: " + boot.invoices.length + " · رصيد الصندوق: " + boot.cashBalance.toFixed(2) + " د.ل");
  console.log("   الدخول: " + USER + " / " + PASS);
})().catch(e => { console.error("✗", e.message); process.exit(1); });
