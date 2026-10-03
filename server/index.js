"use strict";
/* ===================================================================
   Yousef Perfumes (يوسف للعطور) — local/hosted Express API
   The same backend serves the existing single-page frontend. Desktop mode
   listens on loopback and uses the embedded PGlite database.
   =================================================================== */
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const express = require("express");
const cookieParser = require("cookie-parser");

const config = require("./config");
const db = require("./db");
const auth = require("./middleware/auth");
const { migrate } = require("./migrate");
const { HttpError } = require("./lib/http");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

/* ───────── gzip for large responses ───────── */
const wantsGzip = req => /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
app.use((req, res, next) => {
  if (!wantsGzip(req)) return next();
  const origJson = res.json.bind(res);
  res.json = function (obj) {
    let payload;
    try { payload = JSON.stringify(obj); } catch (e) { return origJson(obj); }
    if (Buffer.byteLength(payload, "utf8") < 1024) return origJson(obj);
    zlib.gzip(payload, (err, buf) => {
      if (err || res.headersSent) { if (!res.headersSent) origJson(obj); return; }
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Content-Encoding", "gzip");
      if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
    });
    return res;
  };
  next();
});

/* The UI assets are bundled/local. Desktop CSP intentionally has no remote origins. */
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  const framePolicy = config.offlineMode ? "'none'" : "*";
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self' data:; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; " +
    "frame-ancestors " + framePolicy);
  next();
});
/* The hosted preview may embed the web version; the offline CSP remains frame-ancestors 'none'. */
app.use((_req, res, next) => { res.removeHeader("X-Frame-Options"); next(); });

app.use(auth.attachUser);

/* ---------------- API ---------------- */
const api = express.Router();
api.get("/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, db: config.databaseMode, offline: config.offlineMode, time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: "down", error: e.message });
  }
});

api.use("/auth", require("./routes/auth"));
api.use(auth.requireAuth);
api.use("/sales",     require("./routes/sales"));
api.use("/products",  require("./routes/products"));
api.use("/inventory", require("./routes/inventory"));
api.use("/purchases", require("./routes/purchases"));
api.use("/expenses",  require("./routes/expenses"));
api.use("/cashbox",   require("./routes/cashbox"));
api.use("/notes",     require("./routes/notes"));
api.use("/days",      require("./routes/days"));
api.use("/reports",   require("./routes/reports"));
api.use("/",          require("./routes/data"));
api.use((_req, _res, next) => next(new HttpError(404, "not_found", "Unknown endpoint")));
app.use("/api", api);

/* ---------------- frontend ---------------- */
const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "yousef-perfumes.html");
let indexHtml = null, indexGz = null, indexMtime = "";
function sendIndex(req, res) {
  try {
    const stat = fs.statSync(INDEX);
    if (!indexHtml || indexMtime !== String(stat.mtimeMs)) {
      indexMtime = String(stat.mtimeMs);
      indexHtml = fs.readFileSync(INDEX);
      indexGz = zlib.gzipSync(indexHtml, { level: 9 });
    }
  } catch (err) {
    console.error("[frontend] Unable to read bundled HTML:", err.message);
    return res.status(500).send("Application interface could not be loaded.");
  }
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (wantsGzip(req)) {
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", indexGz.length);
    return res.end(indexGz);
  }
  return res.end(indexHtml);
}
app.get("/", (_req, res) => sendIndex(_req, res));
app.get("/index.html", (_req, res) => res.redirect("/"));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) return sendIndex(req, res);
  next();
});

/* ---------------- errors ---------------- */
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[api]", req.method, req.originalUrl, err);
  res.status(status).json({
    error: err.code || "server_error",
    message: status >= 500 && config.nodeEnv === "production" ? "Server error" : err.message
  });
});

/* ---------------- lifecycle ---------------- */
async function start(options = {}) {
  await db.initialize();
  if (options.migrate !== false) await migrate();
  await db.query("SELECT 1");
  await auth.purgeExpiredSessions();
  const purgeTimer = setInterval(() => auth.purgeExpiredSessions().catch(() => {}), 6 * 3600 * 1000);
  purgeTimer.unref();

  const host = options.host || config.host;
  const port = options.port == null ? config.port : options.port;
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host);
    instance.once("error", reject);
    instance.once("listening", () => resolve(instance));
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  console.log(`Yousef Perfumes API listening on ${host}:${actualPort} [${config.nodeEnv}; ${config.databaseMode}]`);
  const userCount = await db.query("SELECT count(*)::int AS n FROM users");
  console.log(userCount.rows[0].n === 0
    ? "No account yet — open the app to create the local account."
    : "Account ready — open the app and sign in.");

  let closing = null;
  return {
    app,
    server,
    host,
    port: actualPort,
    close() {
      if (closing) return closing;
      closing = (async () => {
        clearInterval(purgeTimer);
        const closed = new Promise((resolve, reject) => {
          server.close(err => err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve());
          if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        });
        await closed;
        await db.close();
      })();
      return closing;
    }
  };
}

if (require.main === module) {
  start().then(runtime => {
    const shutdown = () => runtime.close().then(() => process.exit(0)).catch(err => {
      console.error("[shutdown]", err);
      process.exit(1);
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch(async err => {
    console.error("[startup]", err.stack || err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
}

// Express remains the default export for existing tooling; Electron uses .start().
app.start = start;
module.exports = app;
