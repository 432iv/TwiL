"use strict";
/* -------------------------------------------------------------------
   /api/auth — ONE account only.

   * /setup works exactly once: while no account exists. After that it
     answers 409 and the UI never shows a sign-up form again.
   * /login issues a server-side session.
   * There is deliberately no public registration endpoint.
   * /google + /google/callback let that single account also sign in
     with a linked Google identity — implemented by hand (no extra
     npm package) using Google's standard OAuth 2.0 endpoints.
   ------------------------------------------------------------------- */
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const config = require("../config");
const { wrap, cleanText, HttpError } = require("../lib/http");
const auth = require("../middleware/auth");

const router = express.Router();

/* --- crude but effective brute-force brake (per process) --- */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000, MAX_ATTEMPTS = 10;
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, first: now };
  if (now - rec.first > WINDOW_MS) { rec.n = 0; rec.first = now; }
  rec.n++;
  attempts.set(key, rec);
  if (rec.n > MAX_ATTEMPTS) throw new HttpError(429, "too_many_attempts", "Too many attempts, try again later");
}
const clearThrottle = key => attempts.delete(key);

const publicUser = u => ({
  id: String(u.id), username: u.username, email: u.email, createdAt: u.created_at,
  googleLinked: !!u.google_sub
});

/* Is the app set up yet, and is this caller signed in? */
router.get("/status", wrap(async (req, res) => {
  const exists = await auth.accountExists();
  res.json({
    setupRequired: !exists,
    signupDisabled: exists,          // the UI hides "create account" once true
    authenticated: !!req.user,
    user: req.user ? publicUser(req.user) : null
  });
}));

/* One-time account creation. */
router.post("/setup", wrap(async (req, res) => {
  if (await auth.accountExists()) {
    throw new HttpError(409, "account_exists", "An account already exists — sign in instead");
  }
  const username = cleanText(req.body.username, { field: "username", max: 60 });
  const email = req.body.email ? cleanText(req.body.email, { field: "email", max: 160 }) : null;
  const password = String(req.body.password || "");

  if (username.length < 3) throw new HttpError(400, "username_too_short", "Username needs 3+ characters");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "email_invalid", "Invalid email");
  if (password.length < 8) throw new HttpError(400, "password_too_short", "Password needs 8+ characters");

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  let user;
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3)
       RETURNING id, username, email, created_at, google_sub`, [username, email, hash]);
    user = rows[0];
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "account_exists", "An account already exists");
    throw err;
  }
  await db.query("INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user.id]);

  const { token, expires } = await auth.createSession(user.id, req.get("user-agent"));
  auth.setSessionCookie(req, res, token, expires);
  res.status(201).json({ user: publicUser(user), token });
}));

/* Sign in with the username or the email. */
router.post("/login", wrap(async (req, res) => {
  const identifier = cleanText(req.body.username || req.body.email || "", { field: "username", max: 160 });
  const password = String(req.body.password || "");
  const key = (req.ip || "ip") + "|" + identifier.toLowerCase();
  throttle(key);

  const { rows } = await db.query(
    `SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`, [identifier]);
  const user = rows[0];
  /* always run a hash comparison so timing does not reveal existence */
  const ok = await bcrypt.compare(password, user ? user.password_hash : "$2a$12$0000000000000000000000000000000000000000000000000000");
  if (!user || !ok) throw new HttpError(401, "invalid_credentials", "Wrong username or password");

  clearThrottle(key);
  const { token, expires } = await auth.createSession(user.id, req.get("user-agent"));
  auth.setSessionCookie(req, res, token, expires);
  res.json({ user: publicUser(user), token });
}));

router.post("/logout", wrap(async (req, res) => {
  await auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
}));

/* Who am I? (used on every app boot) */
router.get("/me", auth.requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()", [req.user.id]);
  res.json({ user: publicUser(req.user), activeSessions: rows[0].n });
}));

/* Change the password of the single account (all other devices stay signed in). */
router.post("/password", auth.requireAuth, wrap(async (req, res) => {
  const current = String(req.body.currentPassword || "");
  const next = String(req.body.newPassword || "");
  if (next.length < 8) throw new HttpError(400, "password_too_short", "Password needs 8+ characters");
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!await bcrypt.compare(current, rows[0].password_hash)) {
    throw new HttpError(401, "invalid_credentials", "Current password is wrong");
  }
  const hash = await bcrypt.hash(next, config.bcryptRounds);
  await db.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [hash, req.user.id]);
  res.json({ ok: true });
}));

/* ===================================================================
   Google sign-in — hand-rolled OAuth 2.0 authorization-code flow.
   No passport/googleapis dependency: two plain HTTPS calls to Google.
   =================================================================== */
const GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

function requireOnlineGoogle() {
  if (config.offlineMode) {
    throw new HttpError(503, "offline_google_unavailable", "Google sign-in requires internet; use the local username and password in desktop mode");
  }
}

function googleEnvOrThrow() {
  requireOnlineGoogle();
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    throw new HttpError(503, "google_not_configured", "Google sign-in is not configured on the server");
  }
  return { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL };
}

/* short-lived signed state token — protects the redirect round-trip (CSRF) */
function signState() {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac("sha256", config.sessionSecret).update(nonce + "." + ts).digest("base64url");
  return `${nonce}.${ts}.${sig}`;
}
function verifyState(state) {
  if (!state || typeof state !== "string") return false;
  const [nonce, ts, sig] = state.split(".");
  if (!nonce || !ts || !sig) return false;
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(nonce + "." + ts).digest("base64url");
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  const ageMs = Date.now() - parseInt(ts, 36);
  return ageMs >= 0 && ageMs < 10 * 60 * 1000; // 10 minutes to complete the round trip
}

/* Step 1 — send the browser to Google. */
router.get("/google", wrap(async (req, res) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL } = googleEnvOrThrow();
  const state = signState();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  res.redirect(url.toString());
}));

/* Step 2 — Google sends the browser back here with a one-time code. */
router.get("/google/callback", wrap(async (req, res) => {
  const fail = reason => res.redirect("/?authError=" + encodeURIComponent(reason));

  if (req.query.error) return fail("google_denied");
  if (!verifyState(req.query.state)) return fail("google_state");
  const code = req.query.code;
  if (!code) return fail("google_no_code");

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = googleEnvOrThrow();

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_CALLBACK_URL, grant_type: "authorization_code"
    })
  });
  if (!tokenRes.ok) return fail("google_token_exchange");
  const tokenData = await tokenRes.json();

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: "Bearer " + tokenData.access_token }
  });
  if (!profileRes.ok) return fail("google_profile");
  const profile = await profileRes.json(); // { sub, email, email_verified, name, picture }

  if (!profile.sub || !profile.email_verified) return fail("google_unverified");

  /* already linked to this Google identity -> just sign in */
  let user = (await db.query("SELECT * FROM users WHERE google_sub = $1", [profile.sub])).rows[0];

  if (!user) {
    const exists = await auth.accountExists();
    if (!exists) {
      /* first-ever sign-in for this ledger, done via Google: create the one account */
      const randomPassword = crypto.randomBytes(24).toString("hex");
      const hash = await bcrypt.hash(randomPassword, config.bcryptRounds);
      const username = (profile.email.split("@")[0] || "owner").slice(0, 60);
      const { rows } = await db.query(
        `INSERT INTO users (username, email, password_hash, google_sub, google_email)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [username, profile.email, hash, profile.sub, profile.email]);
      user = rows[0];
      await db.query("INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user.id]);
    } else {
      /* the one account already exists — only auto-link if the email matches it,
         otherwise a different Google identity must never be allowed in */
      const existing = (await db.query(
        "SELECT * FROM users WHERE lower(email) = lower($1) AND google_sub IS NULL", [profile.email]
      )).rows[0];
      if (!existing) return fail("google_mismatch");
      const { rows } = await db.query(
        `UPDATE users SET google_sub = $1, google_email = $2, updated_at = now() WHERE id = $3 RETURNING *`,
        [profile.sub, profile.email, existing.id]);
      user = rows[0];
    }
  }

  const { token, expires } = await auth.createSession(user.id, req.get("user-agent"));
  auth.setSessionCookie(req, res, token, expires);
  res.redirect("/");
}));

module.exports = router;
