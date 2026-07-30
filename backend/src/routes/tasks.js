import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { refreshUserTasks, positionAfter } from '../services/taskRefresh.js';

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

  const position = await positionAfter(uid(req), afterId);
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

// ── Task sources (per-account config) ─────────────────────────────────────────
// Which accounts to read, and which folder(s) in each are the "to-do" folders the
// AI refresh should sweep. Stored in users.preferences.taskSources as
// { [accountId]: { enabled: bool, folders: [path,…] } }. GET also returns the
// account + folder list so the settings panel is a single call.
router.get('/tasks/sources', requireAuth, async (req, res) => {
  const userId = uid(req);
  const [prefRow, accts] = await Promise.all([
    query('SELECT preferences FROM users WHERE id = $1', [userId]),
    query("SELECT id, email_address, protocol FROM email_accounts WHERE user_id = $1 AND enabled = true ORDER BY sort_order, email_address", [userId]),
  ]);
  const prefs = prefRow.rows[0]?.preferences || {};
  const sources = prefs.taskSources || {};
  const auto = prefs.taskAutoRefresh || {};
  const autoRefresh = { enabled: auto.enabled === true, hour: Number.isInteger(auto.hour) ? auto.hour : 8, tz: auto.tz || null };
  const autoDrafts = { enabled: prefs.autoDrafts?.enabled === true };
  const accounts = [];
  for (const a of accts.rows) {
    const folders = (await query(
      'SELECT path, name FROM folders WHERE account_id = $1 ORDER BY path', [a.id]
    )).rows;
    accounts.push({ id: a.id, email: a.email_address, folders });
  }
  res.json({ sources, accounts, autoRefresh, autoDrafts });
});

router.put('/tasks/sources', requireAuth, async (req, res) => {
  const userId = uid(req);
  const incoming = (req.body && typeof req.body.sources === 'object' && req.body.sources) || {};
  // Only accept keys that are accounts the caller owns; bound the shape.
  const owned = new Set((await query('SELECT id FROM email_accounts WHERE user_id = $1', [userId])).rows.map(r => r.id));
  const clean = {};
  for (const [accId, cfg] of Object.entries(incoming)) {
    if (!owned.has(accId)) continue;
    const folders = Array.isArray(cfg?.folders)
      ? cfg.folders.filter(f => typeof f === 'string').map(f => f.slice(0, 500)).slice(0, 50)
      : [];
    clean[accId] = { enabled: cfg?.enabled !== false, folders };
  }
  await query(
    `UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'::jsonb), '{taskSources}', $2::jsonb, true) WHERE id = $1`,
    [userId, JSON.stringify(clean)]
  );

  // Optional daily-refresh config. Merge onto the existing object so lastRun (managed
  // by the scheduler) survives a settings save.
  if (req.body && typeof req.body.autoRefresh === 'object' && req.body.autoRefresh) {
    const a = req.body.autoRefresh;
    const hour = Number(a.hour);
    const auto = {
      enabled: a.enabled === true,
      hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
      tz: typeof a.tz === 'string' && a.tz.length <= 64 ? a.tz : null,
    };
    await query(
      `UPDATE users SET preferences =
         jsonb_set(COALESCE(preferences,'{}'::jsonb), '{taskAutoRefresh}',
           COALESCE(preferences->'taskAutoRefresh','{}'::jsonb) || $2::jsonb, true)
       WHERE id = $1`,
      [userId, JSON.stringify(auto)]
    );
  }

  // Background auto-drafts toggle.
  if (req.body && typeof req.body.autoDrafts === 'object' && req.body.autoDrafts) {
    await query(
      `UPDATE users SET preferences =
         jsonb_set(COALESCE(preferences,'{}'::jsonb), '{autoDrafts}', $2::jsonb, true) WHERE id = $1`,
      [userId, JSON.stringify({ enabled: req.body.autoDrafts.enabled === true })]
    );
  }
  res.json({ ok: true, sources: clean });
});

// ── AI refresh into the hub ───────────────────────────────────────────────────
// Sweep every configured task folder, generate tasks, and merge into this user's
// list (see services/taskRefresh.js). The daily scheduler calls the same function.
router.post('/tasks/refresh', requireAuth, async (req, res) => {
  try {
    const result = await refreshUserTasks(uid(req));
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'NO_SOURCES') {
      return res.status(400).json({ error: 'No task folders configured. Choose which accounts and folders to read in Task settings.' });
    }
    res.status(err.status || 502).json({ error: err.message || 'Refresh failed' });
  }
});

export default router;
