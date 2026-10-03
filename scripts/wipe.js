"use strict";
/* مسح كل بيانات المنظومة عبر الـ API (الحساب يبقى).
   الاستخدام: node scripts/wipe.js            */
const BASE = process.env.BASE || "http://127.0.0.1:3000";

(async () => {
  const status = await (await fetch(BASE + "/api/auth/status")).json();
  if (status.setupRequired) { console.log("لا توجد بيانات — الحساب غير منشأ بعد."); return; }
  console.log("⚠  سيتم مسح كل البيانات (الفواتير، المخزون، الصندوق، الأيام) — الحساب يبقى.");
  const tok = process.env.WIPE_TOKEN;
  let token = null;
  if (tok) token = tok;
  else {
    const user = process.env.WIPE_USER || "owner";
    const pass = process.env.WIPE_PASS;
    if (!pass) { console.error("حدد كلمة المرور:  WIPE_PASS=... node scripts/wipe.js"); process.exit(1); }
    const r = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user, password: pass })
    });
    if (!r.ok) { console.error("فشل الدخول:", r.status); process.exit(1); }
    token = (await r.json()).token;
  }
  const del = await fetch(BASE + "/api/data", {
    method: "DELETE", headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ confirm: "DELETE" })
  });
  if (!del.ok) { console.error("فشل المسح:", del.status, await del.text()); process.exit(1); }
  console.log("✓ تم مسح كل البيانات — المنظومة نظيفة وجاهزة.");
})().catch(e => { console.error("خطأ:", e.message); process.exit(1); });
