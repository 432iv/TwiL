ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_sub TEXT,
  ADD COLUMN IF NOT EXISTS google_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uq
  ON users (google_sub) WHERE google_sub IS NOT NULL;
