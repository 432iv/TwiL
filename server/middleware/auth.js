"use strict";
/* ---------------------------------------------------------------
   Authentication: single account, bcrypt password, server-side
   sessions. The cookie carries an opaque random token; only its
   SHA-256 lives in the database, so the table cannot be replayed.
   A Bearer header is accepted as well, because the app is often
   embedded in a cross-site iframe where cookies may be blocked.
   --------------------------------------------------------------- */
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const { HttpError } = require("../lib/http");

const COOKIE = "yp_session";

const hashToken = token =>
  crypto.createHmac("sha256", config.sessionSecret).update(token).digest("hex");

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function createSession(userId, userAgent) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionTtlDays * 86400_000);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1,$2,$3,$4)`,
    [userId, hashToken(token), String(userAgent || "").slice(0, 300), expires]
  );
  return { token, expires };
}

async function destroySession(token) {
  if (!token) return;
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

function setSessionCookie(req, res, token, expires) {
  const https = req.secure || req.get("x-forwarded-proto") === "https";
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: https,
    /* the preview runs inside a cross-site iframe: None+Secure is the
       only combination browsers will store there */
    sameSite: https ? "none" : "lax",
    expires,
    path: "/"
  });
}

function clearSessionCookie(req, res) {
  const https = req.secure || req.get("x-forwarded-proto") === "https";
  res.clearCookie(COOKIE, { httpOnly: true, secure: https, sameSite: https ? "none" : "lax", path: "/" });
}

function tokenFrom(req) {
  const header = req.get("authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return (req.cookies && req.cookies[COOKIE]) || null;
}

/* Resolves req.user / req.sessionToken when a valid session exists. */
async function attachUser(req, _res, next) {
  try {
    const token = tokenFrom(req);
    if (!token) return next();
    const { rows } = await db.query(
      `UPDATE sessions s
          SET last_seen_at = now()
        WHERE s.token_hash = $1 AND s.expires_at > now()
      RETURNING s.id AS session_id, s.user_id`,
      [hashToken(token)]
    );
    if (!rows.length) return next();
    const user = await db.query("SELECT id, username, email, created_at FROM users WHERE id = $1", [rows[0].user_id]);
    if (user.rows.length) {
      req.user = user.rows[0];
      req.sessionToken = token;
    }
    next();
  } catch (err) { next(err); }
}

/* Gate for every protected endpoint. */
function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, "unauthenticated", "Sign in first"));
  next();
}

async function accountExists() {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM users");
  return rows[0].n > 0;
}

async function purgeExpiredSessions() {
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
}

module.exports = {
  COOKIE, attachUser, requireAuth, createSession, destroySession,
  setSessionCookie, clearSessionCookie, accountExists, purgeExpiredSessions, hashToken
};
