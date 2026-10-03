"use strict";
/* ---------------------------------------------------------------
   Product-name normalisation + ranking.

   This mirrors the browser-side helpers character for character, so
   suggestions coming from the database are ordered exactly the way
   the offline prototype ordered them. Names are autocomplete only —
   there is no quantity, no stock, nothing inventory-like here.
   --------------------------------------------------------------- */

const AR_DIGITS = { "\u0660":"0","\u0661":"1","\u0662":"2","\u0663":"3","\u0664":"4","\u0665":"5","\u0666":"6","\u0667":"7","\u0668":"8","\u0669":"9",
                    "\u06F0":"0","\u06F1":"1","\u06F2":"2","\u06F3":"3","\u06F4":"4","\u06F5":"5","\u06F6":"6","\u06F7":"7","\u06F8":"8","\u06F9":"9" };

/* one character -> its canonical form ("" means "drop it") */
function normalizeChar(ch) {
  if (/[\u064B-\u0652\u0640\u0670]/.test(ch)) return "";      // tashkeel + tatweel
  if ("\u0623\u0625\u0622\u0671".includes(ch)) return "\u0627"; // أ إ آ ٱ -> ا
  if (ch === "\u0649" || ch === "\u0626") return "\u064A";      // ى ئ -> ي
  if (ch === "\u0624") return "\u0648";                          // ؤ -> و
  if (ch === "\u0629") return "\u0647";                          // ة -> ه
  if (AR_DIGITS[ch]) return AR_DIGITS[ch];
  if (/\s/.test(ch)) return " ";
  return ch.toLowerCase();
}

function normalizeName(str) {
  let out = "";
  for (const ch of String(str || "")) out += normalizeChar(ch);
  return out.replace(/\s+/g, " ").trim();
}

/* Rank a candidate against a normalised query.
   0 starts-with · 1 word-start · 2 anywhere · 3 every typed word begins a word
   null = no match.                                                        */
function scoreName(normalizedCandidate, normalizedQuery) {
  const idx = normalizedCandidate.indexOf(normalizedQuery);
  if (idx === 0) return 0;
  if (idx > 0) return normalizedCandidate[idx - 1] === " " ? 1 : 2;
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length > 1) {
    const words = normalizedCandidate.split(" ").filter(Boolean);
    if (tokens.every(tok => words.some(w => w.startsWith(tok)))) return 3;
  }
  return null;
}

/* rows: [{ name, normalized_name, usage_count, last_used_at }] */
function rankNames(rows, query, limit = 8) {
  const q = normalizeName(query);
  if (!q) {
    return rows.slice(0, limit).map(r => ({ name: r.name, score: 0, matchStart: -1, matchLength: 0 }));
  }
  const scored = [];
  for (const r of rows) {
    const score = scoreName(r.normalized_name, q);
    if (score === null) continue;
    scored.push({
      row: r,
      score,
      matchStart: r.normalized_name.indexOf(q),
      matchLength: q.length
    });
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    (b.row.usage_count - a.row.usage_count) ||
    (new Date(b.row.last_used_at) - new Date(a.row.last_used_at)) ||
    a.row.name.localeCompare(b.row.name)
  );
  return scored.slice(0, limit).map(s => ({
    name: s.row.name,
    score: s.score,
    matchStart: s.matchStart,
    matchLength: s.matchLength
  }));
}

module.exports = { normalizeChar, normalizeName, scoreName, rankNames };
