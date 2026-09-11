// Conversation threading — assigning a stable thread_id to a message from its
// RFC 5322 reference chain, with a subject-normalization fallback.
//
// This lives in its own module (importing only the DB) so that command-line
// scripts like rethread.js and route handlers can reuse the exact threading
// logic sync uses WITHOUT pulling in imapManager.js and, through it, the whole
// server bootstrap (index.js). Importing that chain from a standalone script
// booted the server and tripped a circular-import error.

import { query } from './db.js';

// Parse RFC 5322 References header into an ordered array of angle-bracketed Message-IDs.
export function parseReferences(refHeader) {
  if (!refHeader) return [];
  return refHeader.match(/<[^>]+>/g) || [];
}

// Strip common reply/forward prefixes (Re:, FW:, AW:, SV:, …) from a subject,
// handling multiple nested levels, and return the lowercase core.
const SUBJECT_PREFIX_RE = /^(?:re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)\s*:\s*/i;
export function normalizeSubject(subject) {
  if (!subject) return '';
  let s = subject.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(SUBJECT_PREFIX_RE, '').trim();
  } while (s !== prev);
  return s.toLowerCase();
}

// Compute the thread_id for an incoming message.
// Primary: RFC 5322 References / In-Reply-To header chain.
// Fallback: subject normalization when headers are absent (e.g. Outlook RE: replies).
export async function computeThreadId(accountId, messageId, inReplyTo, references, subject, msgDate) {
  if (!messageId) return null;

  const refIds = parseReferences(references);
  const candidates = [...refIds];
  if (inReplyTo && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);

  if (candidates.length > 0) {
    // Fetch all candidates in one query instead of N sequential lookups.
    // Priority: RFC 5322 root (candidates[0]) > newest ancestor (candidates[last]).
    const rows = await query(
      `SELECT message_id, thread_id FROM messages
       WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
      [accountId, candidates]
    );

    if (rows.rows.length > 0) {
      const found = new Map(rows.rows.map(r => [r.message_id, r.thread_id]));
      // Prefer the thread root (first Reference per RFC 5322).
      if (found.has(candidates[0])) return found.get(candidates[0]);
      // Otherwise use the most recent ancestor present in the DB (newest→oldest).
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (found.has(candidates[i])) return found.get(candidates[i]);
      }
    }

    // Ancestor referenced but not yet in DB — use the root as a provisional thread_id.
    // When it arrives its thread_id will equal its own message_id, so threads converge.
    // Don't fall through to subject fallback; the header chain takes priority.
    return candidates[0] || messageId;
  }

  // No RFC 5322 threading headers — fall back to subject normalization: join the earliest
  // message in the same account with the same normalized subject that is temporally NEAR
  // this one.
  //
  // The window is anchored to THIS message's own date (±90 days), NOT NOW(). Anchoring to
  // NOW() was the bug behind cross-decade threads: an old message backfilled today (its
  // own date years ago) matched *recent* same-subject mail and joined a thread years newer
  // — e.g. a 2016 "website" email glued onto a 2026 "WEBSITE" conversation. Bounding to the
  // message's own date means only a genuine burst of same-subject mail threads together.
  const normalized = normalizeSubject(subject);
  if (normalized) {
    const subjectRow = msgDate
      ? await query(
          `SELECT thread_id FROM messages
           WHERE account_id = $1
             AND is_deleted = false
             AND message_id IS DISTINCT FROM $2
             AND thread_id IS NOT NULL
             AND normalized_subject = $3
             AND date BETWEEN $4::timestamptz - INTERVAL '90 days'
                          AND $4::timestamptz + INTERVAL '90 days'
           ORDER BY date ASC
           LIMIT 1`,
          [accountId, messageId, normalized, msgDate]
        )
      : await query(
          `SELECT thread_id FROM messages
           WHERE account_id = $1
             AND is_deleted = false
             AND message_id IS DISTINCT FROM $2
             AND thread_id IS NOT NULL
             AND normalized_subject = $3
             AND date > NOW() - INTERVAL '90 days'
           ORDER BY date ASC
           LIMIT 1`,
          [accountId, messageId, normalized]
        );
    if (subjectRow.rows.length > 0) return subjectRow.rows[0].thread_id;
  }

  return messageId;
}
