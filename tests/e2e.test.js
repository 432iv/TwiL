/* يوسف للعطور — End-to-end browser test against the real backend.
   يشغّل الواجهة (yousef-perfumes.html) في كروميوم حقيقي ويجرّب:
   الدخول · بدء اليوم · إضافة عطر + عبوات · شراء 5 علب · تخصيص للتقسيم (5 → 4 + 100 مل)
   · بيع 10 مل (90 مل + عبوة 10 مل) · بيع علبة مغلقة · مرتجع · باركود والبيع السريع
   · مصروف · صندوق · جرد · تقارير · إغلاق اليوم وإعادة فتحه · نسخ احتياطي واسترجاع.
   run:  NODE_PATH=/path/to/node_modules node tests/e2e.test.js   (يتطلب playwright) */
let chromium;
try { chromium = require("playwright-core").chromium; }
catch (_) { chromium = require("playwright").chromium; }
const fs = require("fs");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CREDS = { username: "owner", password: "test-pass-123" };

let pass = 0, fail = 0;
const group = n => console.log("\n=== " + n + " ===");
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 FAIL: " + label + (extra !== undefined ? "  \u2192 " + String(extra).slice(0, 240) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, e = 0.02) => Math.abs(Number(a) - Number(b)) <= e;

(async () => {
  /* ── تهيئة: امسح البيانات عبر الـ API ثم افتح المتصفح ── */
  group("التهيئة");
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CREDS)
  });
  const { token } = await login.json();
  const api = async (method, path, body) => {
    const r = await fetch(BASE + "/api" + path, {
      method, headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  check("تصفير البيانات عبر API", (await api("DELETE", "/data", { confirm: "DELETE" })).status === 200);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, bypassCSP: true });
  const page = await ctx.newPage();
  const pageErrors = [], externalRequests = [];
  const appOrigin = new URL(BASE).origin;
  page.on("pageerror", e => pageErrors.push(String(e)));
  page.on("request", req => {
    try { if (/^https?:$/.test(new URL(req.url()).protocol) && new URL(req.url()).origin !== appOrigin) externalRequests.push(req.url()); }
    catch (_) {}
  });
  page.on("dialog", d => d.accept());

  const toast = async (txt, timeout = 9000) => {
    await page.waitForFunction(t => {
      const el = document.querySelector("#toast");
      return el.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes(t);
    }, txt, { timeout });
  };
  const toastText = async () => (await page.textContent("#toastMsg")) || "";
  const nav = async v => { await page.click('.nav-pill[data-view="' + v + '"]'); await page.waitForSelector("#view-" + v + ".active"); await sleep(300); };
  const boot = async () => (await api("GET", "/bootstrap")).data;
  const closeModal = async sel => {
    await page.waitForFunction(s => document.querySelector(s).classList.contains("show"), sel, { timeout: 4000 }).catch(() => {});
    await page.keyboard.press("Escape");
    await page.waitForFunction(s => !document.querySelector(s).classList.contains("show"), sel, { timeout: 6000 });
  };
  const toggle = sel => page.locator(sel).evaluate(el => el.click());

  await page.goto(BASE + "/?desktop=1", { waitUntil: "networkidle" });
  const title = await page.title();
  check("عنوان الصفحة: يوسف للعطور", title.includes("يوسف للعطور"), title);
  check("وضع Desktop يخفي تسجيل الدخول عبر Google غير المتاح Offline", (await page.$('a[href="/api/auth/google"]')) === null);
  check("لا أثر لاسم النظام القديم في الصفحة", !/Blue Mobile|IMEI|iPhone/i.test(await page.content()));

  /* ── بوابة الدخول ── */
  group("بوابة الدخول");
  await page.waitForSelector("#authGate:not([hidden])", { timeout: 8000 });
  check("شاشة الدخول بهوية يوسف للعطور", (await page.textContent(".gate-title")).includes("يوسف"));
  await page.fill("#loginUser", CREDS.username);
  await page.fill("#loginPass", "wrong-password");
  await page.click("#loginBtn");
  await page.waitForSelector("#gateErr:not([hidden])", { timeout: 6000 });
  check("كلمة مرور خاطئة → رسالة خطأ", (await page.textContent("#gateErr")).length > 3);
  await page.fill("#loginPass", CREDS.password);
  await page.click("#loginBtn");
  await page.waitForFunction(() => document.querySelector("#authGate").hidden, null, { timeout: 10000 });
  check("تسجيل الدخول يفتح التطبيق", await page.isVisible("#view-dashboard.active"));
  check("اسم المنظومة في الشريط الجانبي", (await page.textContent(".brand-name")).includes("يوسف للعطور"));

  /* ── محتوى لوحة التحكم فقط + تجاوب البطاقات ── */
  group("لوحة التحكم");
  check("حالة اليوم تظهر مغلقة قبل البدء", await page.getAttribute("#dayCard", "data-state") === "closed" && (await page.textContent(".day-state-closed")).includes("اليوم مغلق"));
  check("بطاقة الحالة تحتفظ بعناصر وقت البداية وإجمالي المبيعات", await page.locator("#dayStart").count() === 1 && await page.locator("#dayTotal").count() === 1);
  check("الإحصائيات اليومية الست ظاهرة", await page.locator("#view-dashboard .dashboard-stats-grid > .dashboard-stat").count() === 6);
  check("مؤشرات المخزون الثلاث ظاهرة", await page.locator("#view-dashboard .dashboard-inventory-grid > .dashboard-stat").count() === 3);
  check("العطور عند/دون الحد الأدنى تعرض 0 بوضوح عند عدم وجود نواقص", (await page.textContent("#stLow")).trim() === "0");
  check("بطاقة الترحيب والاختصارات غير موجودة", await page.locator("#view-dashboard .hero-band, #view-dashboard .shortcuts").count() === 0);
  check("الأقسام الإضافية القديمة مخفية لا محذوفة", await page.locator("#dashboard-legacy-widgets[hidden]").count() === 1 && await page.locator("#topList").count() === 1);
  let responsive = true, responsiveDetail = "";
  for (const width of [1600, 1360, 1024, 920, 768, 430, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await sleep(40);
    const layout = await page.evaluate(() => {
      const page = document.querySelector("#view-dashboard .page");
      const cards = [...document.querySelectorAll("#view-dashboard .dashboard-day-card, #view-dashboard .dashboard-stat")];
      const bounds = page.getBoundingClientRect();
      const clipped = cards.some(el => { const r = el.getBoundingClientRect(); return r.left < bounds.left - 1 || r.right > bounds.right + 1; });
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, clipped };
    });
    if (layout.overflow || layout.clipped) { responsive = false; responsiveDetail = width + "px " + JSON.stringify(layout); break; }
  }
  check("البطاقات لا تُقص ولا تخرج عن حدود الصفحة عند المقاسات المختلفة", responsive, responsiveDetail);
  await page.setViewportSize({ width: 1360, height: 900 });

  /* ── بدء اليوم ── */
  check("حالة اليوم مغلقة", await page.getAttribute("#dayCard", "data-state") === "closed");
  await page.click("#startDayBtn");
  await page.waitForFunction(() => document.querySelector("#dayCard").getAttribute("data-state") === "open", null, { timeout: 8000 });
  check("بدء يوم عمل", true);
  check("بطاقة الحالة المفتوحة تعرض وقت البداية ومبيعات اليوم", await page.isVisible("#dayStart") && await page.isVisible("#dayTotal") && (await page.textContent("#dayStart")).trim() !== "—");

  /* ── العبوات ── */
  group("عبوات التقسيم");
  await nav("inventory");
  await page.click("#addVialBtn");
  await page.waitForSelector("#vialModal.show");
  await page.fill("#vmSize", "5");
  check("اسم العبوة يُقترح من الحجم", (await page.inputValue("#vmName")) === "عبوة 5 مل", await page.inputValue("#vmName"));
  await page.fill("#vmCost", "0.5"); await page.fill("#vmPrice", "1"); await page.fill("#vmQty", "100");
  await page.click("#vmSave");
  await toast("تمت إضافة العبوة");
  await page.click("#addVialBtn");
  await page.waitForSelector("#vialModal.show");
  await page.fill("#vmSize", "10"); await page.fill("#vmCost", "0.7"); await page.fill("#vmPrice", "1.5"); await page.fill("#vmQty", "80");
  await page.click("#vmSave");
  await page.waitForFunction(() => !document.querySelector("#vialModal").classList.contains("show"));
  await sleep(500);
  let b = await boot();
  const v5 = b.vials.find(v => v.sizeMl === 5), v10 = b.vials.find(v => v.sizeMl === 10);
  check("عبوة 5 مل: تكلفة 0.5 · سعر 1 · مخزون 100", v5 && v5.cost === 0.5 && v5.price === 1 && v5.qty === 100, JSON.stringify(v5));
  check("عبوة 10 مل: تكلفة 0.7 · سعر 1.5 · مخزون 80", v10 && v10.cost === 0.7 && v10.price === 1.5 && v10.qty === 80, JSON.stringify(v10));
  await page.click('#invTabs .seg-tab[data-tab="vials"]');
  await sleep(300);
  check("جدول العبوات يعرض العبوتين", (await page.$$("#vialBody tr[data-id]")).length === 2);

  /* ── إضافة عطر ── */
  group("إضافة عطر");
  await page.click('#invTabs .seg-tab[data-tab="products"]');
  await page.click("#addProductBtn");
  await page.waitForSelector("#productModal.show");
  check("التصنيفان فقط في النافذة: صيفية وشتوية", (await page.$$("#pmSeason .seg-tab")).length === 2);
  await page.fill("#pmName", "Sauvage");
  await page.fill("#pmBrand", "Dior");
  await page.fill("#pmSize", "100");
  await page.fill("#pmType", "ماء عطر (EDP)");
  await page.fill("#pmPurchase", "150");
  await page.fill("#pmSale", "220");
  await page.fill("#pmBarcode", "3348901419375");
  await page.click("#pmSave");
  await toast("التصنيف");
  check("التصنيف إلزامي (صيفية/شتوية)", (await toastText()).includes("صيفية"));
  await page.click('#pmSeason .seg-tab[data-season="winter"]');
  await toggle("#pmAllowSplit");
  check("حقول التقسيم تظهر عند التفعيل", await page.isVisible("#pmSplitAttrs") && await page.isVisible("#pmOpenQtyWrap"));
  await page.click("#pmSave");
  await toast("سعر المل");
  check("سعر المل إلزامي عند تفعيل التقسيم", true);
  await page.fill("#pmMlPrice", "3");
  await page.click("#pmSave");
  await toast("تمت إضافة العطر");
  await page.waitForFunction(() => document.querySelector("#invBody").textContent.includes("Sauvage"), null, { timeout: 8000 });
  b = await boot();
  const sauv = b.products.find(p => p.name === "Sauvage");
  check("العطر محفوظ بكل الحقول", sauv && sauv.brand === "Dior" && sauv.sizeMl === 100 && sauv.season === "winter" && sauv.allowSplit && sauv.mlPrice === 3
    && sauv.salePrice === 220 && sauv.purchasePrice === 150 && sauv.productType === "ماء عطر (EDP)", JSON.stringify(sauv));
  check("الرصيد المغلق 0 والمفتوح 0", sauv.qty === 0 && sauv.openMl === 0);
  const rowTxt = await page.textContent("#invBody tr[data-id]");
  check("الجدول يعرض التصنيف والحجم", rowTxt.includes("شتوية") && rowTxt.includes("100"), rowTxt.slice(0, 120));

  /* ── المشتريات ── */
  group("المشتريات: عطور وعبوات");
  await nav("purchases");
  await page.click("#purRowsWrap .prod-input");
  await page.fill("#purRowsWrap .prod-input", "Sauv");
  await page.waitForSelector("#purRowsWrap .p-dd-panel.open .p-dd-item", { timeout: 6000 });
  await page.click("#purRowsWrap .p-dd-panel .p-dd-item:not(.is-new)");
  check("سعر الشراء يُملأ من تكلفة العطر", (await page.inputValue("#purRowsWrap .c-input")) === "150", await page.inputValue("#purRowsWrap .c-input"));
  for (let i = 0; i < 4; i++) await page.click("#purRowsWrap .q-inc");
  check("الكمية 5", (await page.textContent("#purRowsWrap .q")).trim() === "5");
  await page.click("#purRecordBtn");
  await toast("PUR");
  await page.waitForSelector("#purchaseModal.show", { timeout: 6000 });
  check("فاتورة شراء 5 علب = 750", (await page.textContent("#pumList")).includes("750"), (await page.textContent("#pumList")).slice(0, 100));
  await closeModal("#purchaseModal");
  /* شراء عبوات */
  await page.click("#purAddRow").catch(() => {});
  await page.click('#purRowsWrap .p-row .pk-btn[data-kind="vial"]');
  await page.selectOption("#purRowsWrap .p-row .vial-pick", String(v10.id));
  await page.fill("#purRowsWrap .p-row .c-input", "0.8");
  for (let i = 0; i < 19; i++) await page.click("#purRowsWrap .p-row .q-inc");
  await page.click("#purRecordBtn");
  await toast("PUR");
  await page.waitForSelector("#purchaseModal.show", { timeout: 6000 });
  await closeModal("#purchaseModal");
  b = await boot();
  check("الشراء رفع الرصيد المغلق إلى 5", b.products.find(p => p.id === sauv.id).qty === 5);
  const v10b = b.vials.find(v => v.id === v10.id);
  check("شراء العبوات رفع مخزونها (80 + 20 = 100) والتكلفة المتوسطة 0.72", v10b.qty === 100 && near(v10b.cost, 0.72, 0.011), JSON.stringify(v10b));
  check("قيد الصندوق: 750 + 16 مسحوبة", near(b.cashBalance, -766, 0.01), b.cashBalance);

  /* ── التخصيص للتقسيم ── */
  group("تخصيص للتقسيم");
  await nav("inventory");
  await page.click("#openSplitBtn");
  await page.waitForSelector("#splitModal.show");
  await page.click("#spmProduct");
  await page.waitForSelector("#spmPanel.open .p-dd-item", { timeout: 6000 });
  await page.click("#spmPanel .p-dd-item");
  await sleep(200);
  const prev = await page.textContent("#spmPreview");
  check("المعاينة: 5 علب ← 4 علب و100 مل", prev.includes("5 علبة") && prev.includes("4 علبة") && prev.includes("100"), prev);
  check("تكلفة العلبة مُعبّأة تلقائياً بـ 150", (await page.inputValue("#spmCost")) === "150", await page.inputValue("#spmCost"));
  await page.click("#spmConfirm");
  await toast("تم التخصيص");
  b = await boot();
  const sv = b.products.find(p => p.id === sauv.id);
  check("النتيجة: 4 علب مغلقة + 100 مل مفتوحة", sv.qty === 4 && sv.openMl === 100, { q: sv.qty, o: sv.openMl });
  await page.click('#invTabs .seg-tab[data-tab="opens"]');
  await page.waitForFunction(() => document.querySelector("#opBody").textContent.includes("Sauvage"), null, { timeout: 8000 });
  check("عملية التخصيص في سجل عمليات التقسيم", true);
  await page.click('#invTabs .seg-tab[data-tab="movements"]');
  await page.waitForFunction(() => document.querySelector("#mvBody").textContent.includes("تخصيص للتقسيم"), null, { timeout: 8000 });
  const mvTxt = await page.textContent("#mvBody");
  check("حركة المخزون تسجل التخصيص: مغلق ومفتوح", mvTxt.includes("مفتوح") && mvTxt.includes("مغلق"), mvTxt.slice(0, 160));

  /* ── بيع التقسيم من الجناح الجانبي داخل صفحة المبيعات ── */
  group("بيع التقسيم من الجناح الجانبي");
  await nav("sales");
  const removedSaleInputs = ["#discInput", "#sumDisc", "#sumDue", "#saleDateView", "#invNotes"];
  check("فاتورة البيع خالية من حقول الخصم والتاريخ والملاحظات ومساحاتها", (await page.locator("#view-sales").evaluate((view, selectors) => selectors.every(s => !view.querySelector(s)), removedSaleInputs))
    && (await page.locator("#view-sales .inv-extra").count()) === 0);
  const salePayOptions = await page.$$eval("#payCards .pay-opt", els => els.map(el => ({ text: el.textContent.trim(), hidden: el.hidden })));
  check("طرق الدفع الوحيدة الظاهرة: نقدًا، بطاقة، غير خالص", salePayOptions.length === 3
    && salePayOptions.every(x => !x.hidden)
    && salePayOptions.map(x => x.text).join("|") === "نقدًا|بطاقة|غير خالص", salePayOptions);
  await page.click('#payCards .pay-opt[data-pay="غير خالص"]');
  check("خيار غير خالص يفتح حقل المدين دون إخفاء بقية الخيارات", !(await page.$eval("#dueGroup", e => e.hidden))
    && (await page.$$eval("#payCards .pay-opt", els => els.filter(el => !el.hidden).length)) === 3);
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 768 }, { width: 1180, height: 768 }, { width: 1024, height: 768 }, { width: 768, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(size);
    await sleep(90);
    const layoutMetrics = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; };
      const layout = document.querySelector("#view-sales .sales-compose-layout");
      const invoice = document.querySelector("#view-sales .sales-invoice-card");
      const split = document.querySelector("#view-sales .sales-split-card");
      const sidebar = document.querySelector("#sidebar");
      const pay = document.querySelector("#payCards");
      const row = document.querySelector("#rowsWrap .p-row");
      const ir = rect(invoice), sr = rect(split), br = rect(sidebar), pr = rect(pay);
      const opts = Array.from(pay.querySelectorAll(".pay-opt"));
      const optionRects = opts.map(rect);
      const noOverlap = ir.right <= sr.left + 1 || sr.right <= ir.left + 1 || ir.bottom <= sr.top + 1 || sr.bottom <= ir.top + 1;
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        layoutFits: layout.scrollWidth <= layout.clientWidth + 1,
        cardsInside: ir.left >= 0 && sr.left >= 0 && ir.right <= innerWidth + 1 && sr.right <= innerWidth + 1,
        sidebarClear: br.bottom - br.top < innerHeight * 0.7 || (ir.right <= br.left + 1 && sr.right <= br.left + 1) || (ir.left >= br.right - 1 && sr.left >= br.right - 1),
        cardsSeparate: noOverlap,
        paymentFits: pay.scrollWidth <= pay.clientWidth + 1 && optionRects.every((r, i) => r.left >= pr.left - 1 && r.right <= pr.right + 1
          && opts[i].scrollWidth <= opts[i].clientWidth + 1),
        rowFits: row.scrollWidth <= row.clientWidth + 1
      };
    });
    const ok = layoutMetrics.pageWidth <= size.width + 1 && layoutMetrics.layoutFits && layoutMetrics.cardsInside
      && layoutMetrics.sidebarClear && layoutMetrics.cardsSeparate && layoutMetrics.paymentFits && layoutMetrics.rowFits;
    check("لا قص أو تداخل أو تجاوز أفقي عند عرض " + size.width + "px", ok, layoutMetrics);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.click('#payCards .pay-opt[data-pay="نقدًا"]');
  await sleep(120);
  const row = "#rowsWrap .p-row:nth-child(1)";
  const shelfItem = '#splitShelfList .split-shelf-item[data-id="' + sauv.id + '"]';
  await page.waitForSelector(shelfItem, { timeout: 6000 });
  check("الجناح يعرض العطر المفتوح فقط مع 100 مل متاح", (await page.textContent(shelfItem)).includes("100 مل"), await page.textContent(shelfItem));
  await page.click(shelfItem);
  check("اختيار العطر يفتح نموذج التقسيم في نفس صفحة المبيعات", (await page.textContent("#splitDockName")).includes("Sauvage")
    && !(await page.$eval("#splitDockForm", e => e.hidden)));
  check("المتاح يظهر 100 مل وسعر المل الافتراضي 3", (await page.textContent("#splitDockAvailable")).includes("100")
    && (await page.inputValue("#splitDockMlPrice")) === "3");
  check("الكمية الافتراضية 10 مل والعبوة 10 مل تُختار تلقائياً", (await page.inputValue("#splitDockMlInput")) === "10"
    && (await page.inputValue("#splitDockVial")) === String(v10.id), { ml: await page.inputValue("#splitDockMlInput"), vial: await page.inputValue("#splitDockVial") });
  check("الحساب الحي: الإجمالي 31.5 والتكلفة 15.72 والربح 15.78", (await page.textContent("#splitDockTotal")).includes("31.5")
    && (await page.textContent("#splitDockCost")).includes("15.72") && (await page.textContent("#splitDockProfit")).includes("15.78"),
    { total: await page.textContent("#splitDockTotal"), cost: await page.textContent("#splitDockCost"), profit: await page.textContent("#splitDockProfit") });
  check("الزر يضيف إلى سلة الفاتورة الحالية", !(await page.$eval("#splitDockAdd", e => e.disabled)));
  await page.click("#splitDockAdd");
  await sleep(250);
  check("بند التقسيم موجود في صف الفاتورة المشتركة", await page.isVisible(row + " .split-box")
    && (await page.textContent("#sumTotal")).includes("31.5"));
  const sumTxt = await page.textContent(row + " .sb-sum");
  check("ملخص بند الفاتورة يتضمن المل والعبوة والإجمالي", sumTxt.includes("31.5") && sumTxt.includes("10"), sumTxt);
  await page.click("#recordBtn");
  await toast("INV");
  await page.waitForSelector("#detailModal.show", { timeout: 6000 });
  const det = await page.textContent("#detailList");
  const detailStamp = await page.textContent("#dmSub");
  check("تفاصيل الفاتورة تعرض بند التقسيم والعبوة", det.includes("تقسيم") && det.includes("10 مل") && det.includes("31.5"), det.slice(0, 200));
  await closeModal("#detailModal");
  b = await boot();
  const sv2 = b.products.find(p => p.id === sauv.id);
  check("بعد البيع يظهر 90 مل جانبيًا ويبقى المغلق 4", sv2.openMl === 90 && sv2.qty === 4
    && (await page.textContent("#splitDockAvailable")).includes("90"), { o: sv2.openMl, q: sv2.qty });
  check("خُصمت عبوة 10 مل (99) وبقيت عبوات 5 مل 100", b.vials.find(v => v.id === v10.id).qty === 99 && b.vials.find(v => v.id === v5.id).qty === 100);
  const invSplit = b.invoices[0];
  check("التاريخ والوقت يسجلان آليًا ويظهران في سجل/تفاصيل الفاتورة", Date.parse(invSplit.time) > 0
    && det.includes("التاريخ والوقت") && /\d{1,2}:\d{2}/.test(detailStamp), { time: invSplit.time, detailStamp });
  check("الفاتورة تحفظ العطر والـ10 مل والعبوة وتكلفتها وسعرها", invSplit.items[0].isSplit && invSplit.items[0].ml === 10 && invSplit.items[0].vialSize === 10
    && near(invSplit.items[0].vialCost, 0.72) && invSplit.items[0].vialPrice === 1.5 && near(invSplit.total, 31.5), JSON.stringify(invSplit.items[0]));

  /* ── بيع مغلق + سعر مستقل ── */
  group("بيع علبة مغلقة (سعر مستقل عن سعر المل)");
  await page.click(row + " .prod-input");
  await page.fill(row + " .prod-input", "Sauv");
  await page.waitForSelector(row + " .p-dd-panel.open .p-dd-item", { timeout: 6000 });
  await page.click(row + " .p-dd-panel .p-dd-item");
  await page.click("#recordBtn");
  await toast("INV");
  await closeModal("#detailModal");
  b = await boot();
  const invSealed = b.invoices[0];
  check("علبة مغلقة بـ 220 (لا 100 × 3 = 300)", near(invSealed.total, 220) && !invSealed.items[0].isSplit, JSON.stringify(invSealed.items[0]));
  check("المغلق 3 والمفتوح ما زال 90", b.products.find(p => p.id === sauv.id).qty === 3 && b.products.find(p => p.id === sauv.id).openMl === 90);
  check("سعر المل وسعر العلبة بلا تغيير", b.products.find(p => p.id === sauv.id).mlPrice === 3 && b.products.find(p => p.id === sauv.id).salePrice === 220);

  /* ── فاتورة متعددة الأصناف: تقسيم + مغلق ── */
  group("فاتورة مختلطة وتعديلها");
  await page.click(row + " .prod-input");
  await page.fill(row + " .prod-input", "Sauv");
  await page.waitForSelector(row + " .p-dd-panel.open .p-dd-item");
  await page.click(row + " .p-dd-panel .p-dd-item");
  await page.click(row + ' .sale-mode [data-mode="split"]');
  await page.click(row + ' .ml-chip[data-ml="5"]');
  await page.click("#addRow");
  const row2 = "#rowsWrap .p-row:nth-child(2)";
  await page.click(row2 + " .prod-input");
  await page.fill(row2 + " .prod-input", "Sauv");
  await page.waitForSelector(row2 + " .p-dd-panel.open .p-dd-item");
  await page.click(row2 + " .p-dd-panel .p-dd-item");
  check("الإجمالي يظهر دون خصم فاتورة (16 + 220) = 236", (await page.textContent("#sumTotal")).includes("236"), await page.textContent("#sumTotal"));
  await page.click('#payCards .pay-opt[data-pay="بطاقة"]');
  await page.click("#recordBtn");
  await toast("INV");
  await closeModal("#detailModal");
  b = await boot();
  const invMix = b.invoices[0];
  check("فاتورة بندان: تقسيم 5 مل + مغلق ومن دون خصم", invMix.items.length === 2 && invMix.items.some(i => i.isSplit && i.ml === 5) && invMix.items.some(i => !i.isSplit) && near(invMix.total, 236) && near(invMix.discount, 0), JSON.stringify(invMix));
  /* تعديل الفاتورة من الواجهة: كل البنود */
  await page.waitForFunction(() => document.querySelector("#logBody").textContent.includes("INV-"));
  await page.click("#logBody tr:first-child .row-menu-btn");
  await page.waitForSelector("#ctxMenu.show");
  await page.click("#ctxEdit");
  await sleep(600);
  check("وضع التعديل يحمّل كل البنود (سطران)", (await page.$$("#rowsWrap .p-row")).length === 2);
  check("بند التقسيم يُحمّل بمله وعبوته", (await page.inputValue("#rowsWrap .p-row:nth-child(1) .ml-input")) === "5" && (await page.inputValue("#rowsWrap .p-row:nth-child(1) .vial-sel")) === String(v5.id));
  await page.click('#rowsWrap .p-row:nth-child(1) .ml-chip[data-ml="10"]');
  await sleep(200);
  await page.click("#recordBtn");
  await toast("تعديلات الفاتورة");
  b = await boot();
  const invEdit = b.invoices.find(i => i.id === invMix.id);
  check("بعد التعديل: 10 مل بعبوة 5 مل ×2 (20×... = 32) → 220 + 32 = 252", near(invEdit.total, 252) && near(invEdit.discount, 0) && invEdit.items.find(i => i.isSplit).ml === 10, invEdit.total);
  check("المفتوح 80 (تعديل أعاد 5 وخصم 10) وعبوات 5 مل: أُعيدت 1 وخُصمت 2 (98)", near(b.products.find(p => p.id === sauv.id).openMl, 80) && b.vials.find(v => v.id === v5.id).qty === 98 && b.vials.find(v => v.id === v10.id).qty === 99,
    JSON.stringify({ o: b.products.find(p => p.id === sauv.id).openMl, v10: b.vials.find(v => v.id === v10.id).qty }));

  /* ── المرتجع ── */
  group("المرتجع (تقسيم) من الواجهة");
  await nav("sales");
  await page.waitForFunction(() => document.querySelectorAll("#logBody tr[data-id]").length >= 3);
  const rowOfSplit = invSplit.invoice;
  await page.locator("#logBody tr", { hasText: rowOfSplit }).locator(".row-menu-btn").click();
  await page.waitForSelector("#ctxMenu.show");
  await page.click("#ctxReturn");
  await page.waitForSelector("#returnModal.show");
  check("نافذة الإرجاع تعرض خيار إعادة المل والعبوة", (await page.textContent("#returnLines")).includes("إعادة المل والعبوة"));
  await page.click("#returnLines .ret-line .rq-inc");
  await page.click("#confirmReturn");
  await toast("الإرجاع");
  b = await boot();
  check("المرتجع أعاد 10 مل وعبوة 10 مل", near(b.products.find(p => p.id === sauv.id).openMl, 90) && b.vials.find(v => v.id === v10.id).qty === 100,
    JSON.stringify({ o: b.products.find(p => p.id === sauv.id).openMl, v10: b.vials.find(v => v.id === v10.id).qty }));
  check("الفاتورة «مُرجعة» والربح الفعلي 0", b.invoices.find(i => i.invoice === rowOfSplit).status === "returned" && near(b.invoices.find(i => i.invoice === rowOfSplit).effProfit, 0));

  /* ── الباركود والبيع السريع ── */
  group("الباركود (متعدد) والبيع السريع");
  check("البيع السريع بالباركود مفعّل افتراضياً", (await boot()).settings.barcode_quick_sale === true);
  await nav("sales");
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await page.keyboard.type("3348901419375", { delay: 5 });
  await page.keyboard.press("Enter");
  await sleep(600);
  const scanned = await page.inputValue("#rowsWrap .p-row:nth-child(1) .prod-input");
  check("مسح الباركود يضيف العطر للفاتورة تلقائياً", scanned === "Sauvage", scanned);
  check("البيع السريع: سعر العلبة 220 والكمية 1", (await page.inputValue("#rowsWrap .p-row:nth-child(1) .s-input")) === "220" && (await page.textContent("#rowsWrap .p-row:nth-child(1) .q")).trim() === "1");
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await page.keyboard.type("3348901419375", { delay: 5 });
  await page.keyboard.press("Enter");
  await sleep(500);
  check("مسح نفس الباركود مرة ثانية يزيد الكمية إلى 2", (await page.textContent("#rowsWrap .p-row:nth-child(1) .q")).trim() === "2" && (await page.$$("#rowsWrap .p-row")).length === 1);
  await page.keyboard.type("0000999911112", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#bcNotFoundModal.show", { timeout: 4000 });
  check("باركود غير موجود → نافذة «العطر غير موجود»", (await page.textContent("#bcnfTitle")).includes("العطر"));
  await closeModal("#bcNotFoundModal");
  await page.click("#recordBtn");
  await toast("INV");
  await closeModal("#detailModal");
  check("بيع سريع بالباركود (علبتان)", (await boot()).products.find(p => p.id === sauv.id).qty === 0);

  /* دفعة باركود جديدة (وضع التسجيل) */
  await nav("settings");
  await toggle("#bcRegModeToggle");
  await sleep(800);
  await nav("sales");
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  for (const code of ["EROS-0001", "EROS-0002"]) { await page.keyboard.type(code, { delay: 5 }); await page.keyboard.press("Enter"); await sleep(250); }
  check("وضع التسجيل يجمع الباركودات في دفعة", (await page.textContent("#bcRegCount")).trim() === "2", await page.textContent("#bcRegCount"));
  await page.click("#bcRegOpenBtn");
  await page.waitForSelector("#bcRegModal.show");
  await page.fill("#bcBulkWholesale", "70"); await page.fill("#bcBulkSale", "105");
  await page.click("#bcBulkApplyBtn");
  await page.fill("#bcRegProductName", "Eros");
  await page.fill("#bcRegSize", "50");
  await page.fill("#bcRegQty", "6");
  await page.click("#bcRegSaveBtn");
  await toast("تم حفظ العطر");
  b = await boot();
  const eros = b.products.find(p => p.name === "Eros");
  check("دفعة الباركود: عطر جديد بـ 6 علب وباركودين", eros && eros.qty === 6 && eros.sizeMl === 50 && b.barcodes.filter(x => x.productId === eros.id).length === 2, JSON.stringify(eros && eros.qty));
  await nav("settings");
  await toggle("#bcRegModeToggle");
  await sleep(600);
  check("إيقاف وضع التسجيل", (await boot()).settings.barcode_register_mode === false);

  /* ── المصروفات والصندوق ── */
  group("المصروفات والصندوق");
  await nav("expenses");
  await page.click('.cat-chip[data-cat="rent"]');
  await page.fill("#expAmount", "300");
  await page.fill("#expNotes", "إيجار الشهر");
  await page.click("#expSaveBtn");
  await toast("المصروف");
  check("تسجيل مصروف إيجار 300", true);
  await nav("cashbox");
  const bal1 = (await boot()).cashBalance;
  await page.click("#depositBtn");
  await page.waitForSelector("#cashMoveModal.show");
  await page.fill("#cmAmount", "2000");
  await page.click("#cmConfirm");
  await page.waitForFunction(() => !document.querySelector("#cashMoveModal").classList.contains("show"), null, { timeout: 8000 });
  await sleep(500);
  check("الإيداع رفع الرصيد 2000", near((await boot()).cashBalance, bal1 + 2000, 0.01));

  /* ── الجرد ── */
  group("الجرد: مغلق / مفتوح / عبوات");
  await nav("inventory");
  await page.click('#invTabs .seg-tab[data-tab="stocktake"]');
  await page.click("#newStocktakeBtn");
  await page.waitForSelector("#stocktakeModal.show");
  const secs = await page.$$eval("#stLines .st-sec", els => els.map(e => e.textContent.trim()));
  check("الجرد يفصل المغلق (قطع) والمفتوح (مل) والعبوات (قطع)", secs.length === 3 && secs[0].includes("مغلقة") && secs[1].includes("مفتوحة") && secs[2].includes("عبوات"), secs.join(" | "));
  const openLine = page.locator('#stLines .st-line[data-type="open"]').first();
  await openLine.locator(".stl-count").fill("85.5");
  const vialLine = page.locator('#stLines .st-line[data-type="vial"]').first();
  const vSys = Number(await vialLine.getAttribute("data-sys"));
  await vialLine.locator(".stl-count").fill(String(vSys - 2));
  await sleep(300);
  check("فرق المل المفتوح يظهر فوراً (−4.5)", (await openLine.locator(".stl-diff").textContent()).trim() === "-4.5", await openLine.locator(".stl-diff").textContent());
  await page.click("#stApply");
  await toast("الجرد");
  b = await boot();
  check("الجرد عدّل المل المفتوح 85.5", near(b.products.find(p => p.id === sauv.id).openMl, 85.5));
  await page.waitForFunction(() => document.querySelector("#stBody").textContent.includes("#"), null, { timeout: 8000 });
  await page.click("#stBody tr[data-id]");
  await page.waitForSelector("#stDetailModal.show", { timeout: 6000 });
  check("تفاصيل الجرد تفصل الأنواع", (await page.textContent("#stdBody")).includes("مل مفتوحة") && (await page.textContent("#stdBody")).includes("عبوات"));
  await closeModal("#stDetailModal");

  /* ── تسوية يدوية ── */
  group("تسوية الكمية");
  await page.click('#invTabs .seg-tab[data-tab="products"]');
  await page.locator("#invBody tr[data-id]", { hasText: "Sauvage" }).click();
  await page.waitForSelector("#prodDrawer.show");
  await page.click("#pdAdjust");
  await page.waitForSelector("#adjustModal.show");
  await page.click('#adjTarget [data-target="open"]');
  await page.click('#adjDir [data-dir="in"]');
  await page.fill("#adjQty", "4.5");
  await page.click("#adjConfirm");
  await toast("تمت تسوية");
  check("تسوية مل مفتوحة +4.5", true);
  await sleep(500);
  await page.click("#prodDrawerClose");
  await sleep(400);

  /* ── التقارير ── */
  group("التقارير");
  await nav("reports");
  await page.click('#repTabs .seg-tab[data-tab="perfumes"]');
  await page.waitForFunction(() => document.querySelector("#perfBody").textContent.includes("مبيعات التقسيم"), null, { timeout: 8000 });
  const perf = await page.textContent("#perfBody");
  check("تقرير العطور: مبيعات مغلقة وتقسيم ومل مباعة وعبوات", perf.includes("مبيعات العلب المغلقة") && perf.includes("مل مباعة") && perf.includes("مبيعات العبوات") && perf.includes("المخزون الحالي"), perf.slice(0, 120));
  check("تقرير العطور: حسب الحجم وحسب العطر", perf.includes("حسب حجم التقسيم") && perf.includes("Sauvage"));
  await page.click('#repTabs .seg-tab[data-tab="sales"]');
  await page.click("#rsGroupDD .f-btn");
  await page.click('#rsGroupDD .f-item[data-f="size"]');
  await sleep(500);
  check("تقرير المبيعات حسب حجم التقسيم", (await page.textContent("#rsBody")).includes("مل"), (await page.textContent("#rsBody")).slice(0, 60));
  await page.click("#rsGroupDD .f-btn");
  await page.click('#rsGroupDD .f-item[data-f="type"]');
  await sleep(500);
  const typeTxt = await page.textContent("#rsBody");
  check("مغلق مقابل تقسيم", typeTxt.includes("تقسيم بالمل") && typeTxt.includes("علبة مغلقة"), typeTxt.slice(0, 80));
  await page.click('#repTabs .seg-tab[data-tab="pnl"]');
  await sleep(500);
  check("الأرباح والخسائر", (await page.textContent("#pnlBody")).includes("صافي الربح"));
  await page.click('#repTabs .seg-tab[data-tab="inv"]');
  await sleep(600);
  const invRep = await page.textContent("#invRepBody");
  check("تقرير المخزون: مغلق مقابل مفتوح وعبوات", invRep.includes("المغلق مقابل المفتوح") && invRep.includes("عبوات"), invRep.slice(0, 80));
  await nav("dashboard");
  await sleep(500);
  check("الرئيسية: العطور المفتوحة والمل المتبقي", (await page.textContent("#openList")).includes("Sauvage") && (await page.textContent("#openList")).includes("مل"));
  check("الرئيسية: الأكثر مبيعاً وملخص مغلق/تقسيم", (await page.textContent("#topList")).includes("Sauvage") && (await page.textContent("#salesMix")).includes("التقسيم"));
  check("الرئيسية: لا VIP ولا عروض", !/VIP|عروض اليوم|عرض اليوم/.test(await page.textContent("#view-dashboard")));

  /* ── إغلاق اليوم وإعادة فتحه ── */
  group("إغلاق اليومية وإعادة فتحها");
  await page.click("#endDayBtn");
  await page.waitForSelector("#endModal.show");
  await page.click("#confirmEnd");
  await page.waitForFunction(() => document.querySelector("#dayCard").getAttribute("data-state") === "closed", null, { timeout: 10000 });
  check("إغلاق اليومية من الواجهة", true);
  await nav("reports");
  await page.click('#repTabs .seg-tab[data-tab="days"]');
  await page.waitForFunction(() => document.querySelector("#repBody .rep-row"), null, { timeout: 8000 });
  await page.click("#repBody .rep-row");
  await page.waitForSelector("#reportDrawer.show", { timeout: 8000 });
  const dr = await page.textContent("#drawerBody");
  check("تقرير اليوم يتضمن مغلق مقابل تقسيم", dr.includes("مغلق مقابل تقسيم") && dr.includes("ملخص اليوم"), dr.slice(0, 80));
  check("زر إعادة فتح اليوم ظاهر لليوم المغلق", await page.isVisible("#reopenDayBtn"));
  await page.click("#reopenDayBtn");
  await page.waitForSelector("#deleteModal.show");
  await page.click("#confirmDelete");
  await page.waitForFunction(() => document.querySelector("#dayCard").getAttribute("data-state") === "open", null, { timeout: 10000 }).catch(() => {});
  await sleep(600);
  b = await boot();
  check("اليوم أُعيد فتحه", b.days.some(d => d.status === "open"));
  await nav("dashboard");
  check("حالة اليوم في الرئيسية «مفتوح»", await page.getAttribute("#dayCard", "data-state") === "open");
  await nav("sales");
  const row3 = "#rowsWrap .p-row:nth-child(1)";
  await page.click(row3 + " .prod-input");
  await page.fill(row3 + " .prod-input", "Eros");
  await page.waitForSelector(row3 + " .p-dd-panel.open .p-dd-item");
  await page.click(row3 + " .p-dd-panel .p-dd-item");
  await page.click("#recordBtn");
  await toast("INV");
  await closeModal("#detailModal");
  check("البيع يعمل بعد إعادة الفتح", true);
  await nav("dashboard");
  await page.click("#endDayBtn");
  await page.waitForSelector("#endModal.show");
  await page.click("#confirmEnd");
  await page.waitForFunction(() => document.querySelector("#dayCard").getAttribute("data-state") === "closed", null, { timeout: 10000 });
  check("إغلاق اليوم من جديد", true);

  /* ── النسخ الاحتياطي والاسترجاع ── */
  group("النسخ الاحتياطي والاسترجاع");
  await nav("settings");
  const before = await boot();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click("#backupBtn")]);
  const file = "/tmp/yp-backup-e2e.json";
  await dl.saveAs(file);
  const bk = JSON.parse(fs.readFileSync(file, "utf8"));
  check("اسم ملف النسخة يحمل اسم المحل", dl.suggestedFilename().startsWith("yousef-perfumes-backup-"), dl.suggestedFilename());
  check("النسخة تحتوي العطور والعبوات والعمليات والباركودات", bk.app === "Yousef Perfumes" && bk.data.vials.length === 2 && bk.data.open_operations.length >= 1 && bk.data.product_barcodes.length >= 3 && bk.data.products.length === 2, Object.keys(bk.data).join());
  await api("DELETE", "/data", { confirm: "DELETE" });
  check("بعد التصفير لا عطور", (await boot()).products.length === 0);
  await page.setInputFiles("#restoreInput", file);
  await page.waitForSelector("#deleteModal.show");
  await page.click("#confirmDelete");
  await toast("تم استرجاع");
  const after = await boot();
  const sA = after.products.find(p => p.name === "Sauvage"), sB = before.products.find(p => p.name === "Sauvage");
  check("الاسترجاع أعاد الفواتير والعبوات والعطور", after.invoices.length === before.invoices.length && after.vials.length === 2 && after.products.length === 2, JSON.stringify({ i: after.invoices.length }));
  check("الاسترجاع حافظ على المغلق والمفتوح وتكلفة المل", sA.qty === sB.qty && near(sA.openMl, sB.openMl) && near(sA.openCostPerMl, sB.openCostPerMl, 0.0001), JSON.stringify({ a: sA.openMl, b: sB.openMl }));
  check("رصيد الصندوق بعد الاسترجاع مطابق", near(after.cashBalance, before.cashBalance, 0.01));

  /* ── الثيم ── */
  group("المظهر");
  await nav("settings");
  await page.click('.seg-opt[data-theme-opt="داكن"]');
  await sleep(300);
  check("المظهر الداكن (بني داكن)", (await page.getAttribute("html", "data-theme")) === "dark");
  await page.click('.seg-opt[data-theme-opt="فاتح"]');
  await sleep(300);
  check("المظهر الفاتح (بيج) هو الافتراضي", (await page.getAttribute("html", "data-theme")) === "light");

  /* ── أخطاء الصفحة ── */
  group("أخطاء الجافاسكربت");
  const fatal = pageErrors.filter(e => !/ResizeObserver|favicon|Failed to load resource/.test(e));
  check("لا أخطاء JS غير متوقعة (" + pageErrors.length + " الكل)", fatal.length === 0, fatal[0]);
  check("لا طلبات شبكة إلى خارج التطبيق المحلي", externalRequests.length === 0, externalRequests.join(" | "));

  await browser.close();
  console.log("\n══════════════════════════════");
  console.log("نجح: " + pass + " · فشل: " + fail);
  if (fail) process.exit(1);
})().catch(e => { console.error("CRASH:", e.message); process.exit(1); });
