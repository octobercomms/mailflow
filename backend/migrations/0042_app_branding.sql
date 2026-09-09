-- App branding assets uploaded through the app (currently the in-app logo shown in the
-- sidebar and on the login screen — NOT the favicon / PWA icon). Stored in the database
-- so it survives image rebuilds without a dedicated volume, and served by the backend at
-- /api/branding/<name>. Keyed by a short name; one row per asset.
CREATE TABLE IF NOT EXISTS app_branding (
  name       TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
