-- Repair threads that were over-grouped by the subject fallback's NOW()-anchored window
-- (see computeThreadId). That bug glued same-subject messages together across huge date
-- gaps — e.g. a 2016 "website" email and a 2026 "WEBSITE" email ending up in one thread,
-- so the old one surfaced as a sibling when the thread was expanded in a 2026 folder.
--
-- Un-thread ONLY the messages that have no RFC reply linkage (in_reply_to / references) —
-- those are the ones the subject fallback joined; genuine reply chains are left intact —
-- and ONLY within threads whose members span more than a year (the hallmark of subject
-- over-grouping; real conversations don't run continuously for that long). Resetting
-- thread_id to the message's own Message-ID un-groups it; thread_key is a generated column
-- (COALESCE(thread_id, id::text)) and updates automatically. Non-destructive: no message
-- is deleted, they just stop being falsely threaded.

WITH wide AS (
  SELECT account_id, thread_id
  FROM messages
  WHERE thread_id IS NOT NULL
  GROUP BY account_id, thread_id
  HAVING MAX(date) - MIN(date) > INTERVAL '365 days'
)
UPDATE messages m
SET thread_id = m.message_id
FROM wide w
WHERE m.account_id = w.account_id
  AND m.thread_id  = w.thread_id
  AND m.message_id IS NOT NULL
  AND COALESCE(m.in_reply_to, '') = ''
  AND COALESCE(m.thread_references, '') = '';
