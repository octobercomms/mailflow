import { query } from './db.js';
import { imapManager } from '../index.js';
import { generateFolderTasks, loadAiConfig, loadLegendText, parseLegend } from './taskGenerator.js';
import { loadClientBriefs, briefContextBlock } from './clientBriefs.js';

// The Tasks-hub refresh, factored out of the route so the daily scheduler and the
// POST /tasks/refresh handler run identical logic. Sweeps each of a user's
// configured task folders, files new emails as tasks under their client heading,
// and auto-completes AI tasks whose source email has left the watched folders.
// Hand-typed blocks are never touched.

const RANK = { high: 0, medium: 1, low: 2 };

// Position to place a new block right after `afterId` (fractional insert), or at the
// end when afterId is null/unknown. Shared with the manual create route.
export async function positionAfter(userId, afterId) {
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

// Per-user serialization: a manual refresh and the 8am scheduled run (or two quick
// clicks) must not overlap and double-insert. Callers await the same in-flight run.
const locks = new Map();
export async function refreshUserTasks(userId) {
  while (locks.get(userId)) { try { await locks.get(userId); } catch { /* prior run's error is its caller's */ } }
  let release;
  const gate = new Promise(r => { release = r; });
  locks.set(userId, gate);
  try { return await runRefresh(userId); }
  finally { locks.delete(userId); release(); }
}

// ── Async job registry ────────────────────────────────────────────────────────
// The refresh can take minutes across several folders — far past the 60s API
// gateway timeout — so the route starts it in the background and the client polls
// getRefreshStatus(). In-memory (single backend instance); lost state on restart
// simply reads as "not running".
const runs = new Map();   // userId -> { running, startedAt, result, error, finishedAt }

export function getRefreshStatus(userId) {
  return runs.get(userId) || { running: false, result: null, error: null };
}

export function startUserRefresh(userId) {
  const cur = runs.get(userId);
  if (cur && cur.running) return { alreadyRunning: true };
  const job = { running: true, startedAt: Date.now(), result: null, error: null, finishedAt: null };
  runs.set(userId, job);
  refreshUserTasks(userId)
    .then(result => { job.result = result; })
    .catch(err => { job.error = err.code === 'NO_SOURCES' ? 'NO_SOURCES' : (err.message || 'Refresh failed'); })
    .finally(() => { job.running = false; job.finishedAt = Date.now(); });
  return { alreadyRunning: false };
}

// Runs one refresh for a user. Throws an Error tagged with .code:
//   'NO_AI'      — provider not configured/enabled (err.status carries the HTTP code)
//   'NO_SOURCES' — the user has no task folders configured
// Returns { added, completed, groups, folders, errors }.
async function runRefresh(userId) {
  const cfg = await loadAiConfig();   // throws with .status if unavailable

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
  if (!jobs.length) { const e = new Error('No task folders configured'); e.code = 'NO_SOURCES'; throw e; }

  const legend = parseLegend(await loadLegendText());
  const briefBlock = briefContextBlock(await loadClientBriefs(userId));
  const generated = [];
  const liveRefs = new Set();
  const errors = [];
  for (const job of jobs) {
    try {
      const { tasks, refs } = await generateFolderTasks({
        account: job.account, folder: job.folder, cfg, legend, imapManager, extraContext: briefBlock,
      });
      generated.push(...tasks);
      for (const r of refs) liveRefs.add(r);
    } catch (err) {
      errors.push(`${job.account.email_address} / ${job.folder}: ${err.message}`);
    }
  }

  const existing = (await query(
    `SELECT id, kind, text, done, position, source, source_ref
       FROM tasks WHERE user_id = $1 ORDER BY position ASC, created_at ASC`,
    [userId]
  )).rows;
  const trackedRefs = new Set(existing.filter(t => t.source === 'ai' && t.source_ref).map(t => t.source_ref));

  // Auto-complete AI tasks whose source email is no longer in any watched folder —
  // skipped when any folder failed to scan, so a transient IMAP hiccup can't
  // mass-complete tasks.
  let completed = 0;
  if (errors.length === 0) {
    for (const t of existing) {
      if (t.source === 'ai' && !t.done && t.source_ref && !liveRefs.has(t.source_ref)) {
        await query('UPDATE tasks SET done = true, updated_at = NOW() WHERE id = $1', [t.id]);
        completed++;
      }
    }
  }

  generated.sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const newByGroup = new Map();
  for (const g of generated) {
    if (!g.messageId || trackedRefs.has(g.messageId)) continue;
    trackedRefs.add(g.messageId);
    const key = g.group || 'General';
    if (!newByGroup.has(key)) newByGroup.set(key, []);
    newByGroup.get(key).push(g);
  }

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

  return { added, completed, groups, folders: jobs.length, errors };
}
