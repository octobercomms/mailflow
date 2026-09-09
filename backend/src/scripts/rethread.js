// One-off maintenance: recompute thread_id for every existing message so historical
// mail groups into conversations the same way newly-synced mail does. Threading is
// normally assigned at sync time; this backfills accounts whose older messages predate
// the current threading logic (or were never re-threaded).
//
// It reuses the live computeThreadId() so the result matches exactly what sync would
// produce. Messages are processed oldest-first per account: computeThreadId reads the
// (already-updated) thread_id of ancestors, so a reply adopts its parent's thread and
// the whole chain converges in a single pass. The generated thread_key column
// (COALESCE(thread_id, id)) recomputes automatically, so the threaded list regroups
// once the run finishes and the client refreshes.
//
// Run inside the backend container:
//   docker compose -p mailflow -f docker-compose.yml -f docker-compose.https.yml --profile https exec backend node src/scripts/rethread.js
// or:
//   docker exec mailflow-backend node src/scripts/rethread.js
import { pool, query } from '../services/db.js';
import { computeThreadId } from '../services/imapManager.js';

async function main() {
  const accounts = await query(
    'SELECT id, email_address FROM email_accounts WHERE enabled = true ORDER BY id'
  );
  console.log(`[rethread] ${accounts.rows.length} account(s)`);

  let grandTotal = 0;
  for (const acct of accounts.rows) {
    const msgs = await query(
      `SELECT id, message_id, in_reply_to, thread_references, subject, date, thread_id
         FROM messages
        WHERE account_id = $1 AND is_deleted = false
        ORDER BY date ASC NULLS FIRST, id ASC`,
      [acct.id]
    );

    let changed = 0;
    let processed = 0;
    for (const m of msgs.rows) {
      processed++;
      if (!m.message_id) continue;
      let newTid;
      try {
        newTid = await computeThreadId(
          acct.id, m.message_id, m.in_reply_to, m.thread_references, m.subject, m.date
        );
      } catch (err) {
        console.warn(`[rethread]   skip ${m.id}: ${err.message}`);
        continue;
      }
      if (newTid && newTid !== m.thread_id) {
        await query('UPDATE messages SET thread_id = $1 WHERE id = $2', [newTid, m.id]);
        changed++;
      }
      if (processed % 2000 === 0) {
        console.log(`[rethread]   ${acct.email_address}: ${processed}/${msgs.rows.length} (${changed} re-threaded)`);
      }
    }

    grandTotal += changed;
    console.log(`[rethread] ${acct.email_address}: ${msgs.rows.length} messages, ${changed} re-threaded`);
  }

  console.log(`[rethread] done — ${grandTotal} message(s) re-threaded across ${accounts.rows.length} account(s)`);
}

main()
  .then(() => pool.end())
  .catch(err => { console.error('[rethread] failed:', err); pool.end().finally(() => process.exit(1)); });
