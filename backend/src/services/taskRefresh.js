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
export async function refreshUserTasks(userId, opts = {}) {
  while (locks.get(userId)) { try { await locks.get(userId); } catch { /* prior run's error is its caller's */ } }
  let release;
  const gate = new Promise(r => { release = r; });
  locks.set(userId, gate);
  try { return await runRefresh(userId, opts); }
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

export function startUserRefresh(userId, opts = {}) {
  const cur = runs.get(userId);
  if (cur && cur.running) return { alreadyRunning: true };
  const job = { running: true, startedAt: Date.now(), result: null, error: null, finishedAt: null };
  runs.set(userId, job);
  refreshUserTasks(userId, opts)
    .then(result => { job.result = result; })
    .catch(err => { job.error = err.code === 'NO_SOURCES' ? 'NO_SOURCES' : (err.message || 'Refresh failed'); })
    .finally(() => { job.running = false; job.finishedAt = Date.now(); });
  return { alreadyRunning: false };
}

// Runs one refresh for a user. Throws an Error tagged with .code:
//   'NO_AI'      — provider not configured/enabled (err.status carries the HTTP code)
//   'NO_SOURCES' — the user has no task folders configured
// opts.rebuild deletes existing AI-generated tasks first, so the list is regenerated
// from scratch (used to clear stale wording from an earlier run). Hand-typed tasks and
// headings are never touched.
// Returns { added, completed, groups, folders, errors, rebuilt }.
async function runRefresh(userId, opts = {}) {
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
      const label = job.account.name || job.account.email_address;
      for (const tk of tasks) tk.account = label;
      generated.push(...tasks);
      for (const r of refs) liveRefs.add(r);
    } catch (err) {
      errors.push(`${job.account.email_address} / ${job.folder}: ${err.message}`);
    }
  }

  // Rebuild: clear previously-generated tasks AND their headings/account headers so the
  // list regenerates cleanly (drops stale wording, re-nests under accounts). Only once
  // generation SUCCEEDED for at least one folder, so a total AI failure can't wipe the
  // list. Hand-typed blocks (source='manual') are preserved.
  let rebuilt = false;
  if (opts.rebuild && (generated.length > 0 || errors.length < jobs.length)) {
    await query("DELETE FROM tasks WHERE user_id = $1 AND source = 'ai' AND kind IN ('task','heading','account')", [userId]);
    rebuilt = true;
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

  const norm = s => String(s || '').trim().toLowerCase();
  const stripYear = s => String(s || '').replace(/\s+(?:19|20)\d{2}$/i, '').trim();   // "Foo 2026" → "Foo"
  const clientKey = s => norm(stripYear(s));

  // Two levels: group new tasks by account, then by canonical client (so each account
  // keeps its own "Other", and near-duplicate client names like "X" / "X 2026" merge).
  generated.sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const newByAccount = new Map();   // acctKey -> { display, clients: Map(clientKey -> { display, tasks }) }
  for (const g of generated) {
    if (!g.messageId || trackedRefs.has(g.messageId)) continue;
    trackedRefs.add(g.messageId);
    const acctDisplay = g.account || 'Mail';
    const aKey = norm(acctDisplay);
    if (!newByAccount.has(aKey)) newByAccount.set(aKey, { display: acctDisplay, clients: new Map() });
    const acct = newByAccount.get(aKey);
    const cKey = clientKey(g.group || 'Other') || 'other';
    if (!acct.clients.has(cKey)) acct.clients.set(cKey, { display: stripYear(g.group || 'Other') || 'Other', tasks: [] });
    acct.clients.get(cKey).tasks.push(g);
  }

  // Map existing structure (walking with account context) so a refresh nests new items
  // under the right account/client instead of duplicating headers.
  const accountHeadingId = new Map();    // acctKey -> id
  const accountSectionLast = new Map();  // acctKey -> last block id in that account's section
  const clientHeadingId = new Map();     // `${acctKey} ${clientKey}` -> id
  const clientLast = new Map();          // same key -> last block id under that client
  {
    let curA = null, curC = null;
    for (const b of existing) {
      if (b.kind === 'account') { curA = norm(b.text); accountHeadingId.set(curA, b.id); accountSectionLast.set(curA, b.id); curC = null; }
      else if (b.kind === 'heading' && curA) { curC = `${curA} ${clientKey(b.text)}`; clientHeadingId.set(curC, b.id); clientLast.set(curC, b.id); accountSectionLast.set(curA, b.id); }
      else if (b.kind === 'task' && curA) { accountSectionLast.set(curA, b.id); if (curC) clientLast.set(curC, b.id); }
      else if (b.kind === 'heading') { curC = null; }   // manual top-level heading breaks account context
    }
  }

  const insertBlock = async (kind, text, afterId, extra = {}) => {
    const pos = await positionAfter(userId, afterId);
    const cols = ['user_id', 'kind', 'text', 'position', 'source'];
    const vals = [userId, kind, String(text).slice(0, 2000), pos, 'ai'];
    if (extra.priority !== undefined) { cols.push('priority'); vals.push(extra.priority); }
    if (extra.sourceRef !== undefined) { cols.push('source_ref'); vals.push(extra.sourceRef); }
    const ph = vals.map((_, i) => `$${i + 1}`).join(',');
    const r = await query(`INSERT INTO tasks (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals);
    return r.rows[0].id;
  };

  let added = 0;
  const groups = [];
  for (const [aKey, acct] of newByAccount) {
    let acctId = accountHeadingId.get(aKey);
    if (!acctId) {
      acctId = await insertBlock('account', acct.display.slice(0, 200), null);   // append at end
      accountHeadingId.set(aKey, acctId);
      accountSectionLast.set(aKey, acctId);
    }
    for (const [cKey, client] of acct.clients) {
      const fullKey = `${aKey} ${cKey}`;
      let cId = clientHeadingId.get(fullKey);
      if (!cId) {
        cId = await insertBlock('heading', client.display.slice(0, 200), accountSectionLast.get(aKey) || acctId);
        clientHeadingId.set(fullKey, cId);
        clientLast.set(fullKey, cId);
        accountSectionLast.set(aKey, cId);
        groups.push(client.display);
      }
      let afterId = clientLast.get(fullKey) || cId;
      for (const g of client.tasks) {
        const text = g.detail ? `${g.title} — ${g.detail}` : g.title;
        afterId = await insertBlock('task', text, afterId, { priority: g.priority, sourceRef: g.messageId });
        clientLast.set(fullKey, afterId);
        accountSectionLast.set(aKey, afterId);
        added++;
      }
    }
  }

  return { added, completed, groups, folders: jobs.length, errors, rebuilt };
}
