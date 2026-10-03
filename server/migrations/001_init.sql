-- =====================================================================
-- Yousef Perfumes — Sales Ledger : initial schema (legacy baseline)
-- Sales ledger ONLY. No stock, no warehouses, no suppliers, no purchases.
-- =====================================================================

-- ---------------------------------------------------------------
-- The single account. The `singleton` column makes a second row
-- impossible at the database level: it may only ever be TRUE and it
-- is UNIQUE, so at most one user row can exist.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  singleton     BOOLEAN     NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
  username      TEXT        NOT NULL UNIQUE CHECK (length(btrim(username)) >= 3),
  email         TEXT        UNIQUE,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side sessions. Only the SHA-256 of the token is stored, so a
-- database leak cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS sessions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Interface preferences follow the account across devices.
CREATE TABLE IF NOT EXISTS settings (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lang       TEXT        NOT NULL DEFAULT 'ar'   CHECK (lang  IN ('ar','en')),
  theme      TEXT        NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Payment methods as data, so new ones never need a schema change.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  code       TEXT PRIMARY KEY,
  sort_order INT     NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO payment_methods (code, sort_order) VALUES ('cash', 1), ('card', 2)
  ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------
-- Sales days. Exactly one day may be open at any moment.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS days (
  id        BIGSERIAL PRIMARY KEY,
  day_date  DATE        NOT NULL UNIQUE,
  day_name  TEXT        NOT NULL,
  status    TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  CONSTRAINT closed_days_have_a_timestamp
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS days_one_open_idx ON days ((status)) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS days_date_idx ON days (day_date DESC);

-- ---------------------------------------------------------------
-- Remembered product names — autocomplete only, NOT inventory.
-- No quantity, no stock level, no reorder point: just a name.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_names (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT        NOT NULL,
  normalized_name TEXT        NOT NULL UNIQUE,
  usage_count     INTEGER     NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_names_prefix_idx
  ON product_names (normalized_name text_pattern_ops);
CREATE INDEX IF NOT EXISTS product_names_rank_idx
  ON product_names (usage_count DESC, last_used_at DESC);

-- ---------------------------------------------------------------
-- Sales. total / wholesale_total / profit are GENERATED columns, so
-- the arithmetic can never drift from the prices actually stored.
--   qty 2, wholesale 15, selling 20  ->  40 / 30 / 10
-- ---------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;

CREATE TABLE IF NOT EXISTS sales (
  id              BIGSERIAL PRIMARY KEY,
  day_id          BIGINT      NOT NULL REFERENCES days(id) ON DELETE RESTRICT,
  invoice_no      TEXT        NOT NULL UNIQUE,
  product_name    TEXT        NOT NULL CHECK (length(btrim(product_name)) > 0),
  quantity        INTEGER     NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  wholesale_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),
  selling_price   NUMERIC(12,2) NOT NULL           CHECK (selling_price   >= 0),
  payment_method  TEXT        NOT NULL REFERENCES payment_methods(code),
  total           NUMERIC(12,2) GENERATED ALWAYS AS (round(selling_price   * quantity, 2)) STORED,
  wholesale_total NUMERIC(12,2) GENERATED ALWAYS AS (round(wholesale_price * quantity, 2)) STORED,
  profit          NUMERIC(12,2) GENERATED ALWAYS AS
                    (round(selling_price * quantity, 2) - round(wholesale_price * quantity, 2)) STORED,
  sale_date       DATE        NOT NULL,
  sale_time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_day_idx     ON sales (day_id);
CREATE INDEX IF NOT EXISTS sales_date_idx    ON sales (sale_date DESC, sale_time DESC);
CREATE INDEX IF NOT EXISTS sales_product_idx ON sales (product_name);

-- ---------------------------------------------------------------
-- Daily notes: money given/spent or anything else worth recording.
-- Deliberately has no amount column — notes never enter any total.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id         BIGSERIAL PRIMARY KEY,
  day_id     BIGINT      NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  note_text  TEXT        NOT NULL CHECK (length(btrim(note_text)) > 0),
  note_date  DATE        NOT NULL,
  note_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_day_idx  ON notes (day_id);
CREATE INDEX IF NOT EXISTS notes_date_idx ON notes (note_date DESC, note_time DESC);
