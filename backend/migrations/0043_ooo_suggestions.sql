-- Out-of-office contact-update suggestions.
--
-- MailFlow scans auto-reply / out-of-office messages across every account and folder,
-- asks the AI to extract lasting contact changes (a person left or gave a new address,
-- or named someone else to contact), and stores a reviewable suggestion. Phase 1 emails
-- the user the list; a later phase pushes these into OMI's review queue. Suggestions are
-- intentionally independent of the source message (no cascade): the value is that a
-- suggestion survives even if the email is later deleted.

CREATE TABLE IF NOT EXISTS ooo_suggestions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id        UUID,
  source_message_id UUID,               -- snapshot reference only; not an FK, survives deletion
  category          TEXT NOT NULL,       -- left_or_moved | mentions_alt_contact
  person_name       TEXT,
  person_email      TEXT,               -- the sender / person the OOO is about
  new_email         TEXT,
  new_company       TEXT,
  role              TEXT,
  alt_contacts      JSONB DEFAULT '[]', -- [{ name, email, role, company }]
  source_quote      TEXT,
  from_email        TEXT,               -- context snapshot from the email
  subject           TEXT,
  message_date      TIMESTAMPTZ,
  confidence        REAL,
  status            TEXT NOT NULL DEFAULT 'new', -- new | notified | pushed | dismissed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ooo_suggestions_user_status
  ON ooo_suggestions(user_id, status, created_at DESC);

-- Which messages have already been scanned, so re-runs (and the daily pass) only look at
-- new auto-replies and never re-pay the AI for the same email. Cascades with the message:
-- if the row is gone, forgetting we scanned it is harmless.
CREATE TABLE IF NOT EXISTS ooo_scan_state (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
