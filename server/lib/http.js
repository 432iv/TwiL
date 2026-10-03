"use strict";
/* Small shared helpers: validation, day naming, error type. */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const badRequest = (code, msg) => new HttpError(400, code, msg);

/* async route wrapper so thrown errors reach the error middleware */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanText(value, { field, max = 500, required = true }) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (!text && required) throw badRequest(`${field}_required`, `${field} is required`);
  if (text.length > max) throw badRequest(`${field}_too_long`, `${field} exceeds ${max} characters`);
  return text;
}

function toInt(value, { field, min = 1, max = 100000 }) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${field}_invalid`, `${field} must be ${min}..${max}`);
  return n;
}

function toMoney(value, { field, max = 1000000 }) {
  const n = Math.round(parseFloat(value) * 100) / 100;
  if (!Number.isFinite(n) || n < 0 || n > max) throw badRequest(`${field}_invalid`, `${field} must be 0..${max}`);
  return n;
}

function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw badRequest("date_invalid", "date must be YYYY-MM-DD");
  return value;
}

const DAY_NAMES = {
  ar: ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"],
  en: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
};
/* Day names are stored in Arabic (the primary language) but the client
   re-derives its own label from the date, so this is only a fallback. */
function dayNameFor(isoDateStr, lang = "ar") {
  const d = new Date(isoDateStr + "T12:00:00Z");
  return (DAY_NAMES[lang] || DAY_NAMES.ar)[d.getUTCDay()];
}

module.exports = { HttpError, badRequest, wrap, cleanText, toInt, toMoney, isoDate, dayNameFor };
