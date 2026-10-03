#!/usr/bin/env bash
# يوسف للعطور — تشغيل بيئة التطوير كاملة بأمر واحد
#   ./scripts/dev-up.sh            → postgres + migrations + server (watch)
#   ./scripts/dev-up.sh --seed     → نفس الشيء + بيانات تجريبية
#   ./scripts/dev-up.sh --fresh    → يمسح كل البيانات ثم يبدأ
set -euo pipefail
cd "$(dirname "$BASH_SOURCE")/.."

echo "▸ يوسف للعطور — dev environment"

# ── 1) PostgreSQL ───────────────────────────────────────────
if command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h 127.0.0.1 -p 5432; then
  echo "✓ PostgreSQL يعمل بالفعل"
else
  PGDATA="${PGDATA:-$HOME/pgdata}"
  if [ ! -d "$PGDATA" ]; then
    echo "▸ تهيئة مجموعة بيانات جديدة في $PGDATA ..."
    initdb -U "$USER" -E UTF8 "$PGDATA" >/dev/null
    echo "listen_addresses = '127.0.0.1'" >> "$PGDATA/postgresql.conf"
  fi
  echo "▸ تشغيل PostgreSQL ..."
  pg_ctl -D "$PGDATA" -l "$PGDATA/dev.log" -w start >/dev/null
  echo "✓ PostgreSQL يعمل"
fi

# ── 2) قاعدة البيانات والمهاجرات ─────────────────────────────
DB_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2-)}"
DB_NAME="$(echo "$DB_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"
DB_USER="$(echo "$DB_URL" | sed -E 's|.*://([^:]+):.*|\1|')"
if ! psql "$DB_URL" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
  echo "▸ إنشاء قاعدة البيانات $DB_NAME ..."
  psql -h 127.0.0.1 -c "CREATE DATABASE $DB_NAME OWNER $DB_USER" >/dev/null 2>&1 || \
  psql -h 127.0.0.1 -c "CREATE DATABASE $DB_NAME" >/dev/null
  echo "✓ أُنشئت $DB_NAME"
fi

echo "▸ تشغيل المهاجرات ..."
npm run --silent migrate

# ── 3) خيارات ───────────────────────────────────────────────
if [ "${1:-}" = "--fresh" ]; then
  echo "▸ مسح كل البيانات (--fresh) ..."
  node scripts/wipe.js
fi

# ── 4) الخادم ───────────────────────────────────────────────
if [ "${1:-}" = "--seed" ]; then
  echo "▸ بذر بيانات تجريبية ..."
  node scripts/seed-demo.js
fi

echo "▸ تشغيل الخادم (node --watch) على المنفذ $((grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2) || echo 3000) ..."
echo "  الواجهة:   http://localhost:3000"
exec node --watch server/index.js
