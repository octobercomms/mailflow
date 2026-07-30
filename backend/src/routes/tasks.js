import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { generateFolderTasks, loadAiConfig, loadLegendText, parseLegend } from '../services/taskGenerator.js';

// Native task list — an ordered sequence of blocks (headings + checkbox tasks) per
// user. Edited like a restricted Notion outline; the AI "refresh from folder" and the
// daily cron write into the same store (source='ai'), so hand-typed and generated
// tasks live together.
const router = Router();

const uid = (req) => req.session.userId;

// Position to place a new block right after `afterId` (fractional insert), or at the
// end when afterId is null/unknown. Shared by manual create and the AI refresh.
async function positionAfter(userId, afterId) {
  if (afterId) {
    const cur = (await query('SELECT position FROM tasks WHERE id = $1 AND user_id = $2', [afterId, userId])).rows[0];
    if (cur) {
      const next = (await query(
        'SELECT position FROM tasks WHERE user_id = $1 AND position > $2 ORDER BY position ASC LIMIT 1',
        [userId, cur.position]
      )).rows[0];
      return next ? (Number(cur.position) + Number(next.position)) / 2 : Number(cur.position) + 1;
    }
  }
  const max = (await query('SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE user_id = $1', [userId])).rows[0];
  return Number(max.m) + 1;
}

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
  const sources = prefRow.rows[0]?.preferences?.taskSources || {};
  const accounts = [];
  for (const a of accts.rows) {
    const folders = (await query(
      'SELECT path, name FROM folders WHERE account_id = $1 ORDER BY path', [a.id]
    )).rows;
    accounts.push({ id: a.id, email: a.email_address, folders });
  }
  res.json({ sources, accounts });
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
  res.json({ ok: true, sources: clean });
});

// ── AI refresh into the hub ───────────────────────────────────────────────────
// Sweep every configured task folder, generate tasks, and merge into this user's
// list: new emails become tasks filed under their client heading; AI tasks whose
// source email has left the watched folders auto-complete; hand-typed blocks are
// never touched.
const RANK = { high: 0, medium: 1, low: 2 };

router.post('/tasks/refresh', requireAuth, async (req, res) => {
  const userId = uid(req);

  let cfg;
  try { cfg = await loadAiConfig(); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

  const prefRow = await query('SELECT preferences FROM users WHERE id = $1', [userId]);
  const sources = prefRow.rows[0]?.preferences?.taskSources || {};
  const accts = await query('SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = true', [userId]);

  const jobs = [];
  for (const a of accts.rows) {
    const c = sources[a.id];
    if (!c || c.enabled === false) continue;
    for (const f of (Array.isArray(c.folders) ? c.folders : []).filter(Boolean)) {
      jobs.push({ account: a, folder: f });
    }
  }
  if (!jobs.length) {
    return res.status(400).json({ error: 'No task folders configured. Choose which accounts and folders to read in Task settings.' });
  }

  const legend = parseLegend(await loadLegendText());
  const generated = [];
  const liveRefs = new Set();
  const errors = [];
  for (const job of jobs) {
    try {
      const { tasks, refs } = await generateFolderTasks({ account: job.account, folder: job.folder, cfg, legend, imapManager });
      generated.push(...tasks);
      for (const r of refs) liveRefs.add(r);
    } catch (err) {
      errors.push(`${job.account.email_address} / ${job.folder}: ${err.message}`);
    }
  }

  // Everything currently in the list.
  const existing = (await query(
    `SELECT id, kind, text, done, position, source, source_ref
       FROM tasks WHERE user_id = $1 ORDER BY position ASC, created_at ASC`,
    [userId]
  )).rows;
  const trackedRefs = new Set(existing.filter(t => t.source === 'ai' && t.source_ref).map(t => t.source_ref));

  // Auto-complete AI tasks whose source email is no longer in any watched folder —
  // i.e. the user filed it away, so the to-do is dealt with. Skipped when any folder
  // failed to scan this run, so a transient IMAP hiccup can't mass-complete tasks.
  let completed = 0;
  if (errors.length === 0) {
    for (const t of existing) {
      if (t.source === 'ai' && !t.done && t.source_ref && !liveRefs.has(t.source_ref)) {
        await query('UPDATE tasks SET done = true, updated_at = NOW() WHERE id = $1', [t.id]);
        completed++;
      }
    }
  }

  // New tasks (not already tracked), grouped by client, high→low within each group.
  generated.sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const newByGroup = new Map();
  for (const g of generated) {
    if (!g.messageId || trackedRefs.has(g.messageId)) continue;  // no ref → can't dedupe; already tracked → skip
    trackedRefs.add(g.messageId);                                 // guard dupes within this run
    const key = g.group || 'General';
    if (!newByGroup.has(key)) newByGroup.set(key, []);
    newByGroup.get(key).push(g);
  }

  // File each new task under its client heading (reuse an existing heading of the
  // same name, else create one), stacking tasks right beneath the heading.
  const norm = s => String(s || '').trim().toLowerCase();
  const headingByText = new Map();
  for (const t of existing) if (t.kind === 'heading') headingByText.set(norm(t.text), t.id);

  let added = 0;
  const groups = [];
  for (const [group, tasks] of newByGroup) {
    let headingId = headingByText.get(norm(group));
    if (!headingId) {
      const pos = await positionAfter(userId, null);
      const h = await query(
        `INSERT INTO tasks (user_id, kind, text, position, source) VALUES ($1,'heading',$2,$3,'ai') RETURNING id`,
        [userId, group.slice(0, 200), pos]
      );
      headingId = h.rows[0].id;
      headingByText.set(norm(group), headingId);
    }
    groups.push(group);
    let afterId = headingId;
    for (const g of tasks) {
      const text = g.detail ? `${g.title} — ${g.detail}` : g.title;
      const pos = await positionAfter(userId, afterId);
      const r = await query(
        `INSERT INTO tasks (user_id, kind, text, priority, position, source, source_ref)
         VALUES ($1,'task',$2,$3,$4,'ai',$5) RETURNING id`,
        [userId, text.slice(0, 2000), g.priority, pos, g.messageId]
      );
      afterId = r.rows[0].id;
      added++;
    }
  }

  res.json({ ok: true, added, completed, groups, folders: jobs.length, errors });
});

export default router;
