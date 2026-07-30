-- Auto-drafts. A background worker drafts a reply, in the owner's voice, for emails
-- that look like they need one — so a suggestion is waiting when the user opens the
-- message. Strictly approval-gated: a draft never sends and never touches the mailbox;
-- the user reviews it in the reading pane and clicks "Edit & send" (which opens the
-- normal composer prefilled) or dismisses it. One suggestion per source email.

CREATE TABLE IF NOT EXISTS ai_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,                             -- source email Message-ID header
  subject     TEXT,                                      -- suggested reply subject (Re: …)
  body        TEXT NOT NULL DEFAULT '',                  -- suggested reply, plain text
  status      VARCHAR(12) NOT NULL DEFAULT 'suggested',  -- 'suggested' | 'used' | 'dismissed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_drafts_user_status ON ai_drafts(user_id, status);
