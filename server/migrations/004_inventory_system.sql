-- =====================================================================
-- Inventory/ledger system baseline (legacy: phone-era tables are converted by 007_perfumes.sql)
-- مخزون + فواتير متعددة الأصناف + مرتجعات + مشتريات + مصروفات
-- + صندوق + جرد + ملخصات الأيام المغلقة + إعدادات المحل
--
-- ترحيل تضاعفي وآمن: كل الجداول الجديدة CREATE IF NOT EXISTS،
-- وبيانات مبيعات النسخة السابقة (sales) تُنقل كما هي إلى
-- invoices/invoice_items ثم يُحذف الجدول القديم داخل نفس المعاملة.
-- =====================================================================

-- ---------------------------------------------------------------
-- التصنيفات
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO categories (name, sort_order) VALUES
  ('هواتف', 1), ('إكسسوارات', 2), ('سماعات', 3), ('شواحن', 4),
  ('حمايات', 5), ('بطاريات', 6), ('ذاكرة وتخزين', 7), ('أخرى', 8)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------
-- المنتجات (المخزون)
-- kind = phone  : تُتابع وحداته (IMEI) في phone_units والكمية = الوحدات المتوفرة
-- kind = accessory : كمية مجردة
-- purchase_price = متوسط التكلفة المرجّح (يحدث مع كل عملية شراء)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT         NOT NULL CHECK (length(btrim(name)) > 0),
  category_id    BIGINT       REFERENCES categories(id) ON DELETE SET NULL,
  kind           TEXT         NOT NULL DEFAULT 'accessory' CHECK (kind IN ('phone','accessory')),
  barcode        TEXT,
  image_url      TEXT,
  model          TEXT,
  color          TEXT,
  storage        TEXT,
  quantity       INTEGER      NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  purchase_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  sale_price     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  min_stock      INTEGER      NOT NULL DEFAULT 3 CHECK (min_stock >= 0),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_name_idx      ON products (name);
CREATE INDEX IF NOT EXISTS products_category_idx  ON products (category_id);
CREATE INDEX IF NOT EXISTS products_kind_idx      ON products (kind);
CREATE INDEX IF NOT EXISTS products_lowstock_idx  ON products (quantity, min_stock) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_uq
  ON products (barcode) WHERE barcode IS NOT NULL AND btrim(barcode) <> '';

-- ---------------------------------------------------------------
-- وحدات الهواتف (IMEI / Serial) — حالة كل جهاز على حدة
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_units (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  imei          TEXT,
  serial        TEXT,
  status        TEXT        NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold','returned_in')),
  purchase_item_id BIGINT,
  invoice_item_id  BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS phone_units_imei_uq
  ON phone_units (imei) WHERE imei IS NOT NULL AND btrim(imei) <> '';
CREATE INDEX IF NOT EXISTS phone_units_product_idx ON phone_units (product_id, status);

-- ---------------------------------------------------------------
-- الفواتير (المبيعات) — فاتورة تحتوي عدة أصناف + خصم
-- total/profit أعمدة مولّدة: subtotal و cost_total يحافظ عليهما
-- التطبيق داخل معاملة واحدة، والخصم يخصم من الربح مباشرة.
-- refunded/refunded_profit: ما أُرجع من الفاتورة (مالاً وربحاً)
-- status: completed | returned | cancelled
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id              BIGSERIAL PRIMARY KEY,
  day_id          BIGINT      NOT NULL REFERENCES days(id) ON DELETE RESTRICT,
  invoice_no      TEXT        NOT NULL UNIQUE,
  payment_method  TEXT        NOT NULL REFERENCES payment_methods(code),
  debtor_name     TEXT,
  discount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  cost_total      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_total >= 0),
  total           NUMERIC(12,2) GENERATED ALWAYS AS (round(subtotal - discount, 2)) STORED,
  profit          NUMERIC(12,2) GENERATED ALWAYS AS (round(subtotal - cost_total - discount, 2)) STORED,
  refunded        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  refunded_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','returned','cancelled')),
  notes           TEXT,
  sale_date       DATE        NOT NULL,
  sale_time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_day_idx    ON invoices (day_id);
CREATE INDEX IF NOT EXISTS invoices_date_idx   ON invoices (sale_date DESC, sale_time DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT      NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id      BIGINT      REFERENCES products(id) ON DELETE SET NULL,
  product_name    TEXT        NOT NULL CHECK (length(btrim(product_name)) > 0),
  qty             INTEGER     NOT NULL CHECK (qty > 0),
  qty_returned    INTEGER     NOT NULL DEFAULT 0 CHECK (qty_returned >= 0 AND qty_returned <= qty),
  wholesale_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),
  selling_price   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  unit_id         BIGINT      REFERENCES phone_units(id) ON DELETE SET NULL,
  imei            TEXT,
  line_total      NUMERIC(12,2) GENERATED ALWAYS AS (round(selling_price * qty, 2)) STORED,
  line_cost       NUMERIC(12,2) GENERATED ALWAYS AS (round(wholesale_price * qty, 2)) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_items_product_idx ON invoice_items (product_id);

-- ---------------------------------------------------------------
-- مرتجعات المبيعات — كل إرجاع يُسجَّل ويعدّل المخزون والصندوق
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_returns (
  id             BIGSERIAL PRIMARY KEY,
  invoice_id     BIGINT      NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  item_id        BIGINT      NOT NULL REFERENCES invoice_items(id),
  day_id         BIGINT      NOT NULL REFERENCES days(id),
  qty            INTEGER     NOT NULL CHECK (qty > 0),
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  profit_adjust  NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason         TEXT,
  returned_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_returns_invoice_idx ON sale_returns (invoice_id);
CREATE INDEX IF NOT EXISTS sale_returns_day_idx    ON sale_returns (day_id);

-- ---------------------------------------------------------------
-- المشتريات — بدون نظام موردين: ملاحظات حرة فقط
-- ---------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS purchase_seq START 1;

CREATE TABLE IF NOT EXISTS purchases (
  id            BIGSERIAL PRIMARY KEY,
  day_id        BIGINT      NOT NULL REFERENCES days(id),
  purchase_no   TEXT        NOT NULL UNIQUE,
  total         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid          BOOLEAN     NOT NULL DEFAULT TRUE,
  notes         TEXT,
  purchase_date DATE        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchases_day_idx  ON purchases (day_id);
CREATE INDEX IF NOT EXISTS purchases_date_idx ON purchases (purchase_date DESC);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           BIGSERIAL PRIMARY KEY,
  purchase_id  BIGINT      NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id   BIGINT      NOT NULL REFERENCES products(id),
  product_name TEXT        NOT NULL,
  qty          INTEGER     NOT NULL CHECK (qty > 0),
  unit_cost    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  imeis        TEXT[]      NOT NULL DEFAULT '{}',
  line_total   NUMERIC(12,2) GENERATED ALWAYS AS (round(unit_cost * qty, 2)) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS purchase_items_product_idx  ON purchase_items (product_id);

-- ---------------------------------------------------------------
-- المصروفات — إيجار/كهرباء/إنترنت/نقل/صيانة/أخرى
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id           BIGSERIAL PRIMARY KEY,
  day_id       BIGINT      NOT NULL REFERENCES days(id),
  category     TEXT        NOT NULL DEFAULT 'other'
                 CHECK (category IN ('rent','electricity','internet','transport','maintenance','other')),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  expense_date DATE        NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_day_idx  ON expenses (day_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (expense_date DESC);

-- ---------------------------------------------------------------
-- حركة الصندوق — سجل مالي موحّد لكل ما يدخل ويخرج
-- method: للعمليات المرتبطة ببيع/مرتجع (cash تدخل الرصيد النقدي،
--         card تُتابع منفصلة، unpaid بلا حركة)؛ NULL لبقية الأنواع
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_movements (
  id          BIGSERIAL PRIMARY KEY,
  day_id      BIGINT      REFERENCES days(id) ON DELETE CASCADE,
  direction   TEXT        NOT NULL CHECK (direction IN ('in','out')),
  method      TEXT        REFERENCES payment_methods(code),
  category    TEXT        NOT NULL
                CHECK (category IN ('sale','refund','expense','purchase','deposit','withdrawal','adjust')),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  ref_type    TEXT,
  ref_id      BIGINT,
  moved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_moves_day_idx  ON cash_movements (day_id);
CREATE INDEX IF NOT EXISTS cash_moves_cat_idx  ON cash_movements (category);
CREATE INDEX IF NOT EXISTS cash_moves_time_idx ON cash_movements (moved_at DESC);

-- ---------------------------------------------------------------
-- الجرد — مقارنة الكمية المسجلة بالفعلية
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stocktakes (
  id         BIGSERIAL PRIMARY KEY,
  day_id     BIGINT      REFERENCES days(id),
  note       TEXT,
  lines      INTEGER     NOT NULL DEFAULT 0,
  diff_lines INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stocktake_items (
  id           BIGSERIAL PRIMARY KEY,
  stocktake_id BIGINT    NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_id   BIGINT    NOT NULL REFERENCES products(id),
  product_name TEXT      NOT NULL,
  system_qty   INTEGER   NOT NULL,
  counted_qty  INTEGER   NOT NULL CHECK (counted_qty >= 0),
  diff         INTEGER   GENERATED ALWAYS AS (counted_qty - system_qty) STORED
);
CREATE INDEX IF NOT EXISTS stocktake_items_idx ON stocktake_items (stocktake_id);

-- ---------------------------------------------------------------
-- حركة المخزون — كل دخول/خروج بسبب واضح وتاريخ وكمية
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_in      INTEGER     NOT NULL DEFAULT 0 CHECK (qty_in  >= 0),
  qty_out     INTEGER     NOT NULL DEFAULT 0 CHECK (qty_out >= 0),
  reason      TEXT        NOT NULL
                 CHECK (reason IN ('purchase','sale','return_in','adjustment','initial','edit')),
  ref_type    TEXT,
  ref_id      BIGINT,
  note        TEXT,
  day_id      BIGINT      REFERENCES days(id) ON DELETE SET NULL,
  moved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_moves_product_idx ON stock_movements (product_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS stock_moves_time_idx    ON stock_movements (moved_at DESC);

-- ---------------------------------------------------------------
-- ملخص اليوم المغلق — لقطة ثابتة لا تتغير بعد الإغلاق
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_summaries (
  day_id       BIGINT PRIMARY KEY REFERENCES days(id) ON DELETE CASCADE,
  snapshot     JSONB       NOT NULL,
  cash_balance NUMERIC(12,2),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- إعدادات المحل — امتداد لإعدادات الحساب الحالية
-- ---------------------------------------------------------------
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS shop_name        TEXT NOT NULL DEFAULT 'Blue Mobile',
  ADD COLUMN IF NOT EXISTS shop_logo        TEXT,
  ADD COLUMN IF NOT EXISTS shop_phone       TEXT,
  ADD COLUMN IF NOT EXISTS shop_address     TEXT,
  ADD COLUMN IF NOT EXISTS invoice_footer   TEXT,
  ADD COLUMN IF NOT EXISTS currency         TEXT NOT NULL DEFAULT 'د.ل',
  ADD COLUMN IF NOT EXISTS default_min_stock INTEGER NOT NULL DEFAULT 3;

-- ---------------------------------------------------------------
-- نقل مبيعات النسخة السابقة إلى نموذج الفواتير:
-- كل سطر بيع قديم = فاتورة بصنف واحد (بنفس الرقم والتاريخ)
-- ---------------------------------------------------------------
DO $$
DECLARE moved INT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales') THEN
    INSERT INTO invoices (id, day_id, invoice_no, payment_method, debtor_name,
                          discount, subtotal, cost_total, status, sale_date, sale_time,
                          created_at, updated_at)
    SELECT s.id, s.day_id, s.invoice_no, s.payment_method, s.debtor_name,
           0, s.total, s.wholesale_total, 'completed', s.sale_date, s.sale_time,
           s.created_at, s.updated_at
      FROM sales s
     ON CONFLICT (invoice_no) DO NOTHING;

    INSERT INTO invoice_items (invoice_id, product_id, product_name, qty,
                               wholesale_price, selling_price, created_at)
    SELECT s.id, NULL, s.product_name, s.quantity,
           s.wholesale_price, s.selling_price, s.created_at
      FROM sales s
     WHERE NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = s.id);

    SELECT count(*) INTO moved FROM invoices;
    IF moved > 0 THEN
      PERFORM setval('invoices_id_seq', (SELECT MAX(id) FROM invoices));
    END IF;

    DROP TABLE sales;   -- البيانات أصبحت في invoices/invoice_items
  END IF;
END $$;
