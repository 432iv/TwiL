"use strict";
const { app, BrowserWindow, dialog, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
app.setName("Yousef Perfumes");

// Keep desktop data outside the install directory so upgrades/uninstalls do not erase it.
const USER_DATA_DIR = app.isPackaged
  ? path.join(app.getPath("appData"), "YousefPerfumes")
  : path.join(PROJECT_ROOT, ".desktop-dev");
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath("userData", USER_DATA_DIR);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

let runtime = null;
let mainWindow = null;
let localOrigin = null;
let quitting = false;

function getOrCreateSecret() {
  const secretFile = path.join(USER_DATA_DIR, "session.secret");
  try {
    const secret = fs.readFileSync(secretFile, "utf8").trim();
    if (secret.length >= 48) return secret;
  } catch (_) {}
  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
  return secret;
}

function canBind(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function chooseStablePort() {
  const portFile = path.join(USER_DATA_DIR, "backend.port");
  try {
    const saved = Number.parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);
    if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535 && await canBind(saved)) return saved;
  } catch (_) {}

  // Pick a free high port once, then retain it so the renderer's localStorage
  // origin remains stable between launches and application updates.
  const probe = net.createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));
  fs.writeFileSync(portFile, String(port) + "\n", { mode: 0o600 });
  return port;
}

function isLocalUrl(url) {
  try { return !!localOrigin && new URL(url).origin === localOrigin; }
  catch (_) { return false; }
}

function attachWindowSecurity(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocalUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isLocalUrl(url)) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  // The existing JSON backup button creates a Blob download. Route that download
  // through a native Save As dialog; restore continues to use the native file picker.
  win.webContents.session.on("will-download", async (_event, item, contents) => {
    if (contents !== win.webContents) { item.cancel(); return; }
    item.pause();
    const suggestedName = path.basename(item.getFilename() || "yousef-perfumes-backup.json");
    try {
      const result = await dialog.showSaveDialog(win, {
        title: "حفظ نسخة احتياطية",
        defaultPath: path.join(app.getPath("documents"), suggestedName),
        buttonLabel: "حفظ النسخة",
        filters: [
          { name: "نسخة احتياطية JSON", extensions: ["json"] },
          { name: "كل الملفات", extensions: ["*"] }
        ]
      });
      if (result.canceled || !result.filePath) { item.cancel(); return; }
      item.setSavePath(result.filePath);
      item.once("done", (_downloadEvent, state) => {
        if (state === "completed" && mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: "info", title: "النسخ الاحتياطي", buttons: ["موافق"],
            message: "تم حفظ النسخة الاحتياطية بنجاح.", detail: result.filePath
          }).catch(() => {});
        }
      });
      item.resume();
    } catch (err) {
      item.cancel();
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox("تعذر حفظ النسخة الاحتياطية", err.message || String(err));
      }
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "يوسف للعطور",
    backgroundColor: "#f6efe4",
    autoHideMenuBar: true,
    icon: path.join(PROJECT_ROOT, "assets", process.platform === "win32" ? "app.ico" : "app.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  attachWindowSecurity(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(`${localOrigin}/?desktop=1`).catch(err => {
    dialog.showErrorBox("تعذر فتح المنظومة", err.message || String(err));
  });
  return mainWindow;
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) createWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const port = await chooseStablePort();
    process.env.DB_MODE = "pglite";
    process.env.DB_DATA_DIR = path.join(USER_DATA_DIR, "database");
    process.env.SESSION_SECRET = getOrCreateSecret();
    process.env.OFFLINE_MODE = "1";
    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(port);
    process.env.NODE_ENV = app.isPackaged ? "production" : "development";

    const backend = require("../server/index");
    runtime = await backend.start({ host: "127.0.0.1", port });
    localOrigin = `http://127.0.0.1:${runtime.port}`;
    createWindow();
  }).catch(async err => {
    console.error("[desktop startup]", err.stack || err.message);
    try { await require("../server/db").close(); } catch (_) {}
    dialog.showErrorBox(
      "تعذر تشغيل يوسف للعطور",
      (err && err.message ? err.message : String(err)) +
        "\n\nلم تُحذف بياناتك. تحقّق من مساحة القرص ثم أعد فتح البرنامج."
    );
    app.quit();
  });

  app.on("activate", () => {
    if (runtime && !mainWindow) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", event => {
    if (!runtime || quitting) return;
    event.preventDefault();
    quitting = true;
    const current = runtime;
    runtime = null;
    current.close().catch(err => console.error("[desktop shutdown]", err)).finally(() => app.quit());
  });
}
