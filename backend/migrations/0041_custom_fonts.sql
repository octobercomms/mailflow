-- Custom fonts uploaded through the app (e.g. Brockmann). Stored in the database so
-- they survive image rebuilds without a dedicated volume, and are served by the backend
-- at /api/fonts/custom/<filename>. Font files are small (tens of KB each), so BYTEA is fine.
CREATE TABLE IF NOT EXISTS custom_fonts (
  filename   TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
