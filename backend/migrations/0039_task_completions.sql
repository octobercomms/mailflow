-- Remembers which source emails the user has already actioned (an AI task they ticked
-- off, or a completed task that got cleared), keyed by the email's Message-ID. The
-- refresh skips regenerating a task for any email in here — otherwise a task the user
-- crossed off would reappear the next day simply because its email is still sitting in
-- the folder. A new reply in the thread is a different Message-ID, so it still produces
-- a fresh task.

CREATE TABLE IF NOT EXISTS task_completions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id)
);
