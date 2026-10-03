-- وضع البيع السريع بالباركود: إعداد يخص الحساب، محفوظ ومتزامن بين الأجهزة
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS barcode_quick_sale BOOLEAN NOT NULL DEFAULT TRUE;

