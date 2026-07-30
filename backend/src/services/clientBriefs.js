import { query } from './db.js';
import { aiComplete, loadLegendText, parseLegend } from './taskGenerator.js';

// Client knowledge layer. A living one-page brief per client, maintained by the AI
// from recent mail and hand-editable. Fed back into task generation and reply
// drafting as background context. Keyed by the client name in the shared legend.

const BRIEF_MAX = 6000;              // stored brief cap
const CONTEXT_TOTAL_MAX = 4500;      // total brief text injected into a prompt
const CONTEXT_PER_CLIENT_MAX = 900;  // per-client slice within that budget
const MAIL_LOOKBACK_DAYS = 365;
const MAIL_MAX = 40;

export async function loadClientBriefs(userId) {
  const r = await query('SELECT client, brief, auto, updated_at, refreshed_at FROM client_briefs WHERE user_id = $1 ORDER BY client', [userId]);
  return r.rows;
}

export async function getBrief(userId, client) {
  const r = await query('SELECT client, brief, auto, updated_at, refreshed_at FROM client_briefs WHERE user_id = $1 AND client = $2', [userId, client]);
  return r.rows[0] || null;
}

// Insert or patch a brief. A null brief/auto leaves that column unchanged on
// conflict (defaults on insert); `refreshed` stamps refreshed_at when true.
export async function upsertBrief(userId, client, { brief, auto, refreshed }) {
  const r = await query(
    `INSERT INTO client_briefs (user_id, client, brief, auto, refreshed_at, updated_at)
       VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, true),
               CASE WHEN $5 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (user_id, client) DO UPDATE SET
       brief        = COALESCE($3, client_briefs.brief),
       auto         = COALESCE($4, client_briefs.auto),
       refreshed_at = CASE WHEN $5 THEN NOW() ELSE client_briefs.refreshed_at END,
       updated_at   = NOW()
     RETURNING client, brief, auto, updated_at, refreshed_at`,
    [userId, client,
     brief === undefined ? null : String(brief).slice(0, BRIEF_MAX),
     auto === undefined ? null : !!auto,
     !!refreshed]
  );
  return r.rows[0];
}

// Compact background block for task/draft prompts: each brief trimmed and the whole
// thing capped so it can't dominate the prompt. Not an instruction to create tasks —
// purely context to interpret asks correctly.
export function briefContextBlock(briefs) {
  if (!briefs || !briefs.length) return '';
  let budget = CONTEXT_TOTAL_MAX;
  const parts = [];
  for (const b of briefs) {
    const text = (b.brief || '').trim();
    if (!text) continue;
    const slice = text.slice(0, CONTEXT_PER_CLIENT_MAX);
    if (slice.length > budget) break;
    budget -= slice.length;
    parts.push(`## ${b.client}\n${slice}`);
  }
  if (!parts.length) return '';
  return 'CLIENT CONTEXT — background on the clients, to help you understand who and what each email is about. ' +
    'Do NOT create tasks or claims from this section alone; it is reference only.\n\n' + parts.join('\n\n');
}

// Recent mail that mentions a client, matched by the legend terms (plus the client
// name itself) across the sender, subject, and stored body/snippet.
async function gatherClientMail(userId, clientName, terms) {
  const accts = await query('SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true', [userId]);
  if (!accts.rows.length) return [];
  const accountIds = accts.rows.map(r => r.id);

  const needles = [...new Set([clientName.toLowerCase(), ...terms])].filter(t => t && t.length >= 2).slice(0, 12);
  if (!needles.length) return [];

  // Build an OR of ILIKE conditions over the searchable columns for each needle.
  const cols = ['from_email', 'from_name', 'subject', "COALESCE(body_text, snippet)"];
  const conds = [];
  const params = [accountIds];
  let p = 2;
  for (const n of needles) {
    params.push(`%${n}%`);
    const like = `$${p++}`;
    conds.push('(' + cols.map(c => `${c} ILIKE ${like}`).join(' OR ') + ')');
  }
  const sql =
    `SELECT DISTINCT ON (message_id) message_id, subject, from_name, from_email, snippet, body_text, date
       FROM messages
      WHERE account_id = ANY($1)
        AND date > NOW() - INTERVAL '${MAIL_LOOKBACK_DAYS} days'
        AND (${conds.join(' OR ')})
      ORDER BY message_id, date DESC`;
  const rows = (await query(sql, params)).rows;
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  return rows.slice(0, MAIL_MAX);
}

// (Re)generate a client's brief from recent mail, folding in the existing brief so it
// evolves rather than resets. Persists and returns the row. Never overwrites a brief
// the user has hand-edited (auto=false) unless force is set.
export async function generateClientBrief(userId, clientName, cfg, { force = false } = {}) {
  const legend = parseLegend(await loadLegendText());
  const entry = legend.find(e => e.client.toLowerCase() === clientName.toLowerCase());
  const terms = entry?.terms || [];

  const existing = await getBrief(userId, clientName);
  if (existing && existing.auto === false && !force) {
    const e = new Error('This brief was hand-edited; regenerate is disabled unless forced.');
    e.code = 'HAND_EDITED'; throw e;
  }

  const mail = await gatherClientMail(userId, clientName, terms);
  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = mail.map((m, i) => {
    const when = m.date ? new Date(m.date).toISOString().slice(0, 10) : '';
    const from = clip(m.from_name || m.from_email || 'unknown', 80);
    const body = clip(m.body_text || m.snippet, 700);
    return `[${i + 1}] ${when} — ${from} — ${clip(m.subject, 140) || '(no subject)'}\n${body}`;
  }).join('\n\n');

  const system =
    'You maintain a concise, factual one-page brief on a client for a busy agency owner. ' +
    'Given the current brief (may be empty) and recent emails involving the client, produce an UPDATED brief. ' +
    'Fold new information into what is already there; correct anything now outdated; keep it tight. ' +
    'Use short markdown sections with these headings when there is content for them: ' +
    '**Who** (company + what they do, in a line), **Key people** (names + roles + emails), ' +
    '**Current projects** (each with a one-line status), **Open threads / awaiting** (what is outstanding, and on whom), ' +
    '**Preferences & notes** (how they like to work, tone, quirks), **Key dates**. ' +
    'Only state what the emails or the existing brief support — never invent. Omit a heading entirely if empty. ' +
    'No preamble, no sign-off — just the brief in markdown.';
  const user =
    `CLIENT: ${clientName}\n\n` +
    `CURRENT BRIEF (may be empty):\n${existing?.brief?.trim() || '(none yet)'}\n\n` +
    `RECENT EMAILS (newest first):\n${lines || '(no matching mail found)'}\n\n` +
    'Return the updated brief as markdown.';

  const content = (await aiComplete(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])).trim();

  const saved = await upsertBrief(userId, clientName, { brief: content, auto: true, refreshed: true });
  return { ...saved, mailScanned: mail.length };
}
