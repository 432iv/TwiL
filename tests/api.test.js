/* يوسف للعطور — backend API suite.   node tests/api.test.js
   يغطّي: المصادقة، الأيام (فتح/إغلاق/إعادة فتح)، التصنيفات (صيفية/شتوية فقط)، العطور المغلقة،
   عبوات التقسيم، المشتريات، التخصيص للتقسيم (مغلق → مل)، بيع التقسيم، بيع المغلق واستقلال الأسعار،
   المرتجعات والإلغاء، المصروفات، الصندوق، الجرد (مغلق/مفتوح/عبوات)، حركة المخزون، التقارير،
   الباركود المتعدد، النسخ الاحتياطي والاسترجاع، والحماية.
   يتطلب سيرفرًا حيًّا + قاعدة بيانات (يمسح كل البيانات في البداية).          */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const group = n => console.log("\n=== " + n + " ===");
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 FAIL: " + label + (extra !== undefined ? "  \u2192 " + JSON.stringify(extra).slice(0, 260) : "")); }
};
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;

/* عميل مع عزل كوكيز/توكن */
function device(name) {
  let cookie = null, token = null;
  return {
    name,
    get token() { return token; },
    async call(method, path, body, opts = {}) {
      const headers = { "content-type": "application/json" };
      if (cookie && !opts.noCookie) headers.cookie = cookie;
      if (token && opts.bearer) headers.authorization = "Bearer " + token;
      const res = await fetch(BASE + "/api" + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const m = /yp_session=([^;]*)/.exec(setCookie);
        if (m) cookie = m[1] === "" ? null : "yp_session=" + m[1];
      }
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (data && data.token) token = data.token;
      return { status: res.status, data };
    },
    get(p, o)     { return this.call("GET", p, undefined, o); },
    post(p, b, o) { return this.call("POST", p, b || {}, o); },
    put(p, b)     { return this.call("PUT", p, b); },
    del(p, b)     { return this.call("DELETE", p, b); },
    forgetCookie() { cookie = null; token = null; }
  };
}

const api = device("main");
const anon = device("anon");

(async () => {
  /* ═══════════ التهيئة ═══════════ */
  group("التهيئة");
  let r = await fetch(BASE + "/api/auth/status").then(x => x.json());
  if (r.setupRequired) {
    r = await api.post("/auth/setup", { username: "owner", email: "owner@yousef-perfumes.test", password: "test-pass-123" });
    check("إنشاء الحساب", r.status === 201, r.data);
  }
  r = await api.post("/auth/login", { username: "owner", password: "test-pass-123" });
  check("تسجيل الدخول", r.status === 200 && r.data.token, r.data);
  r = await api.post("/auth/login", { username: "owner", password: "wrong-pass-xxx" });
  check("كلمة مرور خاطئة مرفوضة", r.status === 401, r.status);
  r = await api.del("/data", { confirm: "DELETE" });
  check("تصفير البيانات", r.status === 200, r.data);
  r = await api.del("/data", { confirm: "no" });
  check("رفض الحذف بدون تأكيد", r.status === 400, r.status);

  /* ═══════════ الحماية ═══════════ */
  group("حماية المسارات");
  r = await anon.get("/bootstrap");
  check("bootstrap بدون جلسة → 401", r.status === 401, r.status);
  r = await anon.post("/sales", {});
  check("بيع بدون جلسة → 401", r.status === 401, r.status);
  r = await anon.post("/inventory/products/1/open-split", { pieces: 1 });
  check("تخصيص للتقسيم بدون جلسة → 401", r.status === 401, r.status);
  r = await api.get("/bootstrap", { noCookie: true, bearer: true });
  check("Bearer token يعمل بدون كوكيز", r.status === 200 && r.data.user, r.status);
  r = await api.get("/bootstrap", { noCookie: true });
  check("بدون توكن وبدون كوكيز → 401", r.status === 401, r.status);

  /* ═══════════ الأيام ═══════════ */
  group("أيام العمل");
  const today = new Date().toISOString().slice(0, 10);
  r = await api.post("/inventory/products", { name: "عطر قبل فتح يوم", salePrice: 10 });
  check("إنشاء منتج لا يتطلب يوماً مفتوحاً", r.status === 201, r.data);
  r = await api.post("/sales", { items: [{ name: "x", qty: 1, selling: 5 }], payment: "cash" });
  check("بيع بدون يوم مفتوح → 409", r.status === 409 && r.data.error === "no_open_day", r.data);
  r = await api.post("/days", { date: today });
  check("فتح يوم", r.status === 201 && r.data.day.id, r.data);
  const dayId = r.data.day.id;
  r = await api.post("/days", { date: today });
  check("يوم مفتوح بالفعل → 409", r.status === 409 && r.data.error === "day_already_open", r.data);
  r = await api.get("/days/current");
  check("اليوم الحالي", r.status === 200 && r.data.day && r.data.day.id === dayId, r.data.day);

  /* ═══════════ التصنيفات: صيفية / شتوية فقط ═══════════ */
  group("التصنيفات: صيفية / شتوية فقط");
  r = await api.get("/inventory");
  check("تصنيفان فقط", r.status === 200 && r.data.categories.length === 2, r.data.categories);
  const cats = r.data.categories;
  const summer = cats.find(c => c.code === "summer"), winter = cats.find(c => c.code === "winter");
  check("الأسماء: صيفية وشتوية", summer && summer.name === "صيفية" && winter && winter.name === "شتوية", cats);
  r = await api.post("/inventory/categories", { name: "مكياج" });
  check("إضافة تصنيف مرفوضة (403)", r.status === 403 && r.data.error === "categories_fixed", r.data);
  r = await api.del("/inventory/categories/" + summer.id);
  check("حذف تصنيف مرفوض (403)", r.status === 403, r.status);
  r = await api.put("/inventory/categories/" + summer.id, { name: "غيرها" });
  check("تعديل تصنيف مرفوض (403)", r.status === 403, r.status);
  r = await api.post("/inventory/products", { name: "تصنيف خاطئ", season: "spring" });
  check("موسم غير معروف مرفوض", r.status === 400 && r.data.error === "season_invalid", r.data);
  r = await api.get("/inventory");
  check("لا مكياج ولا تصنيفات إضافية بعد المحاولات", r.data.categories.length === 2);

  /* ═══════════ العطور (مغلق) ═══════════ */
  group("العطور: إضافة وبحث وتعديل");
  r = await api.post("/inventory/products", {
    name: "Sauvage", brand: "Dior", sizeMl: 100, productType: "ماء عطر (EDP)", season: "winter",
    purchasePrice: 150, salePrice: 220, mlPrice: 3, allowSplit: true, minStock: 2, barcode: "BAR-SAUV", notes: "الأكثر طلباً"
  });
  check("عطر مع كل الحقول", r.status === 201 && r.data.product.brand === "Dior" && r.data.product.sizeMl === 100
    && r.data.product.season === "winter" && r.data.product.category === "شتوية" && r.data.product.allowSplit === true
    && r.data.product.mlPrice === 3 && r.data.product.productType === "ماء عطر (EDP)" && r.data.product.notes, r.data);
  const sauv = r.data.product;
  check("المخزون ابتدائياً: مغلق 0 ومفتوح 0", sauv.qty === 0 && sauv.openMl === 0, sauv);

  r = await api.post("/inventory/products", { name: "Light Blue", brand: "D&G", sizeMl: 50, season: "summer",
    purchasePrice: 90, salePrice: 130, minStock: 1, qty: 3, barcode: "BAR-LB" });
  check("عطر صيفي برصيد مغلق افتتاحي", r.status === 201 && r.data.product.qty === 3 && r.data.product.season === "summer", r.data);
  const lblue = r.data.product;
  check("بدون سماح بالتقسيم افتراضياً", lblue.allowSplit === false);

  r = await api.post("/inventory/products", { name: "مكرر", barcode: "BAR-SAUV" });
  check("باركود مكرر يُرفض", r.status === 409 && r.data.error === "barcode_taken", r.data);
  r = await api.post("/inventory/products", { name: "تقسيم بلا حجم", allowSplit: true });
  check("التقسيم بدون حجم أصلي مرفوض", r.status === 400 && r.data.error === "size_required_for_split", r.data);
  r = await api.post("/inventory/products", { name: "مفتوح بلا تقسيم", sizeMl: 100, openMl: 50 });
  check("رصيد مفتوح بدون تفعيل التقسيم مرفوض", r.status === 400 && r.data.error === "split_not_allowed", r.data);

  r = await api.get("/inventory/search?q=dior");
  check("بحث بالماركة", r.status === 200 && r.data.products.some(p => p.id === sauv.id), r.data.products && r.data.products.map(p => p.name));
  r = await api.get("/inventory/search?q=sauv");
  check("بحث جزء من الاسم", r.data.products.some(p => p.id === sauv.id));
  r = await api.get("/inventory/search?q=BAR-LB");
  check("بحث بالباركود", r.data.products.length === 1 && r.data.products[0].id === lblue.id, r.data.products.map(p => p.name));
  r = await api.get("/inventory/search?q=%D8%B4%D8%AA%D9%88%D9%8A%D8%A9");
  check("بحث بالتصنيف (شتوية)", r.data.products.some(p => p.id === sauv.id), r.data.products.map(p => p.name));

  r = await api.put("/inventory/products/" + sauv.id, { salePrice: 230 });
  check("تعديل سعر العلبة", r.status === 200 && r.data.product.salePrice === 230 && r.data.product.mlPrice === 3, r.data);
  r = await api.put("/inventory/products/" + sauv.id, { mlPrice: 3.5 });
  check("تعديل سعر المل لا يغيّر سعر العلبة", r.data.product.salePrice === 230 && r.data.product.mlPrice === 3.5, r.data.product);
  r = await api.put("/inventory/products/" + sauv.id, { salePrice: 220, mlPrice: 3 });
  check("إعادة الأسعار", r.data.product.salePrice === 220 && r.data.product.mlPrice === 3);

  r = await api.post("/inventory/products/" + lblue.id + "/adjust", { direction: "in", qty: 2, note: "تسوية+" });
  check("تسوية مغلق +2", r.status === 200 && r.data.product.qty === 5, r.data);
  r = await api.post("/inventory/products/" + lblue.id + "/adjust", { direction: "out", qty: 200 });
  check("خصم أكثر من الرصيد المغلق مرفوض", r.status === 400, r.status);
  r = await api.post("/inventory/products/" + lblue.id + "/adjust", { direction: "out", qty: 2 });
  check("تسوية مغلق −2", r.data.product.qty === 3);

  r = await api.post("/inventory/products", { name: "للحذف" });
  const delProd = r.data.product.id;
  r = await api.del("/inventory/products/" + delProd);
  check("حذف منتج بدون حركة", r.status === 200, r.data);
  r = await api.del("/inventory/products/" + lblue.id);
  check("حذف منتج له حركة مرفوض", r.status === 409 && r.data.error === "product_in_use", r.data);
  r = await api.put("/inventory/products/" + lblue.id, { active: false });
  check("أرشفة منتج", r.status === 200 && r.data.product.active === false, r.data);
  r = await api.put("/inventory/products/" + lblue.id, { active: true });
  check("إلغاء الأرشفة", r.data.product.active === true);

  /* ═══════════ عبوات التقسيم ═══════════ */
  group("عبوات التقسيم (vials)");
  r = await api.post("/inventory/vials", { name: "عبوة 5 مل", sizeMl: 5, cost: 0.5, price: 1, qty: 100 });
  check("عبوة 5 مل (تكلفة 0.5 · سعر 1 · مخزون 100)", r.status === 201 && r.data.vial.sizeMl === 5 && r.data.vial.cost === 0.5
    && r.data.vial.price === 1 && r.data.vial.qty === 100 && r.data.vial.active === true, r.data);
  const v5 = r.data.vial;
  r = await api.post("/inventory/vials", { name: "عبوة 10 مل", sizeMl: 10, cost: 0.7, price: 1.5, qty: 80 });
  check("عبوة 10 مل (0.7 · 1.5 · 80)", r.status === 201 && r.data.vial.qty === 80, r.data);
  const v10 = r.data.vial;
  r = await api.post("/inventory/vials", { name: "عبوة 30 مل", sizeMl: 30, cost: 1.2, price: 2.5, qty: 40 });
  const v30 = r.data.vial;
  r = await api.post("/inventory/vials", { name: "", sizeMl: 5 });
  check("اسم عبوة فارغ مرفوض", r.status === 400, r.status);
  r = await api.post("/inventory/vials", { name: "بلا حجم" });
  check("عبوة بدون حجم مرفوضة", r.status === 400, r.status);
  r = await api.put("/inventory/vials/" + v30.id, { price: 3, active: false });
  check("تعديل عبوة وتعطيلها", r.status === 200 && r.data.vial.price === 3 && r.data.vial.active === false, r.data);
  r = await api.put("/inventory/vials/" + v30.id, { active: true });
  r = await api.post("/inventory/vials/" + v5.id + "/adjust", { direction: "in", qty: 10, note: "هدية" });
  check("تسوية عبوات +10", r.status === 200 && r.data.vial.qty === 110, r.data);
  r = await api.post("/inventory/vials/" + v5.id + "/adjust", { direction: "out", qty: 10 });
  check("تسوية عبوات −10", r.data.vial.qty === 100);
  r = await api.post("/inventory/vials/" + v5.id + "/adjust", { direction: "out", qty: 5000 });
  check("خصم عبوات أكثر من الرصيد مرفوض", r.status === 400 && r.data.error === "vial_insufficient", r.data);
  r = await api.post("/inventory/vials", { name: "عبوة للحذف", sizeMl: 3 });
  r = await api.del("/inventory/vials/" + r.data.vial.id);
  check("حذف عبوة بلا حركة", r.status === 200, r.data);
  r = await api.del("/inventory/vials/" + v5.id);
  check("حذف عبوة لها حركة مرفوض", r.status === 409 && r.data.error === "vial_in_use", r.data);

  /* ═══════════ سيناريو المستخدم النهائي: فتح ثم بيع بالتقسيم ═══════════ */
  group("السيناريو النهائي: 5 × 100 مل → 4 + 100 → 90 → 70 → 170 → 140");
  r = await api.post("/inventory/products", {
    name: "Dior Sauvage — اختبار التقسيم", brand: "Dior", sizeMl: 100, season: "winter",
    purchasePrice: 100, salePrice: 200, mlPrice: 3, allowSplit: true, minStock: 1, qty: 5,
    barcode: "FLOW-DIOR-100"
  });
  check("تهيئة 5 علب مغلقة × 100 مل وتكلفة 100 د.ل", r.status === 201 && r.data.product.qty === 5
    && r.data.product.openMl === 0 && r.data.product.purchasePrice === 100, r.data.product);
  const flowPerfume = r.data.product;
  r = await api.post("/inventory/vials", { name: "عبوة سيناريو 10 مل", sizeMl: 10, cost: 2, price: 3, qty: 20 });
  check("عبوات التقسيم مخزون مستقل (20 × 10 مل · تكلفة 2 · سعر 3)", r.status === 201 && r.data.vial.qty === 20, r.data.vial);
  const flowVial = r.data.vial;
  r = await api.get("/cashbox");
  const flowCashBefore = r.data.balance;

  r = await api.post("/inventory/products/" + flowPerfume.id + "/open-split", { pieces: 1 });
  check("فتح عبوة واحدة: 5 مغلقة → 4 مغلقة + 100 مل مفتوح", r.status === 201
    && r.data.product.qty === 4 && r.data.product.openMl === 100, r.data.product);
  check("تكلفة المل بعد فتح العبوة = 100 ÷ 100 = 1 د.ل", near(r.data.product.openCostPerMl, 1, 0.0001), r.data.product.openCostPerMl);

  r = await api.post("/sales", { items: [{ productId: flowPerfume.id, mode: "split", ml: 10, mlPrice: 3, vialId: flowVial.id, vialQty: 1, vialPrice: 3 }], payment: "cash" });
  const flowSale10 = r.data.sale;
  check("بيع 10 مل: الفاتورة 33، التكلفة 12، الربح 21", r.status === 201 && near(flowSale10.total, 33)
    && near(flowSale10.cost, 12) && near(flowSale10.profit, 21)
    && flowSale10.items[0].saleType === "split" && near(flowSale10.items[0].mlCost, 1), flowSale10);
  r = await api.get("/inventory");
  let flowStock = r.data.products.find(p => p.id === flowPerfume.id);
  check("بعد 10 مل: 4 مغلقة + 90 مل، وناقص مل لا من المغلق", flowStock.qty === 4 && near(flowStock.openMl, 90), flowStock);
  check("تكلفة العبوة مستقلة وخصم عبوة واحدة فقط", r.data.vials.find(v => v.id === flowVial.id).qty === 19);

  r = await api.post("/sales", { items: [{ productId: flowPerfume.id, mode: "split", ml: 20, mlPrice: 3, vialId: flowVial.id, vialQty: 2, vialPrice: 3 }], payment: "cash" });
  const flowSale20 = r.data.sale;
  check("بيع 20 مل إضافية: الفاتورة 66، التكلفة 24، الربح 42", r.status === 201 && near(flowSale20.total, 66)
    && near(flowSale20.cost, 24) && near(flowSale20.profit, 42)
    && flowSale20.items[0].vialQty === 2, flowSale20);
  r = await api.get("/inventory");
  flowStock = r.data.products.find(p => p.id === flowPerfume.id);
  check("بعد 20 مل أخرى: 4 مغلقة + 70 مل", flowStock.qty === 4 && near(flowStock.openMl, 70), flowStock);

  r = await api.post("/inventory/products/" + flowPerfume.id + "/open-split", { pieces: 1 });
  check("فتح عبوة ثانية: 4 → 3 مغلقة و70 + 100 = 170 مل", r.status === 201
    && r.data.product.qty === 3 && near(r.data.product.openMl, 170), r.data.product);
  check("المتوسط المرجح لتكلفة المل بقي 1 د.ل", near(r.data.product.openCostPerMl, 1, 0.0001), r.data.product.openCostPerMl);

  r = await api.post("/sales", { items: [{ productId: flowPerfume.id, mode: "split", ml: 30, mlPrice: 3, vialId: flowVial.id, vialQty: 3, vialPrice: 3 }], payment: "cash" });
  const flowSale30 = r.data.sale;
  check("بيع 30 مل: الفاتورة 99، التكلفة 36، الربح 63", r.status === 201 && near(flowSale30.total, 99)
    && near(flowSale30.cost, 36) && near(flowSale30.profit, 63)
    && flowSale30.items[0].vialQty === 3, flowSale30);
  r = await api.get("/inventory");
  flowStock = r.data.products.find(p => p.id === flowPerfume.id);
  check("النتيجة النهائية: 3 مغلقة + 140 مل تقسيم", flowStock.qty === 3 && near(flowStock.openMl, 140), flowStock);
  check("مخزون العبوات منفصل: 20 − 1 − 2 − 3 = 14", r.data.vials.find(v => v.id === flowVial.id).qty === 14);

  r = await api.get("/cashbox");
  check("الصندوق استقبل إجمالي المبيعات الثلاث 198 د.ل", near(r.data.balance, flowCashBefore + 198), { before: flowCashBefore, now: r.data.balance });
  r = await api.get("/reports/sales?group=type");
  const flowSplitReport = r.data.rows.find(x => x.label === "split");
  check("تقرير النوع: 60 مل · مبيعات 198 · تكلفة 72 · ربح 126", r.status === 200 && flowSplitReport
    && near(flowSplitReport.ml, 60) && near(flowSplitReport.total, 198)
    && near(flowSplitReport.cost, 72) && near(flowSplitReport.profit, 126), flowSplitReport);
  r = await api.get("/reports/perfumes");
  const flowPerfumeReport = r.data.byPerfume.find(x => x.id === flowPerfume.id);
  const flowVialReport = r.data.vials.find(x => x.id === flowVial.id);
  check("تقرير العطور يربط الـ60 مل بالعطر الصحيح", !!flowPerfumeReport && near(flowPerfumeReport.ml, 60)
    && near(flowPerfumeReport.splitTotal, 198) && near(flowPerfumeReport.cost, 72), flowPerfumeReport);
  check("تقرير العبوات يحتسب 6 عبوات بتكلفة 12 ومبيعات 18", !!flowVialReport && flowVialReport.qty === 6
    && near(flowVialReport.cost, 12) && near(flowVialReport.sales, 18), flowVialReport);
  r = await api.get("/reports/dashboard");
  const flowDashboardPerfume = (r.data.openPerfumes || []).find(x => x.id === flowPerfume.id);
  check("لوحة التحكم تعرض 140 مل مفتوحًا بعد البيع", !!flowDashboardPerfume && near(flowDashboardPerfume.openMl, 140), r.data.openPerfumes);

  /* ═══════════ المشتريات ═══════════ */
  group("المشتريات: عطور مغلقة + عبوات");
  r = await api.get("/cashbox");
  const cashStart = r.data.balance;
  r = await api.post("/purchases", { items: [{ productId: sauv.id, qty: 5, unitCost: 150 }], paid: true, notes: "توريد ديور" });
  check("شراء 5 قطع مغلقة", r.status === 201 && /^PUR-/.test(r.data.purchase.purchaseNo) && near(r.data.purchase.total, 750), r.data);
  const purSauv = r.data.purchase;
  r = await api.get("/inventory");
  let sv = r.data.products.find(p => p.id === sauv.id);
  check("الرصيد المغلق = 5 والمفتوح 0", sv.qty === 5 && sv.openMl === 0, { q: sv.qty, o: sv.openMl });
  check("البند من نوع عطر", purSauv.items[0].type === "perfume");
  r = await api.get("/cashbox");
  check("الشراء المدفوع خصم 750 من الصندوق", near(r.data.balance, cashStart - 750), { cashStart, now: r.data.balance });

  r = await api.post("/purchases", { items: [
    { type: "vial", vialId: v10.id, qty: 20, unitCost: 0.8 },
    { newVial: { name: "عبوة 50 مل", sizeMl: 50, price: 4 }, qty: 10, unitCost: 2 },
    { newProduct: { name: "Bleu de Chanel", brand: "Chanel", sizeMl: 100, season: "winter", salePrice: 300, mlPrice: 4, allowSplit: true, minStock: 1 }, qty: 2, unitCost: 210 }
  ], paid: false });
  check("شراء عبوات + عبوة جديدة + عطر جديد في فاتورة واحدة", r.status === 201 && near(r.data.purchase.total, 20 * 0.8 + 20 + 420), r.data.purchase && r.data.purchase.total);
  const purMixed = r.data.purchase;
  check("أنواع البنود (vial/vial/perfume)", purMixed.items.map(i => i.type).join() === "vial,vial,perfume", purMixed.items.map(i => i.type));
  r = await api.get("/inventory");
  const v10b = r.data.vials.find(v => v.id === v10.id);
  check("مخزون عبوات 10مل = 100 وتكلفة متوسطة (80×0.7+20×0.8)/100 = 0.72", v10b.qty === 100 && near(v10b.cost, 0.72, 0.011), v10b);
  const v50 = r.data.vials.find(v => v.name === "عبوة 50 مل");
  check("عبوة جديدة من الشراء", v50 && v50.qty === 10 && v50.sizeMl === 50 && v50.price === 4 && near(v50.cost, 2), v50);
  const bleu = r.data.products.find(p => p.name === "Bleu de Chanel");
  check("عطر جديد من الشراء مع الماركة والحجم", bleu && bleu.qty === 2 && bleu.brand === "Chanel" && bleu.sizeMl === 100 && near(bleu.purchasePrice, 210) && bleu.allowSplit, bleu);
  r = await api.get("/cashbox");
  check("الشراء الآجل لم يخصم من الصندوق", near(r.data.balance, cashStart - 750), r.data.balance);

  r = await api.post("/purchases", { items: [{ productId: sauv.id, qty: 1, unitCost: 160 }], paid: true });
  const purExtra = r.data.purchase;
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("متوسط التكلفة المرجح (5×150+1×160)/6 = 151.67", sv.qty === 6 && near(sv.purchasePrice, 151.67, 0.011), { q: sv.qty, avg: sv.purchasePrice });
  r = await api.post("/purchases/" + purExtra.id + "/cancel");
  check("إلغاء شراء يعكس الكمية والمتوسط", r.status === 200 && r.data.purchase.status === "cancelled", r.data);
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("بعد الإلغاء: 5 قطع ومتوسط 150", sv.qty === 5 && near(sv.purchasePrice, 150), { q: sv.qty, avg: sv.purchasePrice });

  r = await api.post("/purchases", { items: [{ vialId: v10.id, qty: 5, unitCost: 1 }], paid: true });
  const purVial = r.data.purchase;
  r = await api.post("/purchases/" + purVial.id + "/cancel");
  check("إلغاء شراء عبوات", r.status === 200, r.data);
  r = await api.get("/inventory");
  check("مخزون العبوات رجع 100", r.data.vials.find(v => v.id === v10.id).qty === 100);

  /* ═══════════ تخصيص للتقسيم ═══════════ */
  group("تخصيص للتقسيم (مغلق → مل)");
  r = await api.post("/inventory/products/" + lblue.id + "/open-split", { pieces: 1 });
  check("تقسيم غير مسموح لعطر بلا allow_split", r.status === 400 && r.data.error === "split_not_allowed", r.data);
  r = await api.post("/inventory/products/" + sauv.id + "/open-split", { pieces: 9 });
  check("تخصيص أكثر من الرصيد المغلق مرفوض", r.status === 400 && r.data.error === "stock_insufficient", r.data);
  r = await api.post("/inventory/products/" + sauv.id + "/open-split", { pieces: 0 });
  check("عدد صفر مرفوض", r.status === 400, r.status);
  r = await api.post("/inventory/products/" + sauv.id + "/open-split", { pieces: 1, note: "فتح أول" });
  check("تخصيص قطعة واحدة", r.status === 201, r.data);
  check("النتيجة: 4 مغلقة + 100 مل مفتوحة", r.data.product.qty === 4 && r.data.product.openMl === 100, { q: r.data.product.qty, o: r.data.product.openMl });
  check("تكلفة المل = 150 ÷ 100 = 1.5", near(r.data.product.openCostPerMl, 1.5, 0.0001), r.data.product.openCostPerMl);
  check("سجل العملية", r.data.operation.pieces === 1 && r.data.operation.mlAdded === 100 && r.data.operation.sealedAfter === 4 && r.data.operation.openAfter === 100, r.data.operation);
  r = await api.get("/inventory/open-operations?productId=" + sauv.id);
  check("قائمة عمليات التخصيص", r.status === 200 && r.data.operations.length === 1 && r.data.operations[0].note === "فتح أول", r.data);
  r = await api.get("/inventory/movements?productId=" + sauv.id + "&reason=open_split");
  check("حركة المخزون: خروج مغلق + دخول مفتوح بسبب open_split", r.data.movements.length === 2
    && r.data.movements.some(m => m.kind === "sealed" && m.qtyOut === 1 && m.unit === "pcs")
    && r.data.movements.some(m => m.kind === "open" && m.qtyIn === 100 && m.unit === "ml"), r.data.movements);
  r = await api.get("/inventory/movements?kind=open");
  check("فلترة الحركة بالنوع (مفتوح فقط)", r.data.movements.length >= 1 && r.data.movements.every(m => m.kind === "open"), r.data.movements.length);

  /* ═══════════ بيع التقسيم ═══════════ */
  group("بيع التقسيم");
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 10, vialId: v10.id }], payment: "cash" });
  check("بيع 10 مل + عبوة 10 مل", r.status === 201 && /^INV-/.test(r.data.sale.invoice), r.data);
  const invSplit = r.data.sale;
  const it = invSplit.items[0];
  check("السعر = 10 × 3 + 1.5 = 31.5", near(invSplit.total, 31.5) && near(it.total, 31.5), { total: invSplit.total, line: it.total });
  check("بند تقسيم يسجل العطر والمل والعبوة وتكلفتها وسعرها", it.saleType === "split" && it.isSplit && it.ml === 10 && it.mlPrice === 3
    && it.vialId === v10.id && it.vialSize === 10 && it.vialQty === 1 && near(it.vialCost, 0.72) && it.vialPrice === 1.5 && it.product === "Sauvage", it);
  check("التكلفة = 10 × 1.5 + 0.72 = 15.72 والربح 15.78", near(it.cost, 15.72) && near(invSplit.profit, 15.78), { cost: it.cost, profit: invSplit.profit });
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("المفتوح 90 مل والمغلق ما زال 4", sv.openMl === 90 && sv.qty === 4, { o: sv.openMl, q: sv.qty });
  check("عبوات 10 مل نقصت واحدة (99) وعبوات 5 مل لم تتأثر", r.data.vials.find(v => v.id === v10.id).qty === 99 && r.data.vials.find(v => v.id === v5.id).qty === 100);
  r = await api.get("/inventory/movements?productId=" + sauv.id + "&reason=split_sale");
  check("حركة المل: خروج 10 مل", r.data.movements.length === 1 && r.data.movements[0].kind === "open" && r.data.movements[0].qtyOut === 10, r.data.movements);
  r = await api.get("/inventory/movements?vialId=" + v10.id + "&reason=split_sale");
  check("حركة العبوة: خروج واحدة", r.data.movements.length === 1 && r.data.movements[0].kind === "vial" && r.data.movements[0].qtyOut === 1, r.data.movements);

  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 5, vialId: v5.id }], payment: "cash" });
  check("بيع 5 مل: 5×3+1 = 16", r.status === 201 && near(r.data.sale.total, 16), r.data.sale && r.data.sale.total);
  const invSplit5 = r.data.sale;
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 7.5, vialId: v10.id }], payment: "cash" });
  check("كمية يدوية 7.5 مل: 22.5+1.5 = 24", r.status === 201 && near(r.data.sale.total, 24) && r.data.sale.items[0].ml === 7.5, r.data);
  const invSplit75 = r.data.sale;
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("المفتوح 90 − 5 − 7.5 = 77.5", near(sv.openMl, 77.5), sv.openMl);

  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 20, mlPrice: 2.5, vialId: v30.id, vialPrice: 2 }], payment: "card" });
  check("تجاوز سعر المل والعبوة للسطر: 20×2.5 + 2 = 52", r.status === 201 && near(r.data.sale.total, 52), r.data);
  const invOver = r.data.sale;
  r = await api.get("/inventory");
  check("سعر المل المعتمد للمنتج لم يتغير بالتجاوز", r.data.products.find(p => p.id === sauv.id).mlPrice === 3);

  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 500, vialId: v10.id }], payment: "cash" });
  check("مل أكثر من المتوفر مرفوض", r.status === 400 && r.data.error === "open_stock_insufficient", r.data);
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 50, vialId: v5.id }], payment: "cash" });
  check("عبوة أصغر من الكمية مرفوضة", r.status === 400 && r.data.error === "vial_too_small", r.data);
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 50, vialId: v5.id, vialQty: 10 }], payment: "cash" });
  check("50 مل في 10 عبوات × 5 مل مسموح: 150 + 10 = 160", r.status === 201 && near(r.data.sale.total, 160), r.data);
  const invMulti = r.data.sale;
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("المفتوح 77.5 − 20 − 50 = 7.5 وعبوات 5 مل: 100−1−10 = 89", near(sv.openMl, 7.5) && r.data.vials.find(v => v.id === v5.id).qty === 89, { o: sv.openMl, v5: r.data.vials.find(v => v.id === v5.id).qty });
  r = await api.post("/sales", { items: [
    { productId: sauv.id, mode: "split", ml: 5, vialId: v5.id },
    { productId: sauv.id, mode: "split", ml: 5, vialId: v5.id }
  ], payment: "cash" });
  check("سطران بنفس العطر يتجاوزان المتوفر معاً (10 > 7.5) مرفوضان", r.status === 400 && r.data.error === "open_stock_insufficient", r.data);
  r = await api.post("/sales", { items: [{ productId: lblue.id, mode: "split", ml: 5, vialId: v5.id }], payment: "cash" });
  check("عطر غير مسموح بتقسيمه مرفوض", r.status === 400 && r.data.error === "split_not_allowed", r.data);
  r = await api.post("/sales", { items: [{ productId: bleu.id, mode: "split", ml: 5, vialId: v5.id }], payment: "cash" });
  check("عطر مفعّل للتقسيم لكن بلا رصيد مفتوح مرفوض", r.status === 400 && r.data.error === "open_stock_insufficient", r.data);
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 5, vialId: v5.id, vialQty: 1000 }], payment: "cash" });
  check("عبوات أكثر من المخزون مرفوضة", r.status === 400 && (r.data.error === "vial_insufficient"), r.data);
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 0, vialId: v5.id }], payment: "cash" });
  check("مل = صفر مرفوض", r.status === 400 && r.data.error === "ml_invalid", r.data);
  r = await api.post("/sales", { items: [{ mode: "split", ml: 5, name: "حر" }], payment: "cash" });
  check("بيع تقسيم بدون منتج مرفوض", r.status === 400 && r.data.error === "split_needs_product", r.data);
  r = await api.post("/sales", { items: [{ productId: sauv.id, mode: "split", ml: 5 }], payment: "cash" });
  check("بيع تقسيم بدون عبوة (عبوة العميل) مسموح: 15", r.status === 201 && near(r.data.sale.total, 15) && r.data.sale.items[0].vialId === null, r.data);
  const invNoVial = r.data.sale;
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("المفتوح 2.5 مل", near(sv.openMl, 2.5), sv.openMl);

  /* ═══════════ بيع المغلق واستقلال الأسعار ═══════════ */
  group("بيع المغلق واستقلال سعر العلبة عن سعر المل");
  r = await api.post("/sales", { items: [{ productId: sauv.id, qty: 1, wholesale: 150, selling: 220 }], payment: "cash" });
  check("بيع علبة مغلقة بـ 220 (وليس 100×3)", r.status === 201 && near(r.data.sale.total, 220) && r.data.sale.items[0].saleType === "sealed", r.data);
  const invSealed = r.data.sale;
  check("ربح العلبة المغلقة 70", near(invSealed.profit, 70), invSealed.profit);
  r = await api.get("/inventory");
  sv = r.data.products.find(p => p.id === sauv.id);
  check("المغلق 3 والمفتوح لم يتأثر 2.5", sv.qty === 3 && near(sv.openMl, 2.5), { q: sv.qty, o: sv.openMl });
  r = await api.post("/sales", { items: [{ productId: sauv.id, qty: 1, selling: 215 }], payment: "cash" });
  check("بيع بدون wholesale يأخذ تكلفة العلبة تلقائياً", r.status === 201 && near(r.data.sale.items[0].wholesale, 150) && near(r.data.sale.profit, 65), r.data.sale && r.data.sale.items[0]);
  const invSealed2 = r.data.sale;
  r = await api.post("/sales", { items: [{ productId: sauv.id, qty: 99, selling: 220 }], payment: "cash" });
  check("كمية مغلقة أكبر من المخزون مرفوضة", r.status === 400 && r.data.error === "stock_insufficient", r.data);
  r = await api.post("/sales", { items: [{ productId: sauv.id, qty: 2, selling: 220 }, { productId: sauv.id, qty: 2, selling: 220 }], payment: "cash" });
  check("سطران مغلقان بنفس العطر يتجاوزان المتوفر (4 > 3) مرفوضان", r.status === 400 && r.data.error === "stock_insufficient", r.data);

  /* فاتورة مختلطة: مغلق + تقسيم + بند حر + خصم */
  r = await api.post("/sales", { items: [
    { productId: lblue.id, qty: 1, wholesale: 90, selling: 130 },
    { productId: bleu.id, qty: 0 + 1, wholesale: 210, selling: 300 },
    { name: "تغليف هدايا", qty: 1, wholesale: 2, selling: 10 }
  ], payment: "cash", discount: 20 });
  check("فاتورة مختلطة بخصم: (130+300+10) − 20 = 420", r.status === 201 && near(r.data.sale.total, 420) && r.data.sale.items.length === 3, r.data);
  const invMixed = r.data.sale;
  check("البند الحر محفوظ ضمن البنود", invMixed.items.some(i => i.product === "تغليف هدايا" && i.productId === null), invMixed.items);

  /* تقسيم من Bleu بعد فتح علبة */
  r = await api.post("/inventory/products/" + bleu.id + "/open-split", { pieces: 1, unitCost: 200 });
  check("تخصيص مع تعديل التكلفة يدوياً (200 → 2 لكل مل)", r.status === 201 && near(r.data.product.openCostPerMl, 2, 0.0001) && r.data.product.qty === 0 && r.data.product.openMl === 100, r.data.product);
  r = await api.post("/inventory/products/" + bleu.id + "/open-split", { pieces: 1 });
  check("لا مغلق متبقٍ للتخصيص", r.status === 400 && r.data.error === "stock_insufficient", r.data);
  r = await api.post("/inventory/products/" + bleu.id + "/adjust", { direction: "in", qty: 1, note: "علبة إضافية" });
  r = await api.post("/inventory/products/" + bleu.id + "/open-split", { pieces: 1 });
  check("تخصيص ثانٍ: 200 مل ومتوسط تكلفة مرجّح (100×2 + 100×2.1)/200 = 2.05",
    r.status === 201 && r.data.product.openMl === 200 && near(r.data.product.openCostPerMl, 2.05, 0.0001), r.data.product);
  /* مل يدوي مع تعديل تكلفة المل */
  r = await api.put("/inventory/products/" + bleu.id, { mlPrice: 4, openCostPerMl: 1.8 });
  check("تعديل تكلفة المل يدوياً", r.status === 200 && near(r.data.product.openCostPerMl, 1.8, 0.0001), r.data.product);
  r = await api.post("/sales", { items: [{ productId: bleu.id, mode: "split", ml: 30, vialId: v30.id }], payment: "cash" });
  check("بيع 30 مل: 30×4 + 3(سعر العبوة) = 123", r.status === 201 && near(r.data.sale.total, 123), r.data);
  check("تكلفة التقسيم = 30×1.8 + 1.2 = 55.2", near(r.data.sale.items[0].cost, 55.2), r.data.sale.items[0]);
  const invBleu = r.data.sale;

  /* ═══════════ تعديل فاتورة ═══════════ */
  group("تعديل وإلغاء وحذف الفواتير (تقسيم)");
  r = await api.get("/inventory");
  const before = { open: r.data.products.find(p => p.id === bleu.id).openMl, v30: r.data.vials.find(v => v.id === v30.id).qty };
  r = await api.put("/sales/" + invBleu.id, { items: [{ productId: bleu.id, mode: "split", ml: 10, vialId: v10.id }], payment: "cash", discount: 0 });
  check("تعديل فاتورة تقسيم (30 مل/عبوة 30 → 10 مل/عبوة 10): 40+1.5", r.status === 200 && near(r.data.sale.total, 41.5), r.data);
  r = await api.get("/inventory");
  check("التعديل أعاد 30 مل وعبوة 30 ثم خصم 10 مل وعبوة 10", near(r.data.products.find(p => p.id === bleu.id).openMl, before.open + 30 - 10) && r.data.vials.find(v => v.id === v30.id).qty === before.v30 + 1, 
    { open: r.data.products.find(p => p.id === bleu.id).openMl, before });

  r = await api.post("/sales/" + invBleu.id + "/cancel");
  check("إلغاء فاتورة تقسيم", r.status === 200 && r.data.sale.status === "cancelled", r.data);
  r = await api.get("/inventory");
  check("الإلغاء أعاد المل والعبوة", near(r.data.products.find(p => p.id === bleu.id).openMl, before.open + 30), r.data.products.find(p => p.id === bleu.id).openMl);
  check("متوسط تكلفة المل بعد الإرجاع يبقى مستقراً (1.8)", near(r.data.products.find(p => p.id === bleu.id).openCostPerMl, 1.8, 0.05), r.data.products.find(p => p.id === bleu.id).openCostPerMl);
  r = await api.del("/sales/" + invBleu.id);
  check("حذف فاتورة ملغاة (لا ازدواج في الإرجاع)", r.status === 200);
  r = await api.get("/inventory");
  check("لا ازدواج: المل ما زال بعد الإلغاء والحذف", near(r.data.products.find(p => p.id === bleu.id).openMl, before.open + 30));

  /* ═══════════ المرتجعات ═══════════ */
  group("المرتجعات");
  r = await api.get("/inventory");
  const preRet = { open: r.data.products.find(p => p.id === sauv.id).openMl, v10: r.data.vials.find(v => v.id === v10.id).qty, q: r.data.products.find(p => p.id === sauv.id).qty };
  r = await api.post("/sales/" + invSplit.id + "/returns", { returns: [{ itemId: invSplit.items[0].id, qty: 1 }], reason: "الزبون غيّر رأيه" });
  check("مرتجع بند تقسيم", r.status === 201 && near(r.data.returns[0].amount, 31.5) && r.data.returns[0].restocked === true, r.data);
  r = await api.get("/inventory");
  check("المرتجع أعاد 10 مل وعبوة 10 مل", near(r.data.products.find(p => p.id === sauv.id).openMl, preRet.open + 10) && r.data.vials.find(v => v.id === v10.id).qty === preRet.v10 + 1,
    { open: r.data.products.find(p => p.id === sauv.id).openMl, v10: r.data.vials.find(v => v.id === v10.id).qty, preRet });
  r = await api.get("/sales/" + invSplit.id);
  check("الفاتورة صارت «مُرجعة» والربح الفعلي 0", r.data.sale.status === "returned" && near(r.data.sale.effProfit, 0) && near(r.data.sale.effTotal, 0), r.data.sale);
  r = await api.post("/sales/" + invSplit.id + "/returns", { returns: [{ itemId: invSplit.items[0].id, qty: 1 }] });
  check("مرتجع مكرر لنفس البند مرفوض", r.status === 400, r.data);

  r = await api.post("/sales/" + invSplit5.id + "/returns", { returns: [{ itemId: invSplit5.items[0].id, qty: 1, restock: false }] });
  check("مرتجع تقسيم بدون إعادة للمخزون", r.status === 201 && r.data.returns[0].restocked === false, r.data);
  r = await api.get("/inventory");
  check("لم تعد المليلترات ولا العبوة", near(r.data.products.find(p => p.id === sauv.id).openMl, preRet.open + 10) && r.data.vials.find(v => v.id === v5.id).qty === 89, 
    { open: r.data.products.find(p => p.id === sauv.id).openMl, v5: r.data.vials.find(v => v.id === v5.id).qty });
  r = await api.get("/sales/" + invSplit5.id);
  check("خسارة التكلفة تبقى: الربح الفعلي = −التكلفة (5×1.5+0.5 = 8)", near(r.data.sale.effProfit, -8), r.data.sale.effProfit);
  r = await api.post("/sales/" + invSplit5.id + "/cancel");
  check("إلغاء فاتورة بعد مرتجع بلا إعادة لا يعيد شيئاً", r.status === 200);
  r = await api.get("/inventory");
  check("ما زال المفتوح كما هو (لا إرجاع مزدوج)", near(r.data.products.find(p => p.id === sauv.id).openMl, preRet.open + 10), r.data.products.find(p => p.id === sauv.id).openMl);

  r = await api.post("/sales/" + invSealed2.id + "/returns", { returns: [{ itemId: invSealed2.items[0].id, qty: 1 }] });
  check("مرتجع علبة مغلقة", r.status === 201 && near(r.data.returns[0].amount, 215), r.data);
  r = await api.get("/inventory");
  check("عادت العلبة للرصيد المغلق (2 → 3)", r.data.products.find(p => p.id === sauv.id).qty === preRet.q + 1, { q: r.data.products.find(p => p.id === sauv.id).qty, pre: preRet.q });
  r = await api.put("/sales/" + invSealed2.id, { items: [{ productId: sauv.id, qty: 1, selling: 200 }] });
  check("تعديل فاتورة بها مرتجعات مرفوض", r.status === 409 && r.data.error === "invoice_has_returns", r.data);

  r = await api.post("/sales/" + invOver.id + "/cancel");
  check("إلغاء فاتورة بطاقة (تقسيم 20 مل)", r.status === 200);
  r = await api.post("/sales/" + invOver.id + "/cancel");
  check("إلغاء ملغاة مرفوض", r.status === 409, r.status);

  /* ═══════════ المصروفات والصندوق ═══════════ */
  group("المصروفات والصندوق");
  r = await api.post("/expenses", { category: "rent", amount: 300, notes: "إيجار الشهر" });
  check("تسجيل مصروف", r.status === 201, r.data);
  const exp1 = r.data.expense;
  r = await api.post("/expenses", { category: "food", amount: 10 });
  check("تصنيف مصروف غير مسموح مرفوض", r.status === 400, r.status);
  r = await api.put("/expenses/" + exp1.id, { category: "electricity", amount: 250 });
  check("تعديل مصروف", r.status === 200 && r.data.expense.category === "electricity", r.data);
  r = await api.post("/expenses", { category: "other", amount: 50 });
  r = await api.del("/expenses/" + r.data.expense.id);
  check("حذف مصروف", r.status === 200, r.data);

  r = await api.post("/cashbox/deposit", { amount: 2000, note: "إيداع" });
  check("إيداع", r.status === 201, r.data);
  r = await api.post("/cashbox/withdraw", { amount: 100, note: "سحب" });
  check("سحب", r.status === 201, r.data);
  r = await api.post("/cashbox/withdraw", { amount: 999999, note: "أكثر من الرصيد" });
  check("سحب أكثر من الرصيد مرفوض", r.status === 400 && r.data.error === "insufficient_cash", r.data);
  r = await api.get("/cashbox");
  check("رصيد الصندوق", r.status === 200 && typeof r.data.balance === "number" && r.data.movements.length > 0, r.data.balance);
  const manual = r.data.movements.find(m => m.category === "deposit");
  const balBefore = r.data.balance;
  r = await api.del("/cashbox/movements/" + manual.id);
  check("حذف حركة إيداع يدوية", r.status === 200, r.data);
  r = await api.get("/cashbox");
  check("الحذف عدّل الرصيد", near(r.data.balance, balBefore - manual.amount, 0.01));
  const saleMove = r.data.movements.find(m => m.category === "sale");
  r = await api.del("/cashbox/movements/" + saleMove.id);
  check("حذف حركة بيع مرفوض", r.status === 400 || r.status === 409, r.status);

  /* ═══════════ الجرد ═══════════ */
  group("الجرد: مغلق / مفتوح (مل) / عبوات");
  r = await api.get("/inventory");
  const sv2 = r.data.products.find(p => p.id === sauv.id), vv10 = r.data.vials.find(v => v.id === v10.id);
  r = await api.post("/inventory/stocktakes", { note: "جرد تجريبي", lines: [
    { type: "sealed", productId: sauv.id, countedQty: sv2.qty - 1 },
    { type: "open", productId: sauv.id, countedQty: 12.5 },
    { type: "vial", vialId: v10.id, countedQty: vv10.qty - 3 }
  ]});
  check("تنفيذ جرد بثلاثة أنواع", r.status === 201 && r.data.stocktake.lines === 3 && r.data.stocktake.diffLines === 3, r.data);
  const st = r.data.stocktake;
  r = await api.get("/inventory");
  const sv3 = r.data.products.find(p => p.id === sauv.id);
  check("الجرد عدّل المغلق والمفتوح والعبوات", sv3.qty === sv2.qty - 1 && near(sv3.openMl, 12.5) && r.data.vials.find(v => v.id === v10.id).qty === vv10.qty - 3,
    { q: sv3.qty, o: sv3.openMl, v10: r.data.vials.find(v => v.id === v10.id).qty });
  r = await api.get("/inventory/stocktakes/" + st.id);
  check("تفاصيل الجرد تفصل الأنواع (sealed/open/vial) مع الفرق",
    r.status === 200 && ["sealed", "open", "vial"].every(t => r.data.items.some(i => i.type === t))
    && near(r.data.items.find(i => i.type === "open").diff, 12.5 - sv2.openMl) && r.data.items.find(i => i.type === "sealed").diff === -1
    && r.data.items.find(i => i.type === "vial").diff === -3, r.data.items);
  r = await api.get("/inventory/stocktakes");
  check("قائمة الجرد بعدد الأسطر لكل نوع", r.status === 200 && r.data.stocktakes.length === 1 && r.data.stocktakes[0].sealedLines === 1
    && r.data.stocktakes[0].openLines === 1 && r.data.stocktakes[0].vialLines === 1, r.data.stocktakes);
  r = await api.get("/inventory/movements?reason=adjustment&kind=vial");
  check("حركة تسوية العبوات من الجرد", r.data.movements.some(m => m.qtyOut === 3 && m.kind === "vial"), r.data.movements);
  r = await api.get("/inventory/movements?reason=adjustment&kind=open");
  check("حركة تسوية المفتوح من الجرد", r.data.movements.some(m => m.kind === "open" && m.unit === "ml"), r.data.movements);
  r = await api.post("/inventory/stocktakes", { lines: [{ type: "sealed", productId: sauv.id, countedQty: sv3.qty }] });
  check("جرد مطابق بلا فروقات", r.status === 201 && r.data.stocktake.diffLines === 0, r.data);

  /* ═══════════ الباركود المتعدد ═══════════ */
  group("الباركود (متعدد) والبيع السريع");
  r = await api.post("/inventory/barcode-batches", { productName: "Eros", qty: 6, groups: [
    { barcodes: ["EROS-1", "EROS-2"], wholesalePrice: 100, salePrice: 160 },
    { barcodes: ["EROS-3"], wholesalePrice: 105, salePrice: 170 }
  ]});
  check("دفعة باركود: عطر جديد بـ 3 باركودات ورصيد 6", r.status === 201 && r.data.product.qty === 6, r.data);
  const eros = r.data.product;
  r = await api.get("/inventory/barcodes");
  const codes = r.data.barcodes.filter(b => b.productId === eros.id);
  check("خريطة الباركودات تعيد الأكواد الثلاثة بأسعارها", codes.length === 3 && codes.find(c => c.barcode === "EROS-3").salePrice === 170 && codes.find(c => c.barcode === "EROS-1").salePrice === 160, codes);
  check("خريطة الباركود تحمل الرصيد المغلق والمفتوح", codes[0].qty === 6 && codes[0].openMl === 0 && "allowSplit" in codes[0], codes[0]);
  r = await api.post("/inventory/barcode-batches", { productName: "Other", qty: 1, groups: [{ barcodes: ["EROS-2"], wholesalePrice: 1, salePrice: 2 }] });
  check("باركود مكرر في دفعة جديدة مرفوض", r.status === 409 && r.data.error === "barcode_taken", r.data);
  r = await api.post("/inventory/products", { name: "تعارض مع باركود إضافي", barcode: "EROS-3" });
  check("باركود منتج جديد يتعارض مع باركود إضافي مرفوض", r.status === 409, r.data);
  r = await api.get("/inventory/search?q=EROS-3");
  check("بحث بالباركود الإضافي", r.data.products.some(p => p.id === eros.id), r.data.products.map(p => p.name));
  r = await api.post("/sales", { items: [{ productId: eros.id, qty: 2, wholesale: 105, selling: 170 }], payment: "cash" });
  check("بيع سريع بسعر الباركود الثالث (2 × 170)", r.status === 201 && near(r.data.sale.total, 340), r.data);
  r = await api.get("/bootstrap");
  check("bootstrap يحمل الباركودات والعبوات", Array.isArray(r.data.barcodes) && r.data.barcodes.length >= 4 && Array.isArray(r.data.vials) && r.data.vials.length >= 4, { b: r.data.barcodes.length, v: r.data.vials && r.data.vials.length });

  /* ═══════════ التقارير ═══════════ */
  group("التقارير");
  r = await api.get("/reports/dashboard");
  check("لوحة التحكم", r.status === 200 && r.data.today && r.data.inventory && r.data.grand, r.status);
  check("today: مبيعات وربح وفواتير ومصروفات وصندوق", typeof r.data.today.sales === "number" && typeof r.data.today.profit === "number"
    && r.data.today.count > 0 && typeof r.data.today.expenses.total === "number" && typeof r.data.cashBalance === "number", r.data.today);
  check("today.saleTypes: مغلق وتقسيم", r.data.today.saleTypes && r.data.today.saleTypes.sealed.total > 0 && r.data.today.saleTypes.split.total > 0 && r.data.today.saleTypes.split.ml > 0, r.data.today.saleTypes);
  check("العطور المفتوحة والمل المتبقي", Array.isArray(r.data.openPerfumes) && r.data.openPerfumes.some(p => p.id === sauv.id && near(p.openMl, 12.5)), r.data.openPerfumes);
  check("الأكثر مبيعاً", Array.isArray(r.data.topSelling) && r.data.topSelling.length > 0 && "pieces" in r.data.topSelling[0] && "ml" in r.data.topSelling[0], r.data.topSelling);
  check("نواقص العطور + نواقص العبوات", Array.isArray(r.data.inventory.lowStock) && r.data.inventory.vials && Array.isArray(r.data.inventory.vials.low), r.data.inventory);
  check("المخزون: قطع مغلقة + مل مفتوح", r.data.inventory.sealedQty > 0 && r.data.inventory.openMl > 0, r.data.inventory);
  check("عمليات أخيرة", Array.isArray(r.data.recentInvoices) && r.data.recentInvoices.length > 0 && Array.isArray(r.data.recentPurchases), true);

  r = await api.get("/reports/sales?group=day");
  check("مبيعات باليوم", r.status === 200 && r.data.rows.length >= 1, r.data.rows && r.data.rows.length);
  r = await api.get("/reports/sales?group=product");
  check("مبيعات بالمنتج (مغلق + مل)", r.status === 200 && r.data.rows.some(x => x.label === "Sauvage" && x.qty >= 1 && x.ml > 0), r.data.rows);
  r = await api.get("/reports/sales?group=method");
  check("مبيعات بالطريقة", r.status === 200 && r.data.rows.length >= 1, r.data.rows);
  r = await api.get("/reports/sales?group=type");
  check("مبيعات مغلقة مقابل تقسيم", r.status === 200 && r.data.rows.some(x => x.label === "sealed") && r.data.rows.some(x => x.label === "split" && x.ml > 0), r.data.rows);
  r = await api.get("/reports/sales?group=size");
  check("مبيعات حسب حجم التقسيم (5/10/20/50…)", r.status === 200 && r.data.rows.length >= 2 && r.data.rows.every(x => typeof x.label === "number"), r.data.rows);
  check("حجم 10 مل موجود (بعد مرتجع/تعديل) أو 7.5/50", r.data.rows.some(x => [5, 7.5, 10, 50].includes(x.label)), r.data.rows.map(x => x.label));

  r = await api.get("/reports/perfumes");
  check("تقرير العطور", r.status === 200 && r.data.sealed && r.data.split && Array.isArray(r.data.byPerfume) && Array.isArray(r.data.bySize) && Array.isArray(r.data.vials), r.status);
  const rp = r.data;
  check("تقرير العطور: مبيعات مغلقة (قطع، مبلغ، ربح)", rp.sealed.pieces >= 1 && rp.sealed.total > 0 && rp.sealed.profit > 0, rp.sealed);
  check("تقرير العطور: التقسيم (مل، مبلغ، ربح، مبيعات العبوات وتكلفتها)", rp.split.ml > 0 && rp.split.total > 0 && rp.split.vialSales > 0 && rp.split.vialCost > 0 && rp.split.profit > 0, rp.split);
  check("تقرير العطور: مبيعات حسب العطر وحسب الحجم وحسب العبوة", rp.byPerfume.length >= 2 && rp.bySize.length >= 1 && rp.vials.length >= 1, { p: rp.byPerfume.length, s: rp.bySize.length, v: rp.vials.length });
  check("تقرير العطور: عمليات التخصيص للتقسيم", rp.openOps.count >= 3 && rp.openOps.ml >= 300, rp.openOps);
  check("تقرير العطور: مشتريات عطور وعبوات", rp.purchases.perfumes > 0 && rp.purchases.vials > 0, rp.purchases);
  check("تقرير العطور: المخزون مغلق/مفتوح/عبوات", rp.stock.sealedQty > 0 && rp.stock.openMl > 0 && rp.stock.vialQty > 0, rp.stock);
  check("صافي الربح = ربح المبيعات − المصروفات", near(rp.netProfit, rp.totalProfit - rp.expenses, 0.02), { n: rp.netProfit, p: rp.totalProfit, e: rp.expenses });
  check("إجمالي الربح = ربح المغلق + ربح التقسيم", near(rp.totalProfit, rp.sealed.profit + rp.split.profit, 0.02), { t: rp.totalProfit, s: rp.sealed.profit, p: rp.split.profit });
  r = await api.get("/reports/perfumes?from=2999-01-01");
  check("تقرير العطور لفترة بلا بيانات = أصفار", r.status === 200 && r.data.sealed.total === 0 && r.data.split.total === 0 && r.data.totalProfit === 0, r.data.sealed);
  r = await api.get("/reports/perfumes?from=" + today + "&to=" + today);
  check("تقرير العطور بنطاق تاريخ", r.status === 200 && r.data.split.total > 0, r.status);

  r = await api.get("/reports/pnl");
  check("الأرباح والخسائر", r.status === 200 && r.data.sales && r.data.expenses && typeof r.data.netProfit === "number", r.data);
  check("pnl: صافي = ربح − مصروفات", near(r.data.netProfit, r.data.sales.profit - r.data.expenses.total, 0.02), r.data.netProfit);
  r = await api.get("/reports/inventory");
  check("تقرير المخزون: القيم (مغلق/مفتوح/عبوات)", r.status === 200 && r.data.value && r.data.value.openMl >= 0 && r.data.value.vialQty > 0 && Array.isArray(r.data.sealedVsOpen), r.data.value);
  check("مغلق مقابل مفتوح لكل عطر", r.data.sealedVsOpen.some(x => x.id === sauv.id && x.sealedQty >= 0 && near(x.openMl, 12.5)), r.data.sealedVsOpen);
  check("الأكثر مبيعاً في تقرير المخزون", r.data.topSelling.length > 0);

  /* ═══════════ إغلاق اليوم وإعادة فتحه ═══════════ */
  group("إغلاق اليوم وتجميده وإعادة فتحه");
  r = await api.get("/cashbox");
  const balBeforeClose = r.data.balance;
  r = await api.post("/days/" + dayId + "/close");
  check("إغلاق اليوم", r.status === 200 && r.data.cashBalanceAtClose !== null, r.data);
  check("لقطة الإغلاق تتضمن تفصيل مغلق/تقسيم", r.data.totals.saleTypes && r.data.totals.saleTypes.split.ml > 0 && r.data.totals.saleTypes.sealed.total > 0, r.data.totals.saleTypes);
  const closedTotals = r.data.totals;
  r = await api.post("/days/" + dayId + "/close");
  check("إغلاق يوم مغلق مرفوض", r.status === 409, r.status);
  r = await api.post("/sales", { items: [{ name: "بعد الإغلاق", qty: 1, wholesale: 0, selling: 5 }], payment: "cash" });
  check("بيع بعد الإغلاق مرفوض", r.status === 409 && r.data.error === "no_open_day", r.data);
  r = await api.post("/inventory/products/" + sauv.id + "/open-split", { pieces: 1 });
  check("تخصيص للتقسيم بعد الإغلاق مرفوض", r.status === 409 && r.data.error === "no_open_day", r.data);
  r = await api.get("/days/" + dayId);
  check("حزمة اليوم مجمّدة", r.data.frozen === true && r.data.sales.length > 0 && r.data.cashMovements.length > 0, { s: r.data.sales.length, c: r.data.cashMovements.length });
  check("رصيد الإغلاق مطابق", near(r.data.cashBalanceAtClose, balBeforeClose, 0.01), { close: r.data.cashBalanceAtClose, live: balBeforeClose });
  r = await api.post("/days", { date: today });
  check("فتح يوم بنفس التاريخ مرفوض (يُستخدم «إعادة الفتح»)", r.status === 409 && r.data.error === "day_exists", r.data);

  r = await api.post("/days/" + dayId + "/reopen");
  check("إعادة فتح اليوم المغلق", r.status === 200 && r.data.day.status === "open", r.data);
  r = await api.get("/days/" + dayId);
  check("بعد إعادة الفتح: لا لقطة مجمّدة", r.data.frozen === false && r.data.day.status === "open", r.data.frozen);
  r = await api.post("/days/" + dayId + "/reopen");
  check("إعادة فتح يوم مفتوح مرفوض", r.status === 409, r.status);
  r = await api.post("/sales", { items: [{ productId: eros.id, qty: 1, wholesale: 100, selling: 160 }], payment: "cash" });
  check("البيع يعمل من جديد بعد إعادة الفتح", r.status === 201, r.data);
  r = await api.post("/inventory/products/" + sauv.id + "/adjust", { direction: "in", qty: 1, target: "sealed" });
  r = await api.post("/inventory/products/" + sauv.id + "/open-split", { pieces: 1 });
  check("التخصيص يعمل من جديد بعد إعادة الفتح", r.status === 201 && near(r.data.product.openMl, 112.5), r.data.product);
  r = await api.post("/days/" + dayId + "/close");
  check("إغلاق ثانٍ بلقطة جديدة", r.status === 200 && r.data.totals.count >= closedTotals.count, r.data.totals && r.data.totals.count);
  const finalClose = r.data;
  r = await api.post("/days", { date: "2020-05-05" });
  const otherId = r.data.day && r.data.day.id;
  check("فتح يوم بتاريخ آخر", r.status === 201, r.data);
  r = await api.post("/days/" + dayId + "/reopen");
  check("إعادة فتح مرفوضة مع وجود يوم مفتوح آخر", r.status === 409 && r.data.error === "day_already_open", r.data);
  r = await api.post("/days/" + otherId + "/close");
  r = await api.del("/days/" + otherId);
  check("حذف يوم فارغ", r.status === 200, r.data);
  r = await api.post("/days/" + dayId + "/reopen");
  r = await api.post("/days/" + dayId + "/close");
  check("إعادة فتح ثم إغلاق (دورة كاملة)", r.status === 200, r.data);

  /* ═══════════ الإعدادات ═══════════ */
  group("الإعدادات");
  r = await api.put("/settings", { shopName: "" });
  check("تفريغ اسم المحل يعيد الاسم الافتراضي", r.status === 200 && r.data.settings.shop_name === "يوسف للعطور", r.data.settings);
  r = await api.get("/settings");
  check("اسم المحل الافتراضي: يوسف للعطور", r.status === 200 && r.data.settings.shop_name === "يوسف للعطور", r.data.settings);
  r = await api.put("/settings", { shopName: "يوسف للعطور — طرابلس", currency: "د.ل", shopPhone: "0910000000", defaultMinStock: 4 });
  check("حفظ إعدادات المحل", r.status === 200 && r.data.settings.shop_name === "يوسف للعطور — طرابلس" && r.data.settings.default_min_stock === 4, r.data.settings);
  r = await api.put("/settings", { barcodeQuickSale: false, barcodeRegisterMode: true });
  check("إعدادات الباركود", r.data.settings.barcode_quick_sale === false && r.data.settings.barcode_register_mode === true, r.data.settings);
  r = await api.put("/settings", { barcodeQuickSale: true, barcodeRegisterMode: false });
  r = await api.put("/payment-methods", { code: "unpaid", active: false });
  check("تعطيل «غير خالص»", r.status === 200 && r.data.method.active === false, r.data);
  r = await api.put("/payment-methods", { code: "cash", active: false });
  check("تعطيل النقد مرفوض (مثبّت)", r.status === 400, r.data);
  r = await api.put("/payment-methods", { code: "unpaid", active: true });

  /* ═══════════ الحساب ═══════════ */
  group("الحساب وكلمة المرور والجلسات");
  r = await api.get("/auth/status");
  check("حالة الجلسة", r.status === 200 && r.data.authenticated === true && r.data.user.username === "owner", r.data);

  /* ═══════════ النسخ الاحتياطي ═══════════ */
  group("النسخ الاحتياطي والاسترجاع");
  r = await api.get("/backup");
  check("تنزيل نسخة", r.status === 200 && r.data.data && Array.isArray(r.data.data.invoices), r.data.data && Object.keys(r.data.data).length);
  check("النسخة تتضمن الجداول الجديدة", ["vials", "vial_movements", "open_operations", "product_barcodes"].every(k => Array.isArray(r.data.data[k])), Object.keys(r.data.data));
  check("لا وحدات هواتف في النسخة", !("phone_units" in r.data.data));
  const backup = r.data.data;
  const counts = { invoices: backup.invoices.length, vials: backup.vials.length, opens: backup.open_operations.length, bcs: backup.product_barcodes.length, products: backup.products.length };
  const sauvBefore = backup.products.find(p => p.name === "Sauvage");
  check("النسخة فيها فواتير وعمليات تخصيص وباركودات", counts.invoices >= 8 && counts.opens >= 4 && counts.bcs >= 4 && counts.vials >= 4, counts);
  r = await api.post("/backup/restore", { confirm: "RESTORE", data: { garbage: true } });
  check("استرجاع ملف تالف مرفوض", r.status === 400 && r.data.error === "backup_invalid", r.data);
  r = await api.post("/backup/restore", { confirm: "RESTORE", data: { days: [], invoices: [], phone_units: [], products: [] } });
  check("استرجاع نسخة نظام قديم (هواتف) مرفوض", r.status === 400 && r.data.error === "backup_incompatible", r.data);
  r = await api.post("/backup/restore", { confirm: "x", data: backup });
  check("الاسترجاع يتطلب تأكيداً", r.status === 400, r.status);
  r = await api.get("/cashbox");
  const cashBeforeWipe = r.data.balance;
  r = await api.del("/data", { confirm: "DELETE" });
  check("تصفير قبل الاسترجاع", r.status === 200);
  r = await api.get("/inventory");
  check("بعد التصفير: لا عطور ولا عبوات والتصنيفان باقيان", r.data.products.length === 0 && r.data.vials.length === 0 && r.data.categories.length === 2, { p: r.data.products.length, v: r.data.vials.length, c: r.data.categories.length });
  r = await api.post("/backup/restore", { confirm: "RESTORE", data: backup });
  check("استرجاع النسخة", r.status === 200, r.data);
  r = await api.get("/bootstrap");
  const bs = r.data;
  check("الفواتير رجعت", bs.invoices.length === counts.invoices, { got: bs.invoices.length, want: counts.invoices });
  check("العبوات رجعت بأرصدتها", bs.vials.length === counts.vials && bs.vials.find(v => v.id === v10.id) && bs.vials.find(v => v.id === v10.id).qty === backup.vials.find(v => String(v.id) === String(v10.id)).quantity, bs.vials.length);
  check("الباركودات رجعت", bs.barcodes.length === counts.bcs, bs.barcodes.length);
  const sauvAfter = bs.products.find(p => p.name === "Sauvage");
  check("عطر Sauvage رجع بالمغلق والمفتوح وتكلفة المل وسعر المل", sauvAfter && sauvAfter.qty === sauvBefore.quantity && near(sauvAfter.openMl, sauvBefore.open_ml)
    && near(sauvAfter.openCostPerMl, sauvBefore.open_cost_per_ml, 0.0001) && sauvAfter.mlPrice === 3 && sauvAfter.salePrice === 220 && sauvAfter.brand === "Dior" && sauvAfter.season === "winter", sauvAfter);
  check("بنود التقسيم رجعت (مل/عبوة/تكلفة)", bs.invoices.some(i => i.items.some(x => x.isSplit && x.ml > 0 && x.vialId && x.vialCost > 0)), true);
  check("الأيام رجعت (لا يوجد يوم مفتوح)", bs.days.every(d => d.status === "closed"), bs.days.length);
  check("تصنيفان فقط بعد الاسترجاع", bs.categories.length === 2 && bs.categories.map(c => c.code).sort().join() === "summer,winter", bs.categories);
  r = await api.get("/cashbox");
  check("الرصيد رجع", near(r.data.balance, cashBeforeWipe, 0.01), { got: r.data.balance, want: cashBeforeWipe });
  r = await api.get("/inventory/open-operations");
  check("سجل التخصيص رجع", r.data.operations.length === counts.opens, r.data.operations.length);
  r = await api.get("/inventory/movements?limit=2000");
  check("حركة المخزون رجعت (مغلق/مفتوح/عبوات)", ["sealed", "open", "vial"].every(k => r.data.movements.some(m => m.kind === k)), r.data.movements.length);
  r = await api.get("/reports/perfumes");
  check("تقرير العطور بعد الاسترجاع مطابق", near(r.data.split.total, rp.split.total + 0, 5000) && r.data.split.ml > 0, r.data.split);
  /* مواصلة العمل بعد الاسترجاع: مسلسلات سليمة */
  r = await api.post("/days", { date: "2031-01-01" });
  check("فتح يوم بعد الاسترجاع", r.status === 201, r.data);
  r = await api.post("/sales", { items: [{ productId: sauvAfter.id, qty: 1, selling: 220 }], payment: "cash" });
  check("بيع جديد بعد الاسترجاع (التسلسلات سليمة)", r.status === 201 && /^INV-/.test(r.data.sale.invoice), r.data);
  r = await api.post("/inventory/vials", { name: "عبوة جديدة بعد الاسترجاع", sizeMl: 15, qty: 5 });
  check("إنشاء عبوة بعد الاسترجاع (تسلسل العبوات سليم)", r.status === 201, r.data);

  /* ═══════════ bootstrap النهائي ═══════════ */
  group("الإقلاع النهائي");
  r = await api.get("/bootstrap");
  const b = r.data;
  check("شكل bootstrap", b.user && b.settings && Array.isArray(b.days) && Array.isArray(b.invoices) &&
    Array.isArray(b.purchases) && Array.isArray(b.products) && Array.isArray(b.categories) && Array.isArray(b.vials) &&
    Array.isArray(b.notes) && typeof b.cashBalance === "number" && b.grand, true);
  check("الفواتير تحمل بنودها", b.invoices.every(i => Array.isArray(i.items)), true);
  check("المنتجات فيها حقول العطر", b.products.every(p => typeof p.active === "boolean" && "brand" in p && "sizeMl" in p && "openMl" in p && "mlPrice" in p && "allowSplit" in p && !("kind" in p) && !("imei" in p)), b.products[0]);
  check("لا حقول هواتف في بنود الفواتير", b.invoices.every(i => i.items.every(x => !("imei" in x) && !("unitId" in x))), true);

  console.log("\n══════════════════════════════");
  console.log("نجح: " + pass + " · فشل: " + fail);
  if (fail) process.exit(1);
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
