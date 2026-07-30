import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { runDraftSweep, generateDraftForMessageId } from '../services/draftWriter.js';

// Auto-drafts API. Suggestions are keyed by the source email's Message-ID so the
// reading pane can ask "is there a draft waiting for this email?". Nothing here sends
// mail — the frontend opens the normal composer prefilled and the user sends.
const router = Router();
const uid = (req) => req.session.userId;

// Count + list of pending suggestions (for a "drafts waiting" indicator).
router.get('/ai-drafts', requireAuth, async (req, res) => {
  const r = await query(
    `SELECT d.id, d.message_id, d.subject, d.account_id, d.updated_at,
            m.from_name, m.from_email
       FROM ai_drafts d
       LEFT JOIN LATERAL (
         SELECT from_name, from_email FROM messages
          WHERE account_id = d.account_id AND message_id = d.message_id
          ORDER BY date DESC LIMIT 1
       ) m ON true
      WHERE d.user_id = $1 AND d.status = 'suggested'
      ORDER BY d.updated_at DESC LIMIT 200`,
    [uid(req)]
  );
  res.json({ count: r.rows.length, drafts: r.rows });
});

// The suggestion for one source email, if any (status suggested).
router.get('/ai-drafts/for/:messageId', requireAuth, async (req, res) => {
  const r = await query(
    `SELECT id, message_id, subject, body, status FROM ai_drafts
      WHERE user_id = $1 AND message_id = $2 AND status = 'suggested'`,
    [uid(req), req.params.messageId]
  );
  res.json({ draft: r.rows[0] || null });
});

// Generate (or refresh) a suggestion for one open email on demand.
router.post('/ai-drafts/for/:messageId', requireAuth, async (req, res) => {
  try {
    const draft = await generateDraftForMessageId(uid(req), req.params.messageId);
    res.json({ ok: true, draft });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Draft failed' });
  }
});

// Mark a suggestion used or dismissed.
router.patch('/ai-drafts/:id', requireAuth, async (req, res) => {
  const status = req.body?.status;
  if (!['used', 'dismissed', 'suggested'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const r = await query(
    `UPDATE ai_drafts SET status = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING id, status`,
    [uid(req), req.params.id, status]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, ...r.rows[0] });
});

// Manually run a sweep across watched folders.
router.post('/ai-drafts/sweep', requireAuth, async (req, res) => {
  try {
    const result = await runDraftSweep(uid(req));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Sweep failed' });
  }
});

export default router;
