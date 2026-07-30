import { query } from './db.js';
import { aiComplete, loadAiConfig } from './taskGenerator.js';

// Phase 6 — the assistant's daily brief and per-task "how to tackle this" help.
// Both read what's already in the hub (tasks, waiting drafts) and ask the model for
// something short and useful. The brief is cached per day in preferences.dailyBrief so
// it's waiting in the morning; task assist is generated on demand.

const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Walk the ordered blocks into "CLIENT → [tasks]" text for the prompt.
async function openTaskOutline(userId) {
  const rows = (await query(
    `SELECT kind, text, done, priority FROM tasks WHERE user_id = $1 ORDER BY position ASC, created_at ASC`,
    [userId]
  )).rows;
  const lines = [];
  let open = 0;
  for (const b of rows) {
    if (b.kind === 'account') { lines.push(`\n# ${b.text || 'Mail'}`); continue; }
    if (b.kind === 'heading') { lines.push(`\n## ${b.text || 'General'}`); continue; }
    if (b.kind !== 'task' || b.done) continue;
    open++;
    const pri = b.priority && b.priority !== 'medium' ? ` [${b.priority}]` : '';
    lines.push(`- ${clip(b.text, 240)}${pri}`);
  }
  return { outline: lines.join('\n').trim(), open };
}

export async function generateDailyBrief(userId, cfg, { save = true } = {}) {
  cfg = cfg || await loadAiConfig();
  const { outline, open } = await openTaskOutline(userId);
  const drafts = (await query("SELECT COUNT(*)::int AS n FROM ai_drafts WHERE user_id = $1 AND status = 'suggested'", [userId])).rows[0].n;

  if (!open && !drafts) {
    const text = 'Nothing outstanding on your list right now — inbox and tasks are clear. Enjoy it.';
    if (save) await cacheBrief(userId, text);
    return { brief: text, open, drafts };
  }

  const today = new Date().toISOString().slice(0, 10);
  const system =
    'You are a sharp executive assistant writing the morning brief for a busy agency owner. ' +
    'From their open task list (grouped by client) and the count of reply drafts waiting for them, write a short, ' +
    'skimmable brief: a one-line hello + read of the day, then the 3–5 things that most deserve attention today ' +
    '(name the client and why it matters), then a one-line nudge on the waiting drafts if any. ' +
    'Be concrete and prioritise ruthlessly — do not just restate the whole list. Warm but efficient. ' +
    'IMPORTANT: do NOT invent urgency or deadlines. Only call something time-critical if the task text itself states a ' +
    'concrete deadline that is at/after today\'s date. Never describe a task as "due today" / "this week" unless the ' +
    'task text clearly says so with a date that is still current — the tasks come from emails of varying ages. ' +
    'Plain text or light markdown, no headings-heavy formatting. Under ~180 words.';
  const user =
    `TODAY'S DATE IS ${today}.\n\n` +
    `OPEN TASKS (${open}), grouped by client:\n${outline || '(none)'}\n\n` +
    `REPLY DRAFTS WAITING FOR REVIEW: ${drafts}\n\n` +
    'Write the brief.';

  const brief = (await aiComplete(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])).trim();

  if (save) await cacheBrief(userId, brief);
  return { brief, open, drafts };
}

function todayStr() {
  // UTC day key — good enough for a "today's brief" cache.
  return new Date().toISOString().slice(0, 10);
}

async function cacheBrief(userId, brief) {
  await query(
    `UPDATE users SET preferences =
       jsonb_set(COALESCE(preferences,'{}'::jsonb), '{dailyBrief}', $2::jsonb, true) WHERE id = $1`,
    [userId, JSON.stringify({ date: todayStr(), text: brief.slice(0, 4000) })]
  );
}

export async function getCachedBrief(userId) {
  const prefs = (await query('SELECT preferences FROM users WHERE id = $1', [userId])).rows[0]?.preferences || {};
  const b = prefs.dailyBrief;
  if (!b) return null;
  return { text: b.text || '', date: b.date || null, stale: b.date !== todayStr() };
}

// Per-task "how would I tackle this?" help. Pulls in the source email (if the task
// came from one) for context. Returns short, actionable guidance.
export async function generateTaskAssist(userId, taskId, cfg) {
  cfg = cfg || await loadAiConfig();
  const task = (await query('SELECT id, text, source, source_ref FROM tasks WHERE user_id = $1 AND id = $2', [userId, taskId])).rows[0];
  if (!task) { const e = new Error('Task not found'); e.status = 404; throw e; }

  let emailContext = '';
  let canDraft = false;
  if (task.source_ref) {
    const m = (await query(
      `SELECT m.subject, m.from_name, m.from_email, m.body_text, m.snippet
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND m.message_id = $2 ORDER BY m.date DESC LIMIT 1`,
      [userId, task.source_ref]
    )).rows[0];
    if (m) {
      canDraft = true;
      emailContext = `\n\nIT CAME FROM THIS EMAIL — from ${clip(m.from_name || m.from_email, 80)}, subject "${clip(m.subject, 140)}":\n${clip(m.body_text || m.snippet, 2000)}`;
    }
  }

  const system =
    'You help a busy agency owner get a task done. Given the task (and the email it came from, if any), give ' +
    'brief, concrete guidance: 2–4 short bullets on how to tackle it — the actual steps, what to decide, what to say. ' +
    'If it is essentially a reply, say so and note that a drafted reply can be opened from the email. ' +
    'No preamble. Be specific to this task, not generic advice.';
  const user = `TASK: ${clip(task.text, 500)}${emailContext}\n\nHow should I tackle this?`;

  const suggestion = (await aiComplete(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])).trim();

  return { suggestion, canDraft, sourceRef: task.source_ref || null };
}
