import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

// Native task list — an ordered sequence of blocks (headings + checkbox tasks) per
// user. Edited like a restricted Notion outline; the AI "refresh from folder" and the
// daily cron write into the same store (source='ai'), so hand-typed and generated
// tasks live together.
const router = Router();

const uid = (req) => req.session.userId;

// Whole list, in order.
router.get('/tasks', requireAuth, async (req, res) => {
  const r = await query(
    `SELECT id, kind, text, done, priority, position, source, source_ref
       FROM tasks WHERE user_id = $1 ORDER BY position ASC, created_at ASC`,
    [uid(req)]
  );
  res.json({ tasks: r.rows });
});

// Create a block. Optional afterId inserts right after that block; otherwise appends.
router.post('/tasks', requireAuth, async (req, res) => {
  const { kind = 'task', text = '', afterId, priority = null } = req.body || {};
  if (!['heading', 'task'].includes(kind)) return res.status(400).json({ error: 'bad kind' });

  let position;
  if (afterId) {
    const cur = (await query('SELECT position FROM tasks WHERE id = $1 AND user_id = $2', [afterId, uid(req)])).rows[0];
    if (cur) {
      const next = (await query(
        'SELECT position FROM tasks WHERE user_id = $1 AND position > $2 ORDER BY position ASC LIMIT 1',
        [uid(req), cur.position]
      )).rows[0];
      position = next ? (Number(cur.position) + Number(next.position)) / 2 : Number(cur.position) + 1;
    }
  }
  if (position == null) {
    const max = (await query('SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE user_id = $1', [uid(req)])).rows[0];
    position = Number(max.m) + 1;
  }

  const r = await query(
    `INSERT INTO tasks (user_id, kind, text, priority, position, source)
     VALUES ($1,$2,$3,$4,$5,'manual')
     RETURNING id, kind, text, done, priority, position, source, source_ref`,
    [uid(req), kind, String(text).slice(0, 2000), priority, position]
  );
  res.status(201).json(r.rows[0]);
});

// Update text / done / kind / priority.
router.patch('/tasks/:id', requireAuth, async (req, res) => {
  const { text, done, kind, priority } = req.body || {};
  const sets = [], vals = [uid(req), req.params.id];
  let p = 3;
  if (text !== undefined)     { sets.push(`text = $${p++}`);     vals.push(String(text).slice(0, 2000)); }
  if (done !== undefined)     { sets.push(`done = $${p++}`);     vals.push(!!done); }
  if (kind !== undefined)     { if (!['heading','task'].includes(kind)) return res.status(400).json({ error: 'bad kind' }); sets.push(`kind = $${p++}`); vals.push(kind); }
  if (priority !== undefined) { sets.push(`priority = $${p++}`); vals.push(priority); }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at = NOW()');
  const r = await query(
    `UPDATE tasks SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2
     RETURNING id, kind, text, done, priority, position, source, source_ref`,
    vals
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

router.delete('/tasks/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM tasks WHERE user_id = $1 AND id = $2', [uid(req), req.params.id]);
  res.json({ ok: true });
});

// Reassign positions to match the given id order (0,1,2,…).
router.post('/tasks/reorder', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  for (let i = 0; i < ids.length; i++) {
    await query('UPDATE tasks SET position = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3', [i, uid(req), ids[i]]);
  }
  res.json({ ok: true });
});

// Clear completed tasks (headings are never removed).
router.post('/tasks/clear-done', requireAuth, async (req, res) => {
  const r = await query("DELETE FROM tasks WHERE user_id = $1 AND kind = 'task' AND done = true", [uid(req)]);
  res.json({ ok: true, removed: r.rowCount });
});

export default router;
