-- ════════════════════════════════════════════════════════════════════
--  007 — يوسف للعطور: تحويل المنظومة من هواتف/إكسسوارات إلى عطور
--
--  • التصنيفات: صيفية / شتوية فقط (يفرضها قيد في القاعدة نفسها)
--  • المنتج = عطر: ماركة، حجم أصلي (مل)، نوع، سعر شراء/بيع للعلبة المغلقة،
--    سعر المل للتقسيم، رصيد مغلق (قطع) + رصيد مفتوح (مل)
--  • عبوات التقسيم (vials) بمخزون وتكلفة وسعر مستقلّين
--  • سجل عمليات "تخصيص للتقسيم" (open_operations)
--  • بنود الفواتير: بيع مغلق (sealed) أو بيع تقسيم (split) بالمل + العبوة
--  • حذف كل ما يخص الهواتف: وحدات IMEI، الموديل/اللون/السعة
--  لا تعدّل المهاجرات السابقة — كل التغييرات هنا.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1) التصنيفات: صيفية / شتوية فقط ────────────────────────────────
ALTER TABLE categories ADD COLUMN IF NOT EXISTS code TEXT;

-- المنتجات القديمة تُفصل عن التصنيفات القديمة (FK = SET NULL) ثم تُحذف
DELETE FROM categories WHERE name NOT IN ('صيفية', 'شتوية');

INSERT INTO categories (name, sort_order, code) VALUES
  ('صيفية', 1, 'summer'),
  ('شتوية', 2, 'winter')
ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order, code = EXCLUDED.code;

ALTER TABLE categories ALTER COLUMN code SET NOT NULL;
ALTER TABLE categories ADD CONSTRAINT categories_code_check  CHECK (code IN ('summer', 'winter'));
ALTER TABLE categories ADD CONSTRAINT categories_code_unique UNIQUE (code);

-- ─── 2) المنتجات → عطور ─────────────────────────────────────────────
DROP INDEX IF EXISTS products_kind_idx;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_kind_check;
ALTER TABLE products
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS model,
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS storage;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand            TEXT,
  ADD COLUMN IF NOT EXISTS size_ml          NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS product_type     TEXT,
  ADD COLUMN IF NOT EXISTS ml_price         NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allow_split      BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS open_ml          NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS open_cost_per_ml NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes            TEXT;

ALTER TABLE products ADD CONSTRAINT products_size_ml_check     CHECK (size_ml IS NULL OR size_ml > 0);
ALTER TABLE products ADD CONSTRAINT products_ml_price_check    CHECK (ml_price >= 0);
ALTER TABLE products ADD CONSTRAINT products_open_ml_check     CHECK (open_ml >= 0);
ALTER TABLE products ADD CONSTRAINT products_open_cost_check   CHECK (open_cost_per_ml >= 0);
-- التقسيم يحتاج حجماً أصلياً معروفاً
ALTER TABLE products ADD CONSTRAINT products_split_needs_size  CHECK (NOT allow_split OR size_ml IS NOT NULL);

CREATE INDEX IF NOT EXISTS products_brand_idx ON products (brand);
CREATE INDEX IF NOT EXISTS products_open_idx  ON products (open_ml) WHERE open_ml > 0;

-- ─── 3) حذف نظام وحدات الهواتف (IMEI) ──────────────────────────────
ALTER TABLE invoice_items  DROP COLUMN IF EXISTS unit_id;
ALTER TABLE invoice_items  DROP COLUMN IF EXISTS imei;
ALTER TABLE purchase_items DROP COLUMN IF EXISTS imeis;
DROP TABLE IF EXISTS phone_units;

-- ─── 4) عبوات التقسيم ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vials (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT          NOT NULL CHECK (length(btrim(name)) > 0),
  size_ml     NUMERIC(8,2)  NOT NULL CHECK (size_ml > 0),
  cost        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),        -- متوسط تكلفة العبوة الواحدة
  sale_price  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),  -- سعر العبوة على الزبون
  quantity    INTEGER       NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_stock   INTEGER       NOT NULL DEFAULT 10 CHECK (min_stock >= 0),
  is_active   BOOLEAN       NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vials_size_idx ON vials (size_ml) WHERE is_active;

CREATE TABLE IF NOT EXISTS vial_movements (
  id        BIGSERIAL PRIMARY KEY,
  vial_id   BIGINT      NOT NULL REFERENCES vials(id) ON DELETE CASCADE,
  qty_in    INTEGER     NOT NULL DEFAULT 0 CHECK (qty_in  >= 0),
  qty_out   INTEGER     NOT NULL DEFAULT 0 CHECK (qty_out >= 0),
  reason    TEXT        NOT NULL
              CHECK (reason IN ('purchase','split_sale','split_return','adjustment','initial','edit')),
  ref_type  TEXT,
  ref_id    BIGINT,
  note      TEXT,
  day_id    BIGINT      REFERENCES days(id) ON DELETE SET NULL,
  moved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vial_moves_vial_idx ON vial_movements (vial_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS vial_moves_time_idx ON vial_movements (moved_at DESC);

-- ─── 5) حركة المخزون: مغلق (قطع) أو مفتوح (مل) ──────────────────────
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS stock_kind TEXT          NOT NULL DEFAULT 'sealed'
                                          CHECK (stock_kind IN ('sealed','open')),
  ADD COLUMN IF NOT EXISTS ml_in      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ml_in  >= 0),
  ADD COLUMN IF NOT EXISTS ml_out     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ml_out >= 0);

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_check
  CHECK (reason IN ('purchase','sale','return_in','adjustment','initial','edit',
                    'open_split','split_sale','split_return'));

-- ─── 6) سجل عمليات "تخصيص للتقسيم" ──────────────────────────────────
CREATE TABLE IF NOT EXISTS open_operations (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name   TEXT          NOT NULL,
  pieces         INTEGER       NOT NULL CHECK (pieces > 0),            -- عدد العلب المغلقة المفتوحة
  size_ml        NUMERIC(8,2)  NOT NULL CHECK (size_ml > 0),           -- حجم العلبة الأصلي
  ml_added       NUMERIC(12,2) NOT NULL CHECK (ml_added > 0),          -- = pieces × size_ml
  piece_cost     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (piece_cost >= 0),   -- تكلفة العلبة وقت الفتح
  cost_per_ml    NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (cost_per_ml >= 0),   -- تكلفة المل الجديد
  sealed_before  INTEGER       NOT NULL,
  sealed_after   INTEGER       NOT NULL,
  open_before    NUMERIC(12,2) NOT NULL,
  open_after     NUMERIC(12,2) NOT NULL,
  avg_cost_after NUMERIC(12,4) NOT NULL DEFAULT 0,                     -- متوسط تكلفة المل بعد الدمج
  note           TEXT,
  day_id         BIGINT        REFERENCES days(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS open_ops_product_idx ON open_operations (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS open_ops_time_idx    ON open_operations (created_at DESC);

-- ─── 7) بنود الفواتير: مغلق / تقسيم ─────────────────────────────────
--  بيع التقسيم = بند واحد: qty = 1 ، selling_price = إجمالي (مل × سعر المل + العبوات)،
--  wholesale_price = تكلفة (مل × تكلفة المل + تكلفة العبوات) فتبقى line_total/line_cost صحيحة.
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS sale_type    TEXT          NOT NULL DEFAULT 'sealed'
                                            CHECK (sale_type IN ('sealed','split')),
  ADD COLUMN IF NOT EXISTS ml_qty       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (ml_qty   >= 0),
  ADD COLUMN IF NOT EXISTS ml_price     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ml_price >= 0),
  ADD COLUMN IF NOT EXISTS ml_cost      NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (ml_cost  >= 0),
  ADD COLUMN IF NOT EXISTS vial_id      BIGINT        REFERENCES vials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vial_name    TEXT,
  ADD COLUMN IF NOT EXISTS vial_size_ml NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS vial_qty     INTEGER       NOT NULL DEFAULT 0 CHECK (vial_qty   >= 0),
  ADD COLUMN IF NOT EXISTS vial_cost    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (vial_cost  >= 0),
  ADD COLUMN IF NOT EXISTS vial_price   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (vial_price >= 0);

ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_split_shape
  CHECK (sale_type = 'sealed' OR (ml_qty > 0 AND qty = 1));

CREATE INDEX IF NOT EXISTS invoice_items_type_idx ON invoice_items (sale_type);
CREATE INDEX IF NOT EXISTS invoice_items_vial_idx ON invoice_items (vial_id) WHERE vial_id IS NOT NULL;

-- هل أُعيدت المليلترات/العبوة إلى المخزون عند المرتجع؟ (مرتجع تقسيم قد لا يصلح لإعادة البيع)
ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS restocked BOOLEAN NOT NULL DEFAULT true;

-- عرض مريح لمبيعات التقسيم
CREATE OR REPLACE VIEW split_sales AS
SELECT ii.id              AS item_id,
       ii.invoice_id,
       i.invoice_no,
       i.sale_date,
       i.status           AS invoice_status,
       ii.product_id,
       ii.product_name,
       ii.ml_qty          AS ml_sold,
       ii.ml_price        AS price_per_ml,
       ii.ml_cost         AS cost_per_ml,
       ii.vial_id,
       ii.vial_name,
       ii.vial_size_ml,
       ii.vial_qty,
       ii.vial_cost,
       ii.vial_price,
       ii.line_total      AS total,
       ii.line_cost       AS cost,
       ii.qty_returned
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
WHERE ii.sale_type = 'split';

-- ─── 8) المشتريات: عطور مغلقة + عبوات ───────────────────────────────
ALTER TABLE purchase_items ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE purchase_items
  ADD COLUMN IF NOT EXISTS item_type TEXT   NOT NULL DEFAULT 'perfume'
                                       CHECK (item_type IN ('perfume','vial')),
  ADD COLUMN IF NOT EXISTS vial_id   BIGINT REFERENCES vials(id);
ALTER TABLE purchase_items ADD CONSTRAINT purchase_items_target_check
  CHECK ((item_type = 'perfume' AND product_id IS NOT NULL AND vial_id IS NULL)
      OR (item_type = 'vial'    AND vial_id    IS NOT NULL AND product_id IS NULL));
CREATE INDEX IF NOT EXISTS purchase_items_vial_idx ON purchase_items (vial_id) WHERE vial_id IS NOT NULL;

-- ─── 9) الجرد: مغلق / مفتوح (مل) / عبوات ───────────────────────────
ALTER TABLE stocktake_items DROP COLUMN IF EXISTS diff;
ALTER TABLE stocktake_items ALTER COLUMN system_qty  TYPE NUMERIC(12,2);
ALTER TABLE stocktake_items ALTER COLUMN counted_qty TYPE NUMERIC(12,2);
ALTER TABLE stocktake_items
  ADD COLUMN diff NUMERIC(12,2) GENERATED ALWAYS AS (counted_qty - system_qty) STORED;
ALTER TABLE stocktake_items ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE stocktake_items
  ADD COLUMN IF NOT EXISTS item_type TEXT   NOT NULL DEFAULT 'sealed'
                                       CHECK (item_type IN ('sealed','open','vial')),
  ADD COLUMN IF NOT EXISTS vial_id   BIGINT REFERENCES vials(id);

-- ─── 10) الإعدادات: هوية المحل ──────────────────────────────────────
ALTER TABLE settings ALTER COLUMN shop_name SET DEFAULT 'يوسف للعطور';
ALTER TABLE settings ALTER COLUMN theme     SET DEFAULT 'light';
UPDATE settings SET shop_name = 'يوسف للعطور' WHERE shop_name = 'Blue Mobile';
