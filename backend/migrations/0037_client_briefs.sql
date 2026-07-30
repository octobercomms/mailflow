-- Client knowledge layer. A living, one-page brief per client that the AI maintains
-- from the mail traffic (who they are, key people, current projects, open threads,
-- important dates). Fed back into task generation and reply drafting as context so
-- the assistant understands the business the way a colleague would. Keyed by the
-- client name from the shared client legend; the brief text is markdown the user can
-- also hand-edit.

CREATE TABLE IF NOT EXISTS client_briefs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client      TEXT NOT NULL,                             -- matches a client name in the legend
  brief       TEXT NOT NULL DEFAULT '',                  -- maintained markdown brief
  facts       JSONB NOT NULL DEFAULT '{}'::jsonb,        -- optional structured facts (reserved)
  auto        BOOLEAN NOT NULL DEFAULT true,             -- false once hand-edited: skip AI overwrite
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refreshed_at TIMESTAMPTZ,                              -- last AI regeneration
  UNIQUE (user_id, client)
);

CREATE INDEX IF NOT EXISTS idx_client_briefs_user ON client_briefs(user_id);
