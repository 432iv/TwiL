-- عدة باركودات لكل منتج رئيسي، كل باركود/مجموعة له سعر جملة وسعر بيع خاص به،
-- بينما الاسم والكمية الإجمالية يبقيان على مستوى المنتج الرئيسي فقط.
CREATE TABLE IF NOT EXISTS product_barcodes (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode         TEXT        NOT NULL CHECK (length(btrim(barcode)) > 0),
  wholesale_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),
  sale_price      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_barcodes_barcode_uq ON product_barcodes (barcode);
CREATE INDEX IF NOT EXISTS product_barcodes_product_idx ON product_barcodes (product_id);

-- ترحيل الباركودات المفردة الحالية (المرتبطة مباشرة بجدول المنتجات) إلى الجدول الجديد
-- حتى تصبح نقطة الحقيقة الوحيدة لكل عمليات البحث/المنع من التكرار مستقبلاً،
-- مع إبقاء عمود products.barcode كما هو (متزامن تلقائيًا) للنموذج الحالي البسيط.
INSERT INTO product_barcodes (product_id, barcode, wholesale_price, sale_price)
SELECT id, barcode, purchase_price, sale_price FROM products
WHERE barcode IS NOT NULL AND btrim(barcode) <> ''
ON CONFLICT (barcode) DO NOTHING;

-- وضع تسجيل المنتجات الجديدة بالباركود: إعداد مستقل تمامًا عن وضع البيع السريع
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS barcode_register_mode BOOLEAN NOT NULL DEFAULT FALSE;

