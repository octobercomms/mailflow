-- Native task list (replaces the ephemeral AI task panel and the user's external
-- Notion task list). A user's list is an ordered sequence of blocks — either a
-- "heading" (a client/section) or a "task" (a checkbox item) — so it edits like a
-- restricted Notion outline. AI-generated and meeting-sourced tasks land in the same
-- store; `source` + `source_ref` let the daily refresh add new items and auto-tick the
-- ones whose source email has been filed out of the folder, without touching hand-typed
-- blocks.

CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        VARCHAR(16) NOT NULL DEFAULT 'task',       -- 'heading' | 'task'
  text        TEXT NOT NULL DEFAULT '',
  done        BOOLEAN NOT NULL DEFAULT false,
  priority    VARCHAR(8),                                -- 'high' | 'medium' | 'low' | null
  position    DOUBLE PRECISION NOT NULL DEFAULT 0,       -- fractional ordering
  source      VARCHAR(16) NOT NULL DEFAULT 'manual',     -- 'manual' | 'ai' | 'meeting'
  source_ref  TEXT,                                      -- e.g. the source email's Message-ID
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_position ON tasks(user_id, position);
-- Fast "does an AI task already exist for this email?" lookups during refresh.
CREATE INDEX IF NOT EXISTS idx_tasks_user_source_ref ON tasks(user_id, source_ref) WHERE source_ref IS NOT NULL;
