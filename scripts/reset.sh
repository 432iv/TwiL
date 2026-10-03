#!/usr/bin/env bash
# يوسف للعطور — مسح كل بيانات المنظومة (لا يمسح الحساب)
set -euo pipefail
cd "$(dirname "$BASH_SOURCE")/.."
node scripts/wipe.js
