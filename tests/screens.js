"use strict";
/* يوسف للعطور — لقطات شاشة للواجهة (كروميوم headless).
   run: NODE_PATH=/path/to/node_modules node tests/screens.js          */
let chromium;
try { chromium = require("playwright-core").chromium; }
catch (_) { chromium = require("playwright").chromium; }

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CREDS = { username: process.env.SEED_USER || "owner", password: process.env.SEED_PASS || "test-pass-123" };
const OUT = "screens";
const fs = require("fs");
fs.mkdirSync(OUT, { recursive: true });

const views = [
  ["dashboard", "dashboard"],
  ["sales", "sales"],
  ["inventory", "inventory"],
  ["purchases", "purchases"],
  ["expenses", "expenses"],
  ["cashbox", "cashbox"],
  ["reports", "reports"],
  ["settings", "settings"]
];

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 }, bypassCSP: true })).newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  if (await page.isVisible("#authGate")) {
    await page.fill("#loginUser", CREDS.username);
    await page.fill("#loginPass", CREDS.password);
    await page.click("#loginBtn");
    await page.waitForFunction(() => document.querySelector("#authGate").hidden, null, { timeout: 10000 });
  }
  await page.waitForTimeout(1200);

  for (const [view, name] of views) {
    await page.click('.nav-pill[data-view="' + view + '"]');
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log("✓ " + name + ".png");
  }

  /* درج المنتج + تفاصيل فاتورة */
  await page.click('.nav-pill[data-view="inventory"]');
  await page.waitForTimeout(900);
  await page.click("#invBody tr[data-id]");
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${OUT}/product-drawer.png` });
  console.log("✓ product-drawer.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  await page.click('.nav-pill[data-view="sales"]');
  await page.waitForTimeout(900);
  const menu = await page.$("#logBody .row-menu-btn");
  if (menu) {
    await menu.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/ctx-menu.png` });
    console.log("✓ ctx-menu.png");
    await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
    await page.click("#logBody tr[data-id] .row-menu-btn");
    await page.waitForTimeout(300);
    await page.click("#ctxView");
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/invoice-detail.png` });
    console.log("✓ invoice-detail.png");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  /* ملاحظات اليوم */
  await page.click('.nav-pill[data-view="cashbox"]');
  await page.waitForTimeout(900);
  await page.fill("#noteInput", "مورد جديد عرض توريد شواحن بسعر جيد — نفاوضه نهاية الأسبوع");
  await page.click("#addNoteBtn");
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${OUT}/notes.png` });
  console.log("✓ notes.png");

  /* المظهر الفاتح */
  await page.click('.nav-pill[data-view="settings"]');
  await page.waitForTimeout(800);
  await page.click('.seg-opt[data-theme-opt="فاتح"]');
  await page.waitForTimeout(900);
  await page.click('.nav-pill[data-view="dashboard"]');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/dashboard-light.png` });
  console.log("✓ dashboard-light.png");
  await page.click('.nav-pill[data-view="settings"]');
  await page.waitForTimeout(600);
  await page.click('.seg-opt[data-theme-opt="داكن"]');

  await browser.close();
  console.log("تم — اللقطات في مجلد " + OUT + "/");
})().catch(e => { console.error("CRASH:", e.message); process.exit(1); });
