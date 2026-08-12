-- Backfill for the sent-reply threading bug: upsertSentMessageRecord used to hardcode a
-- sent reply's thread_id to its OWN Message-ID, so every reply became a standalone thread
-- instead of joining the conversation. The code now computes the thread correctly for new
-- sends; this repairs the historical rows.
--
-- For each self-threaded message (thread_id = its own message_id) that is actually a reply
-- (has an in_reply_to), adopt the thread_id of its parent — the message whose message_id
-- matches this one's in_reply_to, in the same account. Inbox/original messages are already
-- threaded correctly, so the parent carries the conversation's real thread_id; one hop is
-- enough. Message-IDs are compared with surrounding <>/whitespace trimmed to tolerate
-- format differences. The generated thread_key recomputes automatically from thread_id.

UPDATE messages child
SET thread_id = parent.thread_id
FROM messages parent
WHERE child.thread_id = child.message_id
  AND child.in_reply_to IS NOT NULL AND btrim(child.in_reply_to, '<> ') <> ''
  AND parent.account_id = child.account_id
  AND parent.thread_id IS NOT NULL
  AND btrim(parent.message_id, '<> ') = btrim(child.in_reply_to, '<> ')
  AND parent.thread_id <> child.thread_id;
